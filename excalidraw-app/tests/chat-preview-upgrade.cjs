/* Retain a real worker/cache and draft across a 3009-only image replacement. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const puppeteer = require("puppeteer-core");
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
(async () => {
  const notes = process.env.TEST_NOTES_DIR;
  assert.ok(notes?.startsWith("/tmp/excalidraw-chat-recovery."));
  const image = "excalidraw-preview-preview:reliability-baseline";
  docker("image", "inspect", image);
  docker("stop", "excalidraw-preview-preview-1");
  let browser;
  try {
    docker(
      "run",
      "-d",
      "--name",
      "excalidraw-preview-upgrade-check",
      "--init",
      "--user",
      "1000:1000",
      "-p",
      "127.0.0.1:3009:3001",
      "-e",
      "REPOSITORY_NOTES_DIR=/opt/node_app/notes",
      "-e",
      "QWEN_BASE_URL=http://10.252.221.218:18006/v1",
      "-e",
      "QWEN_MODEL=qwen3.8-27b",
      "-v",
      `${notes}:/opt/node_app/notes`,
      image,
    );
    browser = await puppeteer.launch({
      executablePath:
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    let modelRequests = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/turns")) {
        modelRequests++;
      }
    });
    await page.evaluateOnNewDocument(() => {
      if (window === window.top) {
        localStorage.setItem(
          "aldebaran.repository-note-name",
          "note-2026-10-21-200223-598.excalidraw",
        );
      }
    });
    await page.goto("http://127.0.0.1:3009", {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForFunction(
      async () => {
        const r = await navigator.serviceWorker.getRegistration();
        return r?.active;
      },
      { polling: 200, timeout: 60000 },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => Boolean(navigator.serviceWorker.controller),
      { polling: 100 },
    );
    await page.waitForSelector('[aria-label="打开笔记聊天"]', {
      timeout: 120000,
    });
    await page.click('[aria-label="打开笔记聊天"]');
    await page.waitForSelector('textarea[aria-label="聊天消息"]');
    await page.type('textarea[aria-label="聊天消息"]', "升级后仍要保留的草稿");
    const oldEntry = await page.$eval(
      'script[type="module"][src]',
      (n) => n.src,
    );
    // Replace only the preview process; the retained tab/worker/cache stay alive.
    docker("stop", "excalidraw-preview-upgrade-check");
    docker("start", "excalidraw-preview-preview-1");
    await page.evaluate(async () => {
      window.dispatchEvent(new Event("focus"));
      const registration = await navigator.serviceWorker.getRegistration();
      await registration.update();
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector(".note-chat-messages")
          ?.textContent.includes("新版已就绪"),
      { polling: 100, timeout: 30000 },
    );
    assert.equal(
      await page.$eval('script[type="module"][src]', (n) => n.src),
      oldEntry,
      "an update must not force reload",
    );
    await page.waitForFunction(
      async () =>
        Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
      { polling: 200, timeout: 60000 },
    );
    await page.evaluate(() =>
      Array.from(document.querySelectorAll("button"))
        .find((n) => n.textContent === "刷新界面")
        .click(),
    );
    await page.waitForFunction(
      (oldEntry) =>
        document.querySelector('script[type="module"][src]')?.src !== oldEntry,
      { polling: 100, timeout: 60000 },
      oldEntry,
    );
    await page.waitForSelector('textarea[aria-label="聊天消息"]', {
      timeout: 60000,
    });
    assert.equal(
      await page.$eval('textarea[aria-label="聊天消息"]', (n) => n.value),
      "升级后仍要保留的草稿",
    );
    await page.waitForFunction(
      () => document.querySelectorAll(".note-chat-html-card").length === 3,
      { polling: 100 },
    );
    assert.equal(modelRequests, 0);
    await page.screenshot({
      path: "/tmp/chat-preview-worker-upgrade.png",
      captureBeyondViewport: false,
    });
    console.log(
      JSON.stringify({
        test: "retained-worker-upgrade",
        oldEntry,
        newEntry: await page.$eval('script[type="module"][src]', (n) => n.src),
        draftPreserved: true,
        modelRequests,
      }),
    );
  } finally {
    if (browser) {
      const force = setTimeout(() => browser.process()?.kill(), 5000);
      await browser.close();
      clearTimeout(force);
    }
    try {
      docker("stop", "excalidraw-preview-upgrade-check");
      docker("rm", "excalidraw-preview-upgrade-check");
    } catch {}
    docker("start", "excalidraw-preview-preview-1");
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

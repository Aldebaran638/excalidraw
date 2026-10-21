/* Read-only replay of copied user records. No generation request is sent. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
(async () => {
  assert.ok(
    process.env.TEST_NOTES_DIR?.startsWith("/tmp/excalidraw-chat-recovery."),
  );
  const legacy = process.env.LEGACY_STATIC_DIR;
  const filename = "note-2026-10-21-200223-598.excalidraw";
  const browser = await puppeteer.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument((filename) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", filename);
      }
    }, filename);
    if (legacy) {
      await page.setRequestInterception(true);
      page.on("request", async (request) => {
        const url = new URL(request.url());
        if (
          url.origin !== "http://127.0.0.1:3009" ||
          url.pathname.startsWith("/api/")
        ) {
          await request.continue();
          return;
        }
        const relative = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = path.resolve(legacy, `.${relative}`);
        if (!file.startsWith(path.resolve(legacy) + path.sep)) {
          await request.abort();
          return;
        }
        try {
          const body = await fs.readFile(file);
          await request.respond({
            status: 200,
            contentType: file.endsWith(".html")
              ? "text/html"
              : file.endsWith(".js")
              ? "text/javascript"
              : file.endsWith(".css")
              ? "text/css"
              : "application/octet-stream",
            body,
          });
        } catch {
          await request.continue();
        }
      });
    }
    await page.goto("http://127.0.0.1:3009", {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForSelector('[aria-label="打开笔记聊天"]', {
      timeout: 120000,
    });
    await page.click('[aria-label="打开笔记聊天"]');
    await page.waitForFunction(
      () =>
        document
          .querySelector(".note-chat-messages")
          ?.textContent.includes("简易计算器"),
      { polling: 100, timeout: 60000 },
    );
    const count = await page.$$eval(
      ".note-chat-html-card",
      (nodes) => nodes.length,
    );
    const entry = await page.$eval(
      'script[type="module"][src]',
      (node) => node.src,
    );
    if (legacy) {
      assert.equal(count, 0);
      assert.ok(
        await page.$eval(".note-chat-messages", (node) =>
          node.textContent.includes("更新并刷新"),
        ),
      );
      const status = await page.evaluate(async () => {
        const r = await fetch(
          "/api/notes/sBBozjQOk6m74jfHjduzT/chats/41f3456a-f54c-4493-b6c0-ca1e2ac30dbb/turns",
          { method: "POST", body: "{}" },
        );
        return { status: r.status, message: (await r.json()).error };
      });
      assert.equal(status.status, 426);
      assert.match(status.message, /尚未调用模型/);
    } else {
      assert.ok(count >= 3);
      await page.waitForSelector(".note-chat-html-frame");
      for (const iframe of await page.$$(".note-chat-html-frame")) {
        const frame = await iframe.contentFrame();
        await frame.waitForFunction(() => Boolean(document.querySelector("button")), { timeout: 20000, polling: 100 });
      }
      assert.equal(await page.$(".note-chat-html-card [role=alert]"), null);
    }
    await page.screenshot({
      path: legacy
        ? "/tmp/chat-recovery-legacy.png"
        : "/tmp/chat-recovery-current.png",
      captureBeyondViewport: false,
    });
    console.log(
      JSON.stringify({
        legacy: Boolean(legacy),
        cards: count,
        entry,
        modelRequests: 0,
      }),
    );
  } finally {
    const forceClose = setTimeout(() => browser.process()?.kill(), 5000);
    await browser.close();
    clearTimeout(forceClose);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

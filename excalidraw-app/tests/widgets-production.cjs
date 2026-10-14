/* Test the built UI and same-origin API without development-only globals. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");

const puppeteer = require("puppeteer-core");
const base = process.env.APP_URL || "http://127.0.0.1:3102";
const filename = `__production-widget-${Date.now()}.excalidraw`;
let browser;
const click = async (page, label, scope) => {
  const handle = await page.evaluateHandle(
    (text, parent) =>
      [...document.querySelector(parent).querySelectorAll("button")].find(
        (node) => node.textContent.trim() === text,
      ),
    label,
    scope,
  );
  assert.ok(handle.asElement(), `Missing button: ${label}`);
  await handle.asElement().click();
};
(async () => {
  assert.ok(process.env.BROWSER_EXECUTABLE, "Set BROWSER_EXECUTABLE");
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.healthy, true);
  const noteUrl = `${base}/api/notes/${filename}`;
  const created = await fetch(noteUrl, {
    method: "PUT",
    headers: {
      "If-None-Match": "*",
      "X-Repository-Client-Id": "production-test",
    },
    body: JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      files: {},
      appState: {},
    }),
  });
  assert.equal(created.status, 200);
  const head = await fetch(noteUrl, { method: "HEAD" });
  assert.ok(head.headers.get("etag"));
  browser = await puppeteer.launch({
    executablePath: process.env.BROWSER_EXECUTABLE,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(
    (name) => localStorage.setItem("aldebaran.repository-note-name", name),
    filename,
  );
  await page.goto(base, { waitUntil: "networkidle2", timeout: 120000 });
  await page.waitForSelector(".App-toolbar__extra-tools-trigger");
  await page.click(".App-toolbar__extra-tools-trigger");
  await click(page, "AI 组件", "body");
  await page.mouse.move(250, 200);
  await page.mouse.down();
  await page.mouse.move(890, 760, { steps: 10 });
  await page.mouse.up();
  await page.waitForSelector(".ai-widget-panel");
  await page.click(".ai-widget-panel summary");
  await click(page, "Kubernetes 架构全景", ".ai-widget-panel");
  await page.waitForSelector(".ai-widget-preview .iw-pressable");
  await click(page, "放入笔记", ".ai-widget-panel");
  await page.waitForSelector(".ai-widget-actions");
  await click(page, "进入交互", ".ai-widget-actions");
  await page.waitForSelector(".excalidraw__embeddable-container .iw-pressable");
  await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        ".excalidraw__embeddable-container .iw-pressable",
      ),
    ]
      .find((node) => node.textContent.includes("etcd"))
      .click(),
  );
  let saved = false;
  for (let i = 0; i < 50; i++) {
    const scene = await (await fetch(noteUrl)).json();
    if (
      scene.elements.some(
        (el) => el.customData?.aiWidget?.state.selected === "etcd",
      )
    ) {
      saved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(saved, "Built Worker/UI state must reach local JSON");
  await page.reload({ waitUntil: "networkidle2", timeout: 120000 });
  await page.waitForFunction(() =>
    document
      .querySelector(".excalidraw__embeddable-container")
      ?.textContent.includes("Raft"),
  );
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await page.mouse.click(280, 300);
  await page.waitForSelector(".ai-widget-actions");
  await click(page, "放大操作", ".ai-widget-actions");
  await page.waitForSelector(".ai-widget-modal .iw-pressable");
  const width = await page.$eval(
    ".ai-widget-modal .iw-view",
    (node) => node.clientWidth,
  );
  assert.ok(
    width > 200 && width < 390,
    "Mobile enlarged view must reflow to the screen",
  );
  await click(page, "关闭", ".ai-widget-modal");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: production HTTP/static UI, compiled Worker, interactive cards, local persistence and refresh recovery",
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) {
      await browser.close();
    }
  });

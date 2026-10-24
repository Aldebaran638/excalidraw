/* Isolated mock-upstream acceptance: a real DOM node must precede completion. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const puppeteer = require("puppeteer-core");
const base = process.env.APP_URL || "http://127.0.0.1:3009";
const noteId = randomUUID();
const filename = `__stream-widget-${noteId}.excalidraw`;
let browser;
let created = false;
const json = async (path, init) => {
  const response = await fetch(`${base}${path}`, init);
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
};
(async () => {
  assert.ok(process.env.TEST_NOTES_DIR?.startsWith("/tmp/excalidraw-chat-"));
  const status = await json("/api/ai/status");
  assert.equal(status.model, "fixture-widgets");
  await json(`/api/notes/${filename}`, {
    method: "PUT",
    body: JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: {},
      repositoryMetadata: { version: 1, noteId },
    }),
  });
  created = true;
  const session = await json(`/api/notes/${noteId}/chats`, { method: "POST" });
  const sessionURL = `/api/notes/${noteId}/chats/${session.id}`;
  browser = await puppeteer.launch({
    executablePath: process.env.BROWSER_EXECUTABLE,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(
    (name) => localStorage.setItem("aldebaran.repository-note-name", name),
    filename,
  );
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[aria-label="打开笔记聊天"]', {
    timeout: 120000,
  });
  await page.click('[aria-label="打开笔记聊天"]');
  await page.waitForSelector('textarea[aria-label="聊天消息"]', {
    timeout: 120000,
  });
  await page.type(
    'textarea[aria-label="聊天消息"]',
    "逐步生成计算器，完成后模拟文字失败",
  );
  const send = await page.evaluateHandle(() =>
    [...document.querySelectorAll(".note-chat button")].find(
      (node) => node.getAttribute("aria-label") === "发送消息",
    ),
  );
  assert.ok(send.asElement());
  await send.asElement().click();
  await page.waitForSelector(".note-chat-widget-build .iw-node", {
    timeout: 120000,
  });
  const during = await json(sessionURL);
  assert.equal(during.messages.at(-1).status, "generating");
  assert.equal(during.messages.at(-1).artifacts?.length || 0, 0);
  assert.equal((await json(`/api/notes/${filename}`)).elements.length, 0);
  assert.equal(
    await page.$eval(".note-chat-widget-build-view", (node) => node.inert),
    true,
  );
  assert.ok(
    await page.$eval(".note-chat-widget-build", (node) =>
      node.textContent.includes("聊天计算器"),
    ),
  );
  await page.screenshot({
    path: "/tmp/chat-widget-stream-building.png",
    captureBeyondViewport: false,
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector(".note-chat-inline-error")
        ?.textContent.includes("组件已保存，文字回复未完成"),
    { timeout: 120000 },
  );
  await page.waitForSelector(
    ".note-chat-widget:not(.note-chat-widget-build) .iw-node",
    { timeout: 120000 },
  );
  const finished = await json(sessionURL);
  assert.equal(finished.messages.at(-1).status, "failed");
  assert.equal(finished.messages.at(-1).artifacts.length, 1);
  assert.equal(await page.$(".note-chat-widget-build"), null);
  await page.screenshot({
    path: "/tmp/chat-widget-stream-ready.png",
    captureBeyondViewport: false,
  });
  await page.focus(".excalidraw");
  await page.keyboard.down("Shift");
  await page.keyboard.down("Alt");
  await page.keyboard.press("d");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Shift");
  await page.waitForSelector(".excalidraw.theme--dark");
  await page.screenshot({
    path: "/tmp/chat-widget-stream-dark.png",
    captureBeyondViewport: false,
  });
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await page.screenshot({
    path: "/tmp/chat-widget-stream-mobile.png",
    captureBeyondViewport: false,
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(
    ".note-chat-widget:not(.note-chat-widget-build) .iw-node",
    { timeout: 120000 },
  );
  assert.equal(await page.$(".note-chat-widget-build"), null);
  assert.deepEqual(errors, []);
  console.log(
    "PASS real DOM node before completion, inert preview, no scene writes, saved widget after prose failure, refresh and themed/mobile checks (mock model)",
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
    if (created) {
      await fetch(`${base}/api/notes/${filename}`, { method: "DELETE" });
    }
  });

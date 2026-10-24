/* Full production/SSE/iframe acceptance against the private deterministic fixture. */
/* eslint-disable no-console */
/* global NoteApp */
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const puppeteer = require("puppeteer-core");
const base = "http://127.0.0.1:3009";
const headers = {
  "X-Chat-Protocol": "3",
  "X-Chat-Capabilities": "html-blocks",
};
const json = async (url, init) => {
  const r = await fetch(base + url, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  const d = await r.json();
  assert.ok(r.ok, JSON.stringify(d));
  return d;
};
(async () => {
  assert.ok(
    process.env.TEST_NOTES_DIR?.startsWith("/tmp/excalidraw-chat-html-"),
  );
  assert.equal((await json("/api/ai/status")).model, "fixture-html");
  const noteId = randomUUID();
  const filename = `__live-${noteId}.excalidraw`;
  await json(`/api/notes/${filename}`, {
    method: "PUT",
    body: JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      files: {},
      appState: {},
      repositoryMetadata: { version: 1, noteId },
    }),
  });
  const session = await json(`/api/notes/${noteId}/chats`, { method: "POST" });
  const sessionURL = `/api/notes/${noteId}/chats/${session.id}`;
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
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('[aria-label="打开笔记聊天"]', {
      timeout: 120000,
    });
    await page.click('[aria-label="打开笔记聊天"]');
    await page.waitForSelector('textarea[aria-label="聊天消息"]');
    await page.type('textarea[aria-label="聊天消息"]', "生成专注工具");
    await page.click(".note-chat-send");
    await page.waitForSelector(".note-chat-html-frame", { timeout: 30000 });
    const iframe = await page.$(".note-chat-html-frame");
    const frame = await iframe.contentFrame();
    await frame.waitForSelector("#start");
    assert.equal((await json(sessionURL)).messages.at(-1).status, "generating");
    await frame.$eval("#task", (n) => {
      n.focus();
      n.value = "保持我的任务";
      n.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await frame.$eval("#start", (n) => n.click());
    const deadline = await frame.evaluate(() => NoteApp.get("deadline"));
    assert.ok(deadline > Date.now());
    await page.screenshot({
      path: "/tmp/html-v2-building.png",
      captureBeyondViewport: false,
    });
    await frame.waitForSelector("#detail", { timeout: 20000 });
    await frame.waitForFunction(() => document.readyState === "complete", {
      polling: 100,
    });
    assert.equal(
      await frame.$eval("#title", (n) => n.textContent),
      "小番茄 · Focus",
    );
    assert.equal(await frame.$eval("#task", (n) => n.value), "保持我的任务");
    assert.equal(await frame.evaluate(() => document.activeElement.id), "task");
    assert.equal(await frame.evaluate(() => NoteApp.get("deadline")), deadline);
    assert.equal(await frame.evaluate(() => window.initializations), 1);
    await page.waitForFunction(
      () =>
        document
          .querySelector(".note-chat-html-card")
          ?.textContent.includes("部分更新未应用"),
      { polling: 100 },
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector(".note-chat-html-card")
          ?.textContent.includes("源码已保存"),
      { polling: 100 },
    );
    const finished = await json(sessionURL);
    const block = finished.messages
      .at(-1)
      .blocks.find((b) => b.type === "html");
    assert.equal(block.runtimeVersion, 2);
    const artifact = await json(
      `${sessionURL}/html-artifacts/${block.ref.artifactId}?version=1`,
    );
    assert.equal(artifact.state.custom.deadline, deadline);
    assert.equal(artifact.state.forms.task.value, "保持我的任务");
    const controls = await page.$$(".note-chat-html-card footer button");
    await controls[0].click();
    assert.equal(await frame.evaluate(() => window.initializations), 1);
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: "/tmp/html-v2-ready.png",
      captureBeyondViewport: false,
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".note-chat-html-frame", { timeout: 60000 });
    const restored = await (
      await page.$(".note-chat-html-frame")
    ).contentFrame();
    await restored.waitForSelector("#detail");
    assert.equal(await restored.$eval("#task", (n) => n.value), "保持我的任务");
    assert.equal(
      await restored.evaluate(() => NoteApp.get("deadline")),
      deadline,
    );
    assert.equal((await json(`/api/notes/${filename}`)).elements.length, 0);
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
    });
    await page.screenshot({
      path: "/tmp/html-v2-mobile.png",
      captureBeyondViewport: false,
    });
    console.log(
      "PASS: real production pipeline shows interactive content before completion; late patches preserve input/focus/deadline; conflict visible; saved reload and same-instance enlargement",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

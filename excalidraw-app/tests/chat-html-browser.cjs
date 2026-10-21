/* eslint-disable no-console */
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const fs = require("node:fs/promises");
const path = require("node:path");

const puppeteer = require("puppeteer-core");
const base = "http://127.0.0.1:3009";
const noteId = randomUUID();
const filename = `__html-${noteId}.excalidraw`;
const json = async (path, init) => {
  const response = await fetch(base + path, init);
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
};
(async () => {
  assert.ok(
    process.env.TEST_NOTES_DIR?.startsWith("/tmp/excalidraw-chat-html-"),
    "isolated acceptance directory required",
  );
  assert.equal((await json("/api/ai/status")).model, "fixture-html");
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
  const session = await json(`/api/notes/${noteId}/chats`, { method: "POST" });
  const browser = await puppeteer.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
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
    await page.type('textarea[aria-label="聊天消息"]', "生成一个交互应用");
    await page.click(".note-chat-send");
    await page.waitForSelector(".note-chat-html-frame", { timeout: 60000 });
    const iframe = await page.$(".note-chat-html-frame");
    const frame = await iframe.contentFrame();
    await frame.waitForSelector("#a", { timeout: 30000 });
    assert.equal(
      (await json(`/api/notes/${noteId}/chats/${session.id}`)).messages.at(-1)
        .status,
      "generating",
    );
    await frame.$eval("#a", (node) => {
      node.value = "20";
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.screenshot({
      path: "/tmp/chat-html-building.png",
      captureBeyondViewport: false,
    });
    await frame.waitForFunction(() => window.executions === 1, {
      polling: 100,
      timeout: 30000,
    });
    await frame.waitForFunction(() => document.readyState === "complete", {
      polling: 100,
    });
    assert.equal(await frame.$eval("#a", (node) => node.value), "20");
    assert.equal(await frame.$eval("#sum", (node) => node.textContent), "24");
    // Old Puppeteer does not consistently offset opaque OOPIF input coordinates
    // on current Chromium. Use real mouse input at DOM-derived page coordinates.
    const click = async (selector) => {
      await frame.$eval(selector, (node) =>
        node.scrollIntoView({ block: "center" }),
      );
      const inner = await frame.$eval(selector, (node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      const outer = await iframe.boundingBox();
      await page.mouse.click(outer.x + inner.x, outer.y + inner.y);
    };
    await click("#add");
    await click("#service");
    await click("#transpose");
    await frame.waitForFunction(
      () => document.getElementById("todos").textContent === "事项数量：1",
      { polling: 100, timeout: 5000 },
    );
    assert.equal(
      await frame.$eval("#todos", (node) => node.textContent),
      "事项数量：1",
    );
    assert.equal(
      await frame.$eval("#matrix-result", (node) => node.textContent),
      "1,3;2,4",
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector(".note-chat-html-card")
          .textContent.includes("源码已保存"),
      { polling: 100 },
    );
    const controls = await page.$$(".note-chat-html-card footer button");
    await controls[0].click();
    assert.equal(await frame.evaluate(() => window.executions), 1); // Native dialog must not remount the iframe.
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !document.querySelector(".note-chat-html-dialog").matches(":modal"),
      { polling: 100 },
    );
    await page.screenshot({
      path: "/tmp/chat-html-ready.png",
      captureBeyondViewport: false,
    });
    await page.waitForTimeout(1000);
    const finished = await json(`/api/notes/${noteId}/chats/${session.id}`);
    const blocks = finished.messages.at(-1).blocks;
    assert.deepEqual(
      blocks.map((block) => block.type),
      ["reasoning", "text", "html", "reasoning", "text"],
    );
    const ref = blocks.find((block) => block.type === "html").ref;
    const artifact = await json(
      `/api/notes/${noteId}/chats/${session.id}/html-artifacts/${ref.artifactId}?version=1`,
    );
    assert.equal(artifact.state.custom.count, 1);
    assert.equal(artifact.state.forms.a.value, "20");
    assert.equal((await json(`/api/notes/${filename}`)).elements.length, 0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".note-chat-html-frame", { timeout: 60000 });
    const restored = await (
      await page.$(".note-chat-html-frame")
    ).contentFrame();
    await restored.waitForSelector("#todos");
    assert.equal(await restored.$eval("#a", (node) => node.value), "20");
    assert.equal(
      await restored.$eval("#todos", (node) => node.textContent),
      "事项数量：1",
    );
    await restored.waitForFunction(
      () => document.getElementById("sum").textContent === "24",
      { polling: 100 },
    );
    assert.equal(await page.$(".note-chat-html-card [role=alert]"), null);
    await page.focus(".excalidraw");
    await page.keyboard.down("Shift");
    await page.keyboard.down("Alt");
    await page.keyboard.press("d");
    await page.keyboard.up("Alt");
    await page.keyboard.up("Shift");
    await page.screenshot({
      path: "/tmp/chat-html-dark.png",
      captureBeyondViewport: false,
    });
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
    });
    await page.screenshot({
      path: "/tmp/chat-html-mobile.png",
      captureBeyondViewport: false,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: streaming visible before completion, direct interaction, state, dialog, ordered blocks, refresh, themes and no canvas writes",
    );
  } finally {
    await browser.close();
    await fs.unlink(path.join(process.env.TEST_NOTES_DIR, filename));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

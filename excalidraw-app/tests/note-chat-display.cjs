/* Deterministic display acceptance: no model call, isolated notes only. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const puppeteer = require("puppeteer-core");
const base = process.env.APP_URL || "http://127.0.0.1:3009";
const directory = process.env.TEST_NOTES_DIR;
const noteId = randomUUID();
const filename = `__chat-display-${noteId}.excalidraw`;
let browser;
const table =
  "| 工具 | 功能 |\n|:------|------:|\n| `get_note_outline` | 分页读取画布的大纲、标签和分组 ID |\n| `search_note` | 在笔记文本、矩阵数值和 AI 组件定义中搜索关键词 |\n| `read_note_elements` | 根据元素 ID 读取具体元素的详细信息 |";
(async () => {
  assert.ok(
    directory && path.resolve(directory).startsWith("/tmp/excalidraw-chat-"),
    "Use a disposable, isolated /tmp/excalidraw-chat-* directory",
  );
  assert.ok(process.env.BROWSER_EXECUTABLE);
  const saved = await fetch(`${base}/api/notes/${filename}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [],
      appState: {},
      files: {},
      repositoryMetadata: { version: 1, noteId },
    }),
  });
  assert.equal(saved.status, 200);
  const session = await (
    await fetch(`${base}/api/notes/${noteId}/chats`, { method: "POST" })
  ).json();
  const turnId = randomUUID();
  session.messages = [
    {
      id: randomUUID(),
      turnId,
      role: "user",
      content: "查看工具说明",
      createdAt: Date.now(),
      status: "complete",
    },
    {
      id: randomUUID(),
      turnId,
      role: "assistant",
      content: `是的，系统给我配置了 **3 个只读工具**：\n\n${table}\n\n只读，不会修改画布。`,
      thinking: true,
      reasoning: "这是一条用于界面验收的模拟思考内容，不是模型的真实输出。",
      createdAt: Date.now(),
      status: "complete",
    },
  ];
  await fs.writeFile(
    path.join(directory, ".chats", noteId, `${session.id}.json`),
    JSON.stringify(session),
  );
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
  await page.waitForSelector(".note-chat-table td", { timeout: 120000 });
  assert.equal(
    await page.$$eval(".note-chat-table tbody tr", (nodes) => nodes.length),
    3,
  );
  assert.equal(
    await page.$eval(".note-chat-table code", (node) => node.textContent),
    "get_note_outline",
  );
  assert.equal(
    await page.$eval(
      ".note-chat-table code",
      (node) =>
        node.ownerDocument.defaultView.getComputedStyle(node).whiteSpace,
    ),
    "nowrap",
  );
  assert.equal(
    await page.$eval(".note-chat-reasoning", (node) => node.open),
    false,
  );
  await page.click(".note-chat-thinking");
  assert.equal(
    await page.$eval(".note-chat-thinking", (node) =>
      node.getAttribute("aria-pressed"),
    ),
    "true",
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('.note-chat-thinking[aria-pressed="true"]', {
    timeout: 120000,
  });
  await page.screenshot({ path: "/tmp/note-chat-table-light.png" });
  await page.click(".note-chat-reasoning summary");
  assert.equal(
    await page.$eval(".note-chat-reasoning", (node) => node.open),
    true,
  );
  await page.focus(".excalidraw");
  await page.keyboard.down("Shift");
  await page.keyboard.down("Alt");
  await page.keyboard.press("d");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Shift");
  await page.waitForSelector(".excalidraw.theme--dark");
  await page.screenshot({ path: "/tmp/note-chat-table-dark.png" });
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const bounds = await page.$eval(".note-chat", (node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, bottom: r.bottom };
  });
  assert.ok(
    bounds.left >= 0 && bounds.right <= 390 && bounds.bottom <= 844,
    JSON.stringify(bounds),
  );
  const touch = await page.$eval(
    ".note-chat-thinking",
    (node) => node.getBoundingClientRect().height,
  );
  assert.ok(touch >= 44, `Thinking button touch target: ${touch}`);
  const overflow = await page.$eval(
    ".note-chat-messages",
    (node) => node.scrollWidth - node.clientWidth,
  );
  assert.ok(
    overflow <= 1,
    `Table must not cause horizontal sidebar overflow: ${overflow}`,
  );
  await page.screenshot({ path: "/tmp/note-chat-table-mobile.png" });
  await page.click(".note-chat-thinking");
  assert.equal(
    await page.$eval(".note-chat-thinking", (node) =>
      node.getAttribute("aria-pressed"),
    ),
    "false",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS safe Markdown tables, collapsible reasoning, thinking toggle and refresh persistence, light/dark/mobile layout and 44px touch target (fixture; no model calls)",
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
    if (
      directory &&
      path.resolve(directory).startsWith("/tmp/excalidraw-chat-")
    ) {
      await fs.unlink(path.join(directory, filename)).catch(() => {});
    }
  });

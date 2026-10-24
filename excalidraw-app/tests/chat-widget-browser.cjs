/* Full deterministic browser acceptance. Requires the explicit mock upstream. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const puppeteer = require("puppeteer-core");
const base = process.env.APP_URL || "http://127.0.0.1:3009";
const directory = process.env.TEST_NOTES_DIR;
const filename = `__chat-widget-browser-${Date.now()}.excalidraw`;
const noteId = randomUUID();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
const get = async (url) => (await fetch(`${base}${url}`)).json();
const until = async (test, label) => {
  for (let i = 0; i < 150; i++) {
    const value = await test();
    if (value) {
      return value;
    }
    await sleep(200);
  }
  throw new Error(`Timed out: ${label}`);
};
const button = async (page, label, root = ".note-chat") => {
  label = label === "发送 ↑" ? "发送消息" : label;
  const handle = await page.evaluateHandle(
    (label, root) =>
      [...document.querySelectorAll(`${root} button`)].find(
        (node) =>
          node.textContent.trim() === label ||
          node.getAttribute("aria-label") === label,
      ),
    label,
    root,
  );
  const element = handle.asElement();
  assert.ok(element, `Missing button ${label}`);
  await element.evaluate((node) => node.scrollIntoView({ block: "nearest" }));
  await element.click();
};
const note = () => get(`/api/notes/${filename}`);
(async () => {
  assert.ok(
    directory && path.resolve(directory).startsWith("/tmp/excalidraw-chat-"),
  );
  assert.ok(process.env.BROWSER_EXECUTABLE);
  assert.equal(
    (
      await fetch(`${base}/api/notes/${filename}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "excalidraw",
          version: 2,
          source: "fixture",
          elements: [],
          appState: {},
          files: {},
          repositoryMetadata: { version: 1, noteId },
        }),
      })
    ).status,
    200,
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
  await page.waitForSelector(".note-chat-empty");
  await button(page, "开启第一个会话");
  await page.waitForSelector('textarea[aria-label="聊天消息"]');
  const sessionId = await page.$eval(
    '[aria-label="聊天会话"]',
    (node) => node.value,
  );
  const sessionURL = `/api/notes/${noteId}/chats/${sessionId}`;
  const send = async (text) => {
    await page.type('textarea[aria-label="聊天消息"]', text);
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/turns"),
    );
    await button(page, "发送 ↑");
    await response;
    const session = await until(async () => {
      const s = await get(sessionURL);
      return s.messages.at(-1)?.status !== "generating" &&
        s.messages.at(-1)?.role === "assistant"
        ? s
        : null;
    }, "completed turn");
    assert.equal(
      session.messages.at(-1).status,
      "complete",
      JSON.stringify(session.messages.at(-1)),
    );
    return session.messages.at(-1);
  };
  let answer = await send("生成一个计算器组件");
  let reference = answer.artifacts[0];
  const artifact = () =>
    get(
      `${sessionURL}/artifacts/${reference.artifactId}?version=${reference.version}`,
    );
  await page.waitForSelector(
    '.note-chat-widget .iw-view input[aria-label="A"]',
  );
  assert.equal((await note()).elements.length, 0);
  const input = await page.$(
    '.note-chat-widget .iw-view input[aria-label="A"]',
  );
  await input.click({ clickCount: 3 });
  await input.type("42");
  await page.focus('textarea[aria-label="聊天消息"]');
  await until(
    async () => (await artifact()).document.state.a === 42,
    "saved trial input",
  );
  await button(page, "放大试用");
  await page.waitForSelector(
    '.note-chat-widget-expanded input[aria-label="A"]',
  );
  assert.equal(
    await page.$eval(
      '.note-chat-widget-expanded input[aria-label="A"]',
      (node) => node.value,
    ),
    "42",
  );
  const expandedInput = await page.$(
    '.note-chat-widget-expanded input[aria-label="A"]',
  );
  await expandedInput.click({ clickCount: 3 });
  await expandedInput.type("71");
  await button(page, "返回聊天", ".note-chat-widget-expanded");
  await page.waitForSelector(
    '.note-chat-widget .iw-view input[aria-label="A"]',
  );
  assert.equal(
    await page.$eval(
      '.note-chat-widget .iw-view input[aria-label="A"]',
      (node) => node.value,
    ),
    "71",
  );
  await until(
    async () => (await artifact()).document.state.a === 71,
    "shared enlarged state persisted",
  );
  console.log(
    "PASS chat-only generation, shared inline/dialog state and trial persistence without a canvas element",
  );
  await button(page, "继续修改");
  answer = await send("把标题改成修改后计算器");
  assert.equal(answer.artifacts[0].artifactId, reference.artifactId);
  reference = answer.artifacts[0];
  assert.equal(reference.version, 2);
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.note-chat-widget .iw-view input[aria-label="A"]',
      ).length === 1,
  );
  await page.select('.note-chat-widget select[aria-label="组件版本"]', "1");
  await page.waitForFunction(() =>
    document.querySelector(".note-chat-workspace")?.textContent.includes("v1"),
  );
  answer = await send("再调整当前选中版本的标题");
  reference = answer.artifacts[0];
  assert.equal(reference.version, 3);
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.note-chat-widget .iw-view input[aria-label="A"]',
      ).length === 1,
  );
  assert.equal((await artifact()).parentVersion, 1);
  await button(page, "导入笔记");
  await page.focus(".excalidraw");
  await page.keyboard.press("Escape");
  assert.equal((await note()).elements.length, 0);
  await button(page, "导入笔记");
  await page.mouse.move(200, 250);
  await page.mouse.down();
  await page.mouse.move(850, 680, { steps: 12 });
  await page.mouse.up();
  const imported = await until(
    async () =>
      (await note()).elements.find((item) => item.customData?.aiWidget),
    "imported widget saved",
  );
  assert.equal(imported.customData.aiWidget.state.a, 71);
  assert.equal(
    imported.customData.aiWidgetChatSource.artifactId,
    reference.artifactId,
  );
  await page.waitForFunction(() =>
    document
      .querySelector(".note-chat-workspace")
      ?.textContent.includes("画布组件"),
  );
  const importedId = imported.id;
  console.log(
    "PASS candidate branching, Escape cancellation, native region import and automatic canvas target",
  );
  answer = await send("修改这个组件的标题");
  const canvasRef = answer.artifacts[0];
  assert.equal(canvasRef.targetElementId, importedId);
  await page.waitForSelector(".note-chat-widget-apply");
  const before = (await note()).elements.find((item) => item.id === importedId);
  await button(page, "原版");
  await button(page, "候选");
  await button(page, "确认应用修改");
  await until(
    async () =>
      (await note()).elements.find((item) => item.id === importedId)?.customData
        .aiWidgetChatSource.artifactId === canvasRef.artifactId,
    "confirmed native update",
  );
  const current = (await note()).elements.find(
    (item) => item.id === importedId,
  );
  assert.deepEqual(
    [current.x, current.y, current.width, current.height],
    [before.x, before.y, before.width, before.height],
  );
  assert.equal(current.customData.aiWidget.state.a, 71);
  await page.focus(".excalidraw");
  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await until(
    async () =>
      (await note()).elements.find((item) => item.id === importedId)?.customData
        .aiWidgetChatSource.artifactId === reference.artifactId,
    "undo applied definition",
  );
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await until(
    async () =>
      (await note()).elements.find((item) => item.id === importedId)?.customData
        .aiWidgetChatSource.artifactId === canvasRef.artifactId,
    "redo applied definition",
  );
  await button(page, "再导入一份");
  await page.mouse.move(300, 350);
  await page.mouse.down();
  await page.mouse.move(900, 780, { steps: 10 });
  await page.mouse.up();
  const copies = await until(async () => {
    const values = (await note()).elements.filter(
      (item) => item.customData?.aiWidget && !item.isDeleted,
    );
    return values.length === 2 ? values : null;
  }, "independent second import");
  assert.notEqual(copies[0].id, copies[1].id);
  console.log(
    "PASS confirmed exact-instance editing, geometry/input preservation, undo/redo and independent repeated import",
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(".note-chat-widget .iw-view", { timeout: 120000 });
  await page.screenshot({ path: "/tmp/chat-widget-desktop.png" });
  await page.focus(".excalidraw");
  await page.keyboard.down("Shift");
  await page.keyboard.down("Alt");
  await page.keyboard.press("d");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Shift");
  await page.waitForSelector(".excalidraw.theme--dark");
  await page.screenshot({ path: "/tmp/chat-widget-dark.png" });
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await sleep(500);
  const bounds = await page.$eval(".note-chat", (node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, right: r.right, bottom: r.bottom };
  });
  assert.ok(
    bounds.x >= 0 && bounds.right <= 390 && bounds.bottom <= 844,
    JSON.stringify(bounds),
  );
  await page.screenshot({ path: "/tmp/chat-widget-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS refreshed versions, responsive mobile bounds, light/dark screenshots and no browser errors (explicit fixture)",
  );
})()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    if (browser) {
      const page = (await browser.pages()).at(-1);
      await page
        .screenshot({ path: "/tmp/chat-widget-failed.png" })
        .catch(() => {});
      console.error(
        await page.$eval("body", (node) => node.innerText).catch(() => ""),
      );
    }
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

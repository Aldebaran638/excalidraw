/* Fixed-port UI acceptance. Only the uniquely named fixture is created/removed. */
/* eslint-disable no-console */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const puppeteer = require("puppeteer-core");
const base = "http://127.0.0.1:3009";
const directory = path.resolve(__dirname, "../../.local-data/preview/notes");
const json = async (url, init) => {
  const response = await fetch(base + url, init);
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
};
(async () => {
  const noteId = randomUUID();
  const filename = `__editing-reliability-${noteId}.excalidraw`;
  const note = {
    type: "excalidraw",
    version: 2,
    elements: [],
    files: {},
    appState: {},
    repositoryMetadata: { version: 1, noteId },
  };
  await json(`/api/notes/${filename}`, {
    method: "PUT",
    body: JSON.stringify(note),
  });
  const chatRoot = path.join(directory, ".chats", noteId);
  let browser;
  try {
    const session = await json(`/api/notes/${noteId}/chats`, {
      method: "POST",
    });
    const appId = randomUUID();
    const failedId = randomUUID();
    const candidateId = randomUUID();
    const ref = { kind: "html", artifactId: appId, version: 1 };
    const error =
      "JavaScript 语法错误：脚本 1，HTML 第 3 行第 9 列；Unexpected token";
    for (const [id, complete] of [
      [appId, true],
      [failedId, false],
    ]) {
      const root = path.join(chatRoot, "artifacts", session.id, id);
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
        path.join(root, "html-v1.json"),
        JSON.stringify({
          kind: "html",
          artifactId: id,
          version: 1,
          noteId,
          sessionId: session.id,
          title: complete ? "原计数器" : "失败草稿",
          source: complete
            ? '<h1>原计数器</h1><button id="add">增加</button><output id="n">0</output><script>document.getElementById("add").onclick=()=>document.getElementById("n").textContent=Number(document.getElementById("n").textContent)+1</script>'
            : "<h1>失败草稿</h1><script>let n=;</script>",
          complete,
          runtimeVersion: 2,
          revision: 0,
          state: { forms: {}, custom: {} },
          createdAt: Date.now(),
          ...(!complete
            ? { recovery: { base: ref, error, code: "syntax" } }
            : {}),
        }),
      );
    }
    session.messages = [
      {
        id: randomUUID(),
        turnId: randomUUID(),
        role: "assistant",
        status: "failed",
        content: "",
        error,
        createdAt: Date.now(),
        blocks: [
          {
            id: randomUUID(),
            type: "html",
            ref,
            complete: true,
            saved: true,
            runtimeVersion: 2,
          },
          {
            id: randomUUID(),
            type: "text",
            text: `[HTML作品引用 ${randomUUID()} v1]`,
          },
          {
            id: randomUUID(),
            type: "html",
            ref: { kind: "html", artifactId: failedId, version: 1 },
            complete: false,
            draftSaved: true,
            error,
            runtimeVersion: 2,
          },
        ],
      },
    ];
    await fs.writeFile(
      path.join(chatRoot, `${session.id}.json`),
      JSON.stringify(session),
    );
    // Legacy baseline remains readable when the new candidate uses shared storage.
    const originalFile = path.join(
      chatRoot,
      "artifacts",
      session.id,
      appId,
      "html-v1.json",
    );
    const candidate = {
      ...JSON.parse(await fs.readFile(originalFile, "utf8")),
      artifactId: candidateId,
      editBase: ref,
      parentVersion: 1,
      source: "<h1>修改候选计数器</h1>",
      title: "修改候选计数器",
    };
    const candidateRoot = path.join(
      chatRoot,
      "artifacts",
      session.id,
      candidateId,
    );
    await fs.mkdir(candidateRoot, { recursive: true });
    await fs.writeFile(
      path.join(candidateRoot, "html-v1.json"),
      JSON.stringify(candidate),
    );
    session.messages[0].blocks.push({
      id: randomUUID(),
      type: "html",
      ref: { kind: "html", artifactId: candidateId, version: 1 },
      complete: true,
      saved: true,
      runtimeVersion: 2,
    });
    await fs.writeFile(
      path.join(chatRoot, `${session.id}.json`),
      JSON.stringify(session),
    );
    browser = await puppeteer.launch({
      executablePath:
        process.env.BROWSER_EXECUTABLE ||
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      pipe: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
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
    await page.waitForSelector('[aria-label="继续修正"]', { timeout: 60000 });
    assert.equal(
      await page.$$eval(".note-chat-html-card", (nodes) => nodes.length),
      3,
    );
    assert.equal(
      await page.$$eval(
        '.note-chat-html-card:nth-of-type(1) [aria-label="导入笔记"]',
        (nodes) => nodes.length,
      ),
      1,
    );
    const cards = await page.$$(".note-chat-html-card");
    await page.waitForFunction(() => {
      const original = [
        ...document.querySelectorAll(".note-chat-html-card"),
      ][2]?.querySelector(".note-chat-widget-compare button");
      return original && !original.disabled;
    });
    await cards[2].$eval(".note-chat-widget-compare button", (node) =>
      node.click(),
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".note-chat-html-card")][2]?.querySelector(
        "iframe",
      ),
    );
    const comparison = await (await cards[2].$("iframe")).contentFrame();
    await comparison.waitForSelector("#add");
    assert.equal(
      await comparison.$eval("h1", (node) => node.textContent),
      "原计数器",
    );
    assert.equal((await cards[1].$$('[aria-label="导入笔记"]')).length, 0);
    assert.equal((await cards[1].$$("iframe")).length, 0);
    assert.ok(
      await page.evaluate(() =>
        document.body.innerText.includes("此引用没有对应的应用卡片"),
      ),
    );
    await cards[1].$eval("details", (node) => {
      node.open = true;
    });
    await cards[1].$eval('[aria-label="查看代码"]', (node) => node.click());
    assert.ok(
      await cards[1].$eval("pre.note-chat-html-source", (node) =>
        node.textContent.includes("let n=;"),
      ),
    );
    await cards[1].$eval('[aria-label="继续修正"]', (node) => node.click());
    await page.waitForFunction(() =>
      document.body.innerText.includes("继续修正已选择的失败草稿"),
    );
    assert.ok(
      await page.$eval(".note-chat-composer textarea", (node) =>
        node.value.includes("失败草稿"),
      ),
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('[aria-label="继续修正"]', { timeout: 60000 });
    assert.ok(
      await page.evaluate(() =>
        document.body.innerText.includes("继续修正已选择的失败草稿"),
      ),
    );
    await fs.mkdir(".local-data/acceptance/source-editing", {
      recursive: true,
    });
    await page.screenshot({
      path: ".local-data/acceptance/source-editing/recovery-desktop.png",
    });
    await page.setViewport({ width: 430, height: 900 });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('[data-testid="main-menu-trigger"]', {
      timeout: 120000,
    });
    await page.click('[data-testid="main-menu-trigger"]');
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".dropdown-menu-item")].some((node) =>
        node.textContent.includes("笔记聊天"),
      ),
    );
    await page.evaluate(() =>
      [...document.querySelectorAll(".dropdown-menu-item")]
        .find((node) => node.textContent.includes("笔记聊天"))
        .click(),
    );
    await page.waitForSelector('[aria-label="继续修正"]', { timeout: 60000 });
    await page.waitForFunction(() => {
      const panel = document.querySelector(".note-chat");
      const box = panel?.getBoundingClientRect();
      return box && box.left >= 0 && box.right <= innerWidth + 1;
    });
    await page.screenshot({
      path: ".local-data/acceptance/source-editing/recovery-narrow.png",
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: failed draft, inert source, continue-repair selection, missing reference, refresh and narrow layout",
    );
  } finally {
    await browser?.close();
    await fs.unlink(path.join(directory, filename));
    await fs.rm(chatRoot, { recursive: true, force: true });
    await fs.rm(path.join(directory, ".apps", noteId), {
      recursive: true,
      force: true,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

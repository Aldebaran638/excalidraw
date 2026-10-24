/* Deterministic SSE UI acceptance on 3009. Qwen repair has a separate real-model test. */
/* eslint-disable no-console */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");

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
  const appId = randomUUID();
  const filename = `__automatic-syntax-${noteId}.excalidraw`;
  const partial =
    '<main id="app"><h1>修复验收</h1><input id="task" placeholder="任务"><button id="increase">增加</button><output id="count"></output><script>(()=>{const render=()=>document.getElementById("count").textContent=String(NoteApp.get("n",0));NoteApp.on("count","app","click","#increase",()=>{NoteApp.set("n",NoteApp.get("n",0)+1);render()});render()})()</script></main>';
  const bad = `${partial}<script>const steps={3RC:1,3RR:2};</script>`;
  const good = bad.replace("3RC:", '"3RC":').replace("3RR:", '"3RR":');
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
  let browser;
  let page;
  try {
    const session = await json(`/api/notes/${noteId}/chats`, {
      method: "POST",
    });
    const error =
      "JavaScript 语法错误：脚本 2，Identifier directly after number";
    const repair = { status: "repairing", attempts: 0, maxAttempts: 2, error };
    for (const version of [1, 2]) {
      const source = version === 1 ? bad : good;
      const folder = path.join(
        directory,
        ".apps",
        noteId,
        appId,
        version === 1 ? "drafts" : "versions",
        String(version),
      );
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "source.html"), source);
      await fs.writeFile(
        path.join(folder, "metadata.json"),
        JSON.stringify({
          formatVersion: 1,
          kind: "html",
          noteId,
          sessionId: session.id,
          artifactId: appId,
          version,
          complete: version === 2,
          runtimeVersion: 2,
          title: "修复验收",
          revision: 0,
          createdAt: Date.now(),
          sourceHash: createHash("sha256").update(source).digest("hex"),
          state: { forms: {}, custom: {} },
          repair:
            version === 1
              ? repair
              : { ...repair, status: "succeeded", attempts: 1 },
          ...(version === 1 ? { recovery: { code: "syntax", error } } : {}),
        }),
      );
    }
    browser = await puppeteer.launch({
      executablePath:
        process.env.BROWSER_EXECUTABLE ||
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      pipe: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    });
    page = await browser.newPage();
    page.on("pageerror", (error) => console.log("pageerror", String(error)));
    page.on("response", (response) => {
      if (response.url().includes("html-artifacts")) {
        void response.json().then((value) =>
          console.log("artifact response", response.status(), {
            version: value.version,
            complete: value.complete,
            error: value.error,
          }),
        );
      }
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.exposeFunction("saveSyntaxFixture", async (value) =>
      fs.writeFile(
        path.join(directory, ".chats", noteId, `${session.id}.json`),
        JSON.stringify(value),
      ),
    );
    await page.evaluateOnNewDocument(
      ({ filename, noteId, session, appId, partial, bad, repair, error }) => {
        if (window !== window.top) {
          return;
        }
        localStorage.setItem("aldebaran.repository-note-name", filename);
        const fetch = window.fetch.bind(window);
        window.fetch = async (url, init) => {
          if (
            String(url) !== `/api/notes/${noteId}/chats/${session.id}/turns`
          ) {
            return fetch(url, init);
          }
          const body = JSON.parse(init.body);
          let sequence = 0;
          const block = {
            id: "syntax-card",
            type: "html",
            ref: { kind: "html", artifactId: appId, version: 1 },
            complete: false,
            runtimeVersion: 2,
          };
          const message = {
            id: "syntax-answer-123456",
            turnId: body.turnId,
            role: "assistant",
            content: "",
            createdAt: Date.now(),
            status: "generating",
            blocks: [],
            activities: [],
          };
          const current = {
            ...session,
            revision: session.revision + 1,
            messages: [
              {
                id: "syntax-question-123456",
                turnId: body.turnId,
                role: "user",
                content: body.content,
                status: "complete",
                createdAt: Date.now(),
              },
              message,
            ],
          };
          const stream = new ReadableStream({
            async start(controller) {
              const emit = (type, value) =>
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: ${type}\ndata: ${JSON.stringify({
                      type,
                      noteId,
                      sessionId: session.id,
                      turnId: body.turnId,
                      ...value,
                    })}\n\n`,
                  ),
                );
              const wait = (ms) =>
                new Promise((resolve) => setTimeout(resolve, ms));
              emit("start", { session: current, message });
              message.blocks.push(block);
              emit("block", {
                block,
                blockDelta: partial,
                sequence: ++sequence,
              });
              await wait(5000);
              emit("block", {
                block,
                blockDelta: bad.slice(partial.length),
                sequence: ++sequence,
              });
              Object.assign(block, { draftSaved: true, error, repair });
              emit("block", { block, sequence: ++sequence });
              await wait(2000);
              for (const name of ["read_app_source", "edit_app_source"]) {
                const activity = {
                  id: name,
                  name,
                  status: "complete",
                  summary:
                    name === "read_app_source"
                      ? "已读取源码第 1–1 行"
                      : "语法修复候选已保存",
                  elementIds: [],
                  snapshotAt: Date.now(),
                };
                const tool = {
                  id: `${name}-block`,
                  type: "tool",
                  activityId: name,
                };
                message.activities.push(activity);
                message.blocks.push(tool);
                emit("block", { block: tool, sequence: ++sequence });
                emit("tool_end", { activity });
              }
              Object.assign(block, {
                ref: { kind: "html", artifactId: appId, version: 2 },
                error: undefined,
                complete: true,
                saved: true,
                repair: { ...repair, status: "succeeded", attempts: 1 },
              });
              emit("block", { block, sequence: ++sequence });
              message.status = "complete";
              current.revision++;
              await window.saveSyntaxFixture(current);
              emit("done", { session: current, message, saved: true });
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream" },
          });
        };
      },
      { filename, noteId, session, appId, partial, bad, repair, error },
    );
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('[aria-label="打开笔记聊天"]', {
      timeout: 120000,
    });
    await page.click('[aria-label="打开笔记聊天"]');
    await page.waitForSelector(".note-chat-composer textarea");
    const originalNote = await fs.readFile(
      path.join(directory, filename),
      "utf8",
    );
    await page.type(".note-chat-composer textarea", "生成交互应用");
    await page.click('[aria-label="发送消息"]');
    await page.waitForSelector(".note-chat-html-frame", { timeout: 60000 });
    let frame = await (await page.$(".note-chat-html-frame")).contentFrame();
    await frame.waitForSelector("#task");
    await frame.type("#task", "修复时保留输入");
    await frame.click("#increase");
    await page.waitForFunction(
      () => document.body.innerText.includes("正在修正语法错误"),
      { timeout: 60000 },
    );
    assert.equal(
      await page.$$eval(".note-chat-html-card", (nodes) => nodes.length),
      1,
    );
    assert.equal(
      await page.$$eval(
        '.note-chat-html-card [aria-label="导入笔记"]',
        (nodes) => nodes.length,
      ),
      0,
    );
    await page.waitForFunction(
      () => document.body.innerText.includes("语法已修复，源码已保存"),
      { timeout: 60000 },
    );
    await page.waitForSelector(".note-chat-html-frame");
    frame = await (await page.$(".note-chat-html-frame")).contentFrame();
    await frame.waitForFunction(
      () => document.getElementById("task")?.value === "修复时保留输入",
    );
    assert.equal(await frame.$eval("#count", (node) => node.textContent), "1");
    assert.equal(
      await page.$$eval(".note-chat-html-card", (nodes) => nodes.length),
      1,
    );
    assert.ok(await page.$('[aria-label="导入笔记"]'));
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="停止回答"]'),
    );
    await fs.mkdir(".local-data/acceptance/auto-syntax", { recursive: true });
    await page.screenshot({
      path: ".local-data/acceptance/auto-syntax/desktop.png",
    });
    await page
      .waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          response.url().includes("version=2"),
        { timeout: 10000 },
      )
      .catch(() => {});
    assert.equal(
      await fs.readFile(path.join(directory, filename), "utf8"),
      originalNote,
    );
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
    await page.waitForSelector(".note-chat-html-frame", { timeout: 60000 });
    frame = await (await page.$(".note-chat-html-frame")).contentFrame();
    await frame.waitForFunction(
      () => document.getElementById("task")?.value === "修复时保留输入",
    );
    assert.equal(await frame.$eval("#count", (node) => node.textContent), "1");
    await page.screenshot({
      path: ".local-data/acceptance/auto-syntax/narrow.png",
    });
    console.log(
      "PASS simulated SSE: one card, repair stage, source replacement, latest forms/custom state, refresh, narrow layout, no note writes",
    );
  } catch (error) {
    if (page) {
      console.log(
        "UI failure",
        await page.evaluate(() => ({
          text: document.querySelector(".note-chat")?.innerText,
          runtime: document
            .querySelector(".html-app-runtime")
            ?.innerHTML.slice(0, 400),
        })),
      );
      await fs.mkdir(".local-data/acceptance/auto-syntax", { recursive: true });
      await page.screenshot({
        path: ".local-data/acceptance/auto-syntax/failure.png",
      });
    }
    throw error;
  } finally {
    await browser?.close();
    await fs.unlink(path.join(directory, filename));
    await fs.rm(path.join(directory, ".chats", noteId), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(directory, ".apps", noteId), {
      recursive: true,
      force: true,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

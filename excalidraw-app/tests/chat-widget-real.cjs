/* Real-model smoke test; never run against daily or user preview notes. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const puppeteer = require("puppeteer-core");
const base = process.env.APP_URL || "http://127.0.0.1:3009";
const directory = process.env.TEST_NOTES_DIR;
const filename = `__chat-widget-real-${Date.now()}.excalidraw`;
const noteId = randomUUID();
let browser;
const json = async (url, init) => {
  const response = await fetch(`${base}${url}`, init);
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
};
(async () => {
  assert.ok(
    directory && path.resolve(directory).startsWith("/tmp/excalidraw-chat-"),
  );
  const status = await json("/api/ai/status");
  assert.equal(
    status.model,
    "qwen3.8-27b",
    "Refuse to treat a fixture as the real model",
  );
  assert.equal(status.available, true);
  await json(`/api/notes/${filename}`, {
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
  const session = await json(`/api/notes/${noteId}/chats`, { method: "POST" });
  const url = `/api/notes/${noteId}/chats/${session.id}`;
  const turn = async (content, revision, workspace, workspaceState) => {
    const response = await fetch(`${base}${url}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(185000),
      body: JSON.stringify({
        turnId: randomUUID(),
        content,
        revision,
        thinking: false,
        snapshot: { capturedAt: Date.now(), elements: [] },
        workspace,
        workspaceState,
      }),
    });
    const events = (await response.text()).split("\n\n").flatMap((block) => {
      const line = block.split("\n").find((line) => line.startsWith("data: "));
      return line ? [JSON.parse(line.slice(6))] : [];
    });
    const ready = events.find((event) => event.type === "widget_ready");
    const previewIndex = events.findIndex(
      (event) =>
        event.type === "widget_progress" &&
        event.progress?.phase === "generating" &&
        event.progress.document,
    );
    assert.ok(
      ready,
      JSON.stringify(
        events.filter((event) =>
          ["error", "widget_error", "done"].includes(event.type),
        ),
      ),
    );
    assert.ok(
      previewIndex >= 0 && previewIndex < events.indexOf(ready),
      "Real Qwen must stream a valid preview before artifact readiness",
    );
    assert.equal(events.at(-1)?.saved, true);
    const data = await json(
      `${url}/artifacts/${ready.artifact.artifactId}?version=${ready.artifact.version}`,
    );
    assert.equal(data.document.version, 2);
    console.log(
      JSON.stringify({
        model: status.model,
        artifact: ready.artifact,
        textDeltas: events.filter((event) => event.type === "delta").length,
        saved: events.at(-1).saved,
        answerStatus: events.at(-1).message?.status,
        replyError: events.find((event) => event.type === "error")?.error,
        streamedPreviews: events.filter(
          (event) =>
            event.type === "widget_progress" && event.progress?.document,
        ).length,
      }),
    );
    return data;
  };
  const first = await turn(
    "请调用 create_widget_draft 工具，在聊天里生成一个简洁的加法计算器：两个数字输入 A、B，默认3和4，一个随输入变化的加法结果。小于10个节点。不要读取画布，不要输出JSON代码块。",
    session.revision,
  );
  const current = await json(url);
  const state = { ...first.document.state };
  const inputKey = Object.keys(state).find((key) => state[key] === 3);
  assert.ok(
    inputKey,
    "The calculator must contain its requested numeric input",
  );
  state[inputKey] = 71;
  const second = await turn(
    "请调用 revise_widget_draft，保持控件、运算逻辑、节点ID及状态键不变，仅将组件名称和标题改为“双数相加”。",
    current.revision,
    { kind: "artifact", artifactId: first.artifactId, version: first.version },
    state,
  );
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.version, 2);
  assert.equal(second.document.state[inputKey], 71);
  assert.equal((await json(`/api/notes/${filename}`)).elements.length, 0);
  console.log(
    "PASS real Qwen tool-driven creation, shared generator, persisted version revision, compatible trial inputs and no canvas writes",
  );
  if (process.env.BROWSER_EXECUTABLE) {
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
    await page.waitForSelector(".note-chat-widget .iw-view input", {
      timeout: 120000,
    });
    assert.ok(
      await page.$eval(".note-chat-widget .iw-view", (node) =>
        node.innerText.includes("双数相加"),
      ),
    );
    assert.deepEqual(errors, []);
    await page.screenshot({ path: "/tmp/chat-widget-real-desktop.png" });
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
    });
    await page.screenshot({ path: "/tmp/chat-widget-real-mobile.png" });
    assert.equal((await json(`/api/notes/${filename}`)).elements.length, 0);
    console.log(
      "PASS actual Qwen artifact rendered interactively in the browser without canvas writes",
    );
  }
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

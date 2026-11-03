/* Fixed 3009, additive UUID fixtures only. No Qwen requests. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { chromium } = require("playwright-core");

const base = "http://127.0.0.1:3009";
const directory = path.resolve(".local-data/preview/notes");
async function json(url, init) {
  const response = await fetch(base + url, init);
  assert.ok(response.ok, `HTTP ${response.status}: ${url}`);
  return response.json();
}
(async () => {
  const noteId = randomUUID();
  const filename = `__agent-log-${noteId}.excalidraw`;
  const turnId = randomUUID();
  let browser;
  let page;
  let session;
  const output = ".local-data/acceptance/agent-log";
  try {
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
    session = await json(`/api/notes/${noteId}/chats`, { method: "POST" });
    session.messages = [
      {
        id: randomUUID(),
        turnId,
        role: "user",
        content: "演示通信过程",
        createdAt: Date.now(),
        status: "complete",
      },
      {
        id: randomUUID(),
        turnId,
        role: "assistant",
        content: "回答完成。",
        createdAt: Date.now(),
        status: "complete",
      },
    ];
    const sessionPath = path.join(
      directory,
      ".chats",
      noteId,
      `${session.id}.json`,
    );
    await fs.writeFile(`${sessionPath}.fixture.tmp`, JSON.stringify(session));
    await fs.rename(`${sessionPath}.fixture.tmp`, sessionPath);
    const logFolder = path.join(
      directory,
      ".chats",
      noteId,
      "agent-logs",
      session.id,
    );
    const logFile = path.join(logFolder, `${turnId}.jsonl`);
    let sequence = 0;
    const entry = (kind, data) => ({
      version: 1,
      noteId,
      sessionId: session.id,
      turnId,
      sequence: ++sequence,
      at: Date.now(),
      kind,
      data,
    });

    browser = await chromium.launch({
      executablePath:
        process.env.BROWSER_EXECUTABLE ||
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    });
    const context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: base,
    });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((name) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", name);
      }
    }, filename);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    console.log("stage: page loaded");
    await page
      .getByRole("button", { name: "打开笔记聊天", exact: true })
      .click({ timeout: 120000 });
    await page.getByText("回答完成。", { exact: true }).waitFor();
    console.log("stage: chat loaded");
    const header = await page.locator(".note-chat-header").boundingBox();
    await page
      .getByRole("button", { name: "查看 Agent 通信日志", exact: true })
      .click();
    const dialog = page.locator(".agent-log-dialog");
    await dialog.getByText(/历史对话没有原始通信日志/).waitFor();
    console.log("stage: empty log loaded");
    await fs.mkdir(logFolder, { recursive: true });
    const entries = [
      entry("turn_start", { model: "fixture-qwen", content: "演示通信过程" }),
      entry("model_request", {
        model: "fixture-qwen",
        messages: [
          { role: "system", content: "这是测试提示：按需读取笔记。" },
          { role: "user", content: "演示通信过程" },
        ],
        stream: true,
      }),
      entry("model_stream", {
        frames: [
          JSON.stringify({ choices: [{ delta: { content: "中文分片" } }] }),
        ],
      }),
      entry("model_response", {
        reasoning_content: "先看笔记，再回答。",
        content: "这是原样保存的输出。",
        tool_calls: [
          { id: "read-1", name: "get_note_outline", arguments: "{}" },
        ],
        finish_reason: "tool_calls",
      }),
      entry("tool_call", {
        toolCallId: "read-1",
        name: "get_note_outline",
        arguments: "{}",
      }),
      entry("tool_result", {
        toolCallId: "read-1",
        name: "get_note_outline",
        result: { elements: [{ id: "e-1", text: "笔记中的中文" }] },
        modelContent: '{"elements":[{"id":"e-1","text":"笔记中的中文"}]}',
      }),
      entry("transport_error", {
        status: 503,
        error: "模拟上游错误，保留日志",
      }),
      entry("model_request", {
        model: "fixture-qwen",
        messages: [
          { role: "system", content: "长源码" },
          {
            role: "tool",
            content: `长行https://example.invalid/${"abcdef".repeat(1000)}`,
          },
          {
            role: "user",
            content: "<script>window.top.LOG_INJECTED=true</script>",
          },
        ],
      }),
      entry("turn_end", { status: "complete", saved: true }),
    ];
    await fs.writeFile(
      logFile,
      `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`,
    );
    await dialog
      .getByText("系统 → Qwen · 实际请求", { exact: true })
      .first()
      .waitFor({ timeout: 10000 });
    assert.equal(
      await dialog
        .getByText("Qwen → 系统 · 原始 SSE 分片", { exact: true })
        .count(),
      0,
    );
    await dialog.getByLabel("原始 SSE 分片", { exact: true }).check();
    await dialog
      .getByText("Qwen → 系统 · 原始 SSE 分片", { exact: true })
      .waitFor();
    await dialog.getByLabel("原始 SSE 分片", { exact: true }).uncheck();
    await dialog
      .getByText("Qwen → 系统 · 完整输出／部分输出", { exact: true })
      .click();
    await dialog
      .locator("pre")
      .filter({ hasText: "先看笔记，再回答。" })
      .waitFor();
    await dialog
      .getByRole("button", { name: "复制这条日志", exact: true })
      .click();
    assert.ok(
      (await page.evaluate(() => navigator.clipboard.readText())).includes(
        "这是原样保存的输出。",
      ),
    );
    const downloadEvent = page.waitForEvent("download");
    await dialog
      .getByRole("link", { name: "下载本轮完整日志", exact: true })
      .click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), `agent-${turnId}.jsonl`);
    assert.equal(
      (await fs.readFile(await download.path(), "utf8")).trim().split("\n")
        .length,
      9,
    );

    // New events must append without closing details or resetting reading position.
    await fs.appendFile(
      logFile,
      `${JSON.stringify(
        entry("system_event", { type: "test-only", text: "实时追加验证" }),
      )}\n`,
    );
    await dialog
      .getByText("系统 → 界面 · 状态反馈", { exact: true })
      .waitFor({ timeout: 10000 });
    assert.equal(await dialog.locator("details[open]").count(), 1);
    await dialog
      .getByText("系统 → Qwen · 实际请求", { exact: true })
      .last()
      .click();
    await dialog.locator("pre").filter({ hasText: "长源码" }).waitFor();
    assert.equal(await page.evaluate(() => window.LOG_INJECTED), undefined);
    const dimensions = await dialog
      .locator(".agent-log-scroll")
      .evaluate((node) => ({
        width: node.clientWidth,
        outer: node.offsetWidth,
        scroll: node.scrollWidth,
      }));
    assert.equal(
      dimensions.width,
      dimensions.outer,
      "scrollbar must not reserve width",
    );
    assert.ok(
      dimensions.scroll <= dimensions.width + 1,
      "long source wraps instead of horizontal scrolling",
    );
    const scroll = dialog.locator(".agent-log-scroll");
    const bar = dialog.getByRole("scrollbar", { name: "通信日志内容滚动条" });
    await bar.waitFor();
    await bar.focus();
    await page.keyboard.press("Home");
    await page.waitForFunction(
      () => document.querySelector(".agent-log-scroll").scrollTop === 0,
    );
    const bounds = await bar.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 10);
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    assert.ok(await scroll.evaluate((node) => node.scrollTop > 10));
    await bar.focus();
    await page.keyboard.press("Home");
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: `${output}/desktop.png`, timeout: 15000 });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    const after = await page.locator(".note-chat-header").boundingBox();
    assert.deepEqual(
      after,
      header,
      "opening logs must not change sidebar geometry",
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "查看 Agent 通信日志", exact: true })
      .click({ timeout: 120000 });
    await dialog.getByText("工具 → 系统 · 执行结果", { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: "关闭通信日志", exact: true })
      .click();
    await page.mouse.click(400, 90);
    await page.keyboard.press("Shift+Alt+d");
    await page.locator(".excalidraw.theme--dark").waitFor();
    await page.setViewportSize({ width: 430, height: 900 });
    await page
      .getByRole("button", { name: "查看 Agent 通信日志", exact: true })
      .click();
    await dialog.getByText("工具 → 系统 · 执行结果", { exact: true }).click();
    await dialog.locator("pre").filter({ hasText: "笔记中的中文" }).waitFor();
    assert.ok(
      (
        await dialog
          .getByRole("button", { name: "复制这条日志", exact: true })
          .boundingBox()
      ).height >= 44,
    );
    await page.screenshot({
      path: `${output}/mobile-dark.png`,
      timeout: 15000,
    });
    assert.deepEqual(errors, []);
    const stored = await json(`/api/notes/${noteId}/chats/${session.id}`);
    assert.equal(stored.revision, session.revision);
    assert.deepEqual(stored.messages, session.messages);
    console.log(
      "PASS empty/live logs, ordered details, raw frames, copy, download, scroll drag/keyboard, soft wrapping, safe text, refresh, narrow/dark and no history writes",
    );
  } catch (error) {
    await fs.mkdir(output, { recursive: true });
    await page
      ?.screenshot({ path: `${output}/failure.png`, timeout: 10000 })
      .catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    await fs.unlink(path.join(directory, filename)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await fs.rm(path.join(directory, ".chats", noteId), {
      recursive: true,
      force: true,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

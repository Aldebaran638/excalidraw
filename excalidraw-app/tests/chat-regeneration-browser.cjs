/* Real UI, mocked SSE only; fixed 3009 and uniquely owned persistent fixtures. */
/* eslint-disable no-console */
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:3009";
const root = path.resolve(".local-data/preview/notes");
const output = path.resolve(".local-data/acceptance/linear-regeneration");
const json = async (url, init) => {
  const r = await fetch(base + url, init);
  assert.ok(r.ok, `${url}: ${r.status}`);
  return r.json();
};
(async () => {
  const noteId = randomUUID();
  const filename = `__linear-regeneration-${noteId}.excalidraw`;
  let browser;
  try {
    await fs.mkdir(output, { recursive: true });
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
    const session = await json(`/api/notes/${noteId}/chats`, {
      method: "POST",
    });
    const message = (role, content) => ({
      id: randomUUID(),
      turnId: randomUUID(),
      role,
      content,
      status: "complete",
      createdAt: Date.now(),
    });
    session.title = "原位重新生成验收";
    session.messages = [
      message("user", "第一个问题"),
      message("assistant", "旧回答 ONE"),
      message("user", "后续问题 TWO"),
      message("assistant", "后续回答 THREE"),
    ];
    const original = structuredClone(session.messages);
    const file = path.join(root, ".chats", noteId, `${session.id}.json`);
    await fs.writeFile(file, JSON.stringify(session));
    browser = await chromium.launch({
      executablePath:
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    const page = await context.newPage();
    await page.addInitScript(
      ({ filename }) => {
        if (window === window.top) {
          localStorage.setItem("aldebaran.repository-note-name", filename);
        }
      },
      { filename },
    );
    let calls = 0;
    await page.route("**/turns", async (route) => {
      assert.equal(
        route.request().url(),
        `${base}/api/notes/${noteId}/chats/${session.id}/turns`,
      );
      const body = route.request().postDataJSON();
      calls++;
      assert.equal(body.regenerateMessageId, original[1].id);
      assert.equal(body.replaceMessageId, undefined);
      assert.equal(body.retryMessageId, undefined);
      assert.equal(body.content, "第一个问题");
      const next = structuredClone(session);
      next.revision += 2;
      next.messages[1] = {
        ...next.messages[1],
        turnId: body.turnId,
        content: `新回答 ${calls}`,
        status: "complete",
      };
      const start = {
        ...next,
        messages: next.messages.map((m, i) =>
          i === 1 ? { ...m, content: "", status: "generating" } : m,
        ),
      };
      const common = { noteId, sessionId: session.id, turnId: body.turnId };
      const events = [
        {
          ...common,
          type: "start",
          session: start,
          message: start.messages[1],
        },
        { ...common, type: "delta", delta: `新回答 ${calls}` },
        {
          ...common,
          type: "done",
          session: next,
          message: next.messages[1],
          saved: true,
        },
      ];
      Object.assign(session, next);
      await fs.writeFile(file, JSON.stringify(session));
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
      });
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "打开笔记聊天", exact: true })
      .click({ timeout: 120000 });
    const replies = page.locator(".note-chat-message--assistant");
    await replies.nth(0).getByText("旧回答 ONE", { exact: true }).waitFor();
    const draft = page.locator(".note-chat-composer textarea");
    await draft.fill("保留未发送的草稿");
    for (let i = 1; i <= 2; i++) {
      await replies
        .nth(0)
        .getByRole("button", { name: "重新生成", exact: true })
        .click();
      await replies.nth(0).getByText(`新回答 ${i}`, { exact: true }).waitFor();
      assert.equal(await replies.count(), 2);
      assert.equal(await page.locator(".note-chat-message--user").count(), 2);
      assert.ok(
        (await replies.nth(1).textContent()).includes("后续回答 THREE"),
      );
      assert.equal(await draft.inputValue(), "保留未发送的草稿");
      const saved = await json(`/api/notes/${noteId}/chats/${session.id}`);
      assert.equal(saved.previousVersions, undefined);
      assert.deepEqual(saved.messages.slice(2), original.slice(2));
      assert.equal(saved.messages[1].id, original[1].id);
    }
    await page.screenshot({ path: path.join(output, "light.png") });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("新回答 2", { exact: true }).waitFor();
    assert.equal(await replies.count(), 2);
    assert.ok((await replies.nth(1).textContent()).includes("后续回答 THREE"));
    await page.setViewportSize({ width: 430, height: 900 });
    await page.locator(".excalidraw").focus();
    await page.keyboard.press("Alt+Shift+D");
    await page.locator(".excalidraw.theme--dark").waitFor();
    await page.screenshot({ path: path.join(output, "narrow-dark.png") });
    assert.equal(calls, 2);
    console.log(
      "PASS: repeated historical regeneration, stable reply slot, future messages and draft retained, reload, dark/narrow; SSE mocked, Qwen calls 0",
    );
  } finally {
    await browser?.close();
    await fs.rm(path.join(root, filename), { force: true });
    for (const kind of [".chats", ".apps"]) {
      await fs.rm(path.join(root, kind, noteId), {
        force: true,
        recursive: true,
      });
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

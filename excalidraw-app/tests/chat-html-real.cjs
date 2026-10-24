/* Explicit real-Qwen acceptance, always isolated from daily notes. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const base = "http://127.0.0.1:3009";
const json = async (url, init) => {
  const response = await fetch(base + url, init);
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
};
(async () => {
  assert.ok(
    process.env.TEST_NOTES_DIR?.startsWith("/tmp/excalidraw-chat-html-"),
  );
  assert.equal((await json("/api/ai/status")).model, "qwen3.8-27b");
  const noteId = randomUUID();
  const filename = `__html-real-${noteId}.excalidraw`;
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
  let session = await json(`/api/notes/${noteId}/chats`, { method: "POST" });
  const sessionURL = `/api/notes/${noteId}/chats/${session.id}`;
  const send = async (content, workspace) => {
    const response = await fetch(`${base + sessionURL}/turns`, {
      method: "POST",
      headers: { "X-Chat-Protocol": "3", "X-Chat-Capabilities": "html-blocks" },
      body: JSON.stringify({
        turnId: randomUUID(),
        revision: session.revision,
        content,
        workspace,
        snapshot: { capturedAt: Date.now(), elements: [] },
      }),
    });
    assert.ok(response.ok);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let count = 0;
    let final;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const line = buffer
          .slice(0, end)
          .split("\n")
          .find((line) => line.startsWith("data: "));
        buffer = buffer.slice(end + 2);
        if (!line) {
          continue;
        }
        const event = JSON.parse(line.slice(6));
        if (
          event.type === "block" &&
          event.block?.type === "html" &&
          event.blockDelta
        ) {
          count++;
        }
        if (event.type === "done") {
          final = event;
        }
      }
    }
    assert.ok(final?.saved);
    assert.equal(final.message.status, "complete", final.message.error);
    session = final.session;
    const block = final.message.blocks.find((block) => block.type === "html");
    assert.ok(block?.saved, "real model must emit a persisted HTML app");
    const data = await json(
      `${sessionURL}/html-artifacts/${block.ref.artifactId}?version=${block.ref.version}`,
    );
    assert.ok(data.complete);
    assert.ok(data.source.includes("<script"));
    assert.ok(count > 0);
    console.log(
      JSON.stringify({
        version: data.version,
        sourceBytes: data.source.length,
        incrementalChunks: count,
        status: final.message.status,
      }),
    );
    return data;
  };
  try {
    const first = await send(
      "请直接输出一个简洁的可交互加法计算器HTML应用。两个数字输入、即时结果，使用原生HTML/CSS/JS，不调用组件工具。最多80行。输入id稳定，支持NoteApp状态。",
      undefined,
    );
    const second = await send(
      "基于选中的应用增加一个清零按钮，其余布局保持。返回完整HTML。",
      { kind: "html", artifactId: first.artifactId, version: first.version },
    );
    assert.equal(second.artifactId, first.artifactId);
    assert.equal(second.version, 2);
    assert.equal((await json(`/api/notes/${filename}`)).elements.length, 0);
    console.log(
      "PASS: real Qwen single-turn HTML creation and explicit-target revision, saved versions, no canvas writes",
    );
  } finally {
    await fs.unlink(path.join(process.env.TEST_NOTES_DIR, filename));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/* One real Qwen loop, fixed 3009; never replay a user conversation. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const base = "http://127.0.0.1:3009";
const directory = path.resolve(".local-data/preview/notes");
const output = ".local-data/acceptance/agent-log";
async function request(url, init) {
  const response = await fetch(base + url, init);
  assert.ok(response.ok, `HTTP ${response.status}: ${url}`);
  return response;
}
(async () => {
  const noteId = randomUUID();
  const filename = `__agent-log-real-${noteId}.excalidraw`;
  const turnId = randomUUID();
  const marker = `通信日志验证成功-${noteId.slice(0, 8)}`;
  let session;
  let ended = false;
  try {
    await request(`/api/notes/${filename}`, {
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
    session = await (
      await request(`/api/notes/${noteId}/chats`, { method: "POST" })
    ).json();
    const client = await (await request("/api/client-info")).json();
    const response = await request(
      `/api/notes/${noteId}/chats/${session.id}/turns`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Chat-Protocol": String(client.chatProtocolVersion),
          "X-Chat-Capabilities":
            "html-blocks,preview-feedback,interaction-probes",
        },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({
          turnId,
          revision: session.revision,
          thinking: false,
          content:
            "只需要回答：请通过 read_note_elements 工具读取当前笔记中 ID 为 communication-proof 的文字元素，然后原样回复这段文字。不要创建或修改应用。",
          snapshot: {
            capturedAt: Date.now(),
            elements: [
              { id: "communication-proof", type: "text", text: marker },
            ],
          },
        }),
      },
    );
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const done = events.findLast((event) => event.type === "done");
    ended = Boolean(done);
    assert.ok(done?.saved, "answer must be persisted");
    assert.equal(done.message.status, "complete");
    assert.ok(done.message.content.includes(marker));
    const log = await (
      await request(
        `/api/notes/${noteId}/chats/${session.id}/agent-logs/${turnId}?download=1`,
      )
    ).text();
    const entries = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries.at(-1).kind, "turn_end");
    const calls = entries.filter((entry) => entry.kind === "tool_call");
    assert.ok(calls.some((entry) => entry.data.name === "read_note_elements"));
    const requests = entries.filter((entry) => entry.kind === "model_request");
    assert.ok(
      !JSON.stringify(requests[0]).includes(marker),
      "note text is not sent until a real read",
    );
    const result = entries.find(
      (entry) =>
        entry.kind === "tool_result" &&
        entry.data.name === "read_note_elements",
    );
    assert.ok(JSON.stringify(result).includes(marker));
    assert.ok(
      requests.some((entry) =>
        entry.data.messages.some(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === result.data.toolCallId &&
            message.content === result.data.modelContent,
        ),
      ),
    );
    const responses = entries.filter(
      (entry) => entry.kind === "model_response",
    );
    assert.equal(
      responses.map((entry) => entry.data.content).join(""),
      events
        .filter((event) => event.type === "delta")
        .map((event) => event.delta)
        .join(""),
    );
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, "real-communication.jsonl"), log);
    const task = done.message.agentTask?.kind;
    const unexpectedApplication =
      done.message.blocks?.some((block) => block.type === "html") || false;
    await fs.writeFile(
      path.join(output, "real-result.json"),
      JSON.stringify(
        {
          passed: true,
          buildId: client.buildId,
          requests: requests.length,
          tools: calls.map((entry) => entry.data.name),
          entries: entries.length,
          task,
          unexpectedApplication,
        },
        null,
        2,
      ),
    );
    assert.equal(
      task,
      "chat",
      "this read-only acceptance must not enter app creation",
    );
    assert.equal(unexpectedApplication, false);
    console.log(
      `PASS real Qwen: ${requests.length} requests in one serial loop, ${calls.length} real tools; request/result/output exact match`,
    );
  } finally {
    if (session && !ended) {
      await fetch(
        `${base}/api/notes/${noteId}/chats/${session.id}/turns/${turnId}/stop`,
        { method: "POST" },
      );
      for (let i = 0; i < 30; i++) {
        const current = await (
          await request(`/api/notes/${noteId}/chats/${session.id}`)
        ).json();
        if (
          !current.messages.some((message) => message.status === "generating")
        ) {
          ended = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.ok(
        ended,
        "own fixture still generating; preserve it for recovery rather than deleting running data",
      );
    }
    await fs.unlink(path.join(directory, filename)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
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

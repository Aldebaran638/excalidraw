/* Resume only our last browser fixture from exact recorded source/tool edits.
 * Never replay model requests, read user conversations, or regenerate the app. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const base = "http://127.0.0.1:3009";
const directory = path.resolve(".local-data/preview/notes");
const output = path.resolve(".local-data/acceptance/pi-runtime");
const hash = (source) => createHash("sha256").update(source).digest("hex");
const readTrace = async (name) =>
  (await fs.readFile(path.join(output, name), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
const json = async (url, options) => {
  const response = await fetch(base + url, options);
  assert.ok(response.ok, `HTTP ${response.status}: ${url}`);
  return response.json();
};
(async () => {
  const report = JSON.parse(
    await fs.readFile(path.join(output, "real-results.json"), "utf8"),
  );
  const fixture = report.find(
    (item) => item.cycle === 2 && item.kind === "complex",
  );
  assert.ok(
    fixture &&
      !fixture.passed &&
      fixture.turns.every((turn) => turn.status === "complete"),
  );
  const generated = (await readTrace("2-complex-1.jsonl"))
    .filter((entry) => entry.kind === "model_response")
    .map((entry) => entry.data.content)
    .join("");
  let source = generated.match(/```html[^\n]*\n([\s\S]*?)```/)[1];
  for (const version of [2, 3]) {
    for (const call of (await readTrace(`2-complex-${version}.jsonl`)).filter(
      (entry) =>
        entry.kind === "tool_call" && entry.data.name === "edit_app_source",
    )) {
      const args = JSON.parse(call.data.arguments);
      assert.equal(hash(source), args.sourceHash);
      for (const edit of args.edits) {
        if (edit.startLine !== undefined) {
          const lines = source.split("\n");
          lines.splice(
            edit.startLine - 1,
            edit.endLine - edit.startLine + 1,
            edit.newText,
          );
          source = lines.join("\n");
        } else {
          assert.equal(source.split(edit.oldText).length, 2);
          source = source.replace(edit.oldText, edit.newText);
        }
      }
    }
  }
  const noteId = randomUUID();
  const filename = `__pi-canvas-resume-${noteId}.excalidraw`;
  let session;
  try {
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
    session = await json(`/api/notes/${noteId}/chats`, { method: "POST" });
    const artifactId = randomUUID();
    const artifactRoot = path.join(
      directory,
      ".chats",
      noteId,
      "artifacts",
      session.id,
      artifactId,
    );
    await fs.mkdir(artifactRoot, { recursive: true });
    const ref = { kind: "html", artifactId, version: 1 };
    await fs.writeFile(
      path.join(artifactRoot, "html-v1.json"),
      JSON.stringify({
        ...ref,
        noteId,
        sessionId: session.id,
        title: "Kubernetes",
        source,
        complete: true,
        runtimeVersion: 3,
        state: { forms: {}, custom: {} },
        revision: 0,
        createdAt: Date.now(),
      }),
    );
    session.messages = [
      {
        id: randomUUID(),
        turnId: randomUUID(),
        role: "assistant",
        content: "已生成的真实 Qwen 作品，仅恢复浏览器验收",
        status: "complete",
        createdAt: Date.now(),
        blocks: [
          {
            id: randomUUID(),
            type: "html",
            ref,
            saved: true,
            complete: true,
            runtimeVersion: 3,
          },
        ],
      },
    ];
    await fs.writeFile(
      path.join(directory, ".chats", noteId, `${session.id}.json`),
      JSON.stringify(session),
    );
    const endpoint = `/api/notes/${noteId}/chats/${session.id}`;
    fixture.canvas = await require("./pi-agent-canvas.cjs")({
      base,
      filename,
      endpoint,
      cycle: 2,
      kind: "complex",
      output,
    });
    fixture.canvas.resumedFromRecordedSourceHash = hash(source);
    fixture.passed = true;
    const trace = await fetch(
      `${base}${endpoint}/agent-logs/${fixture.canvas.turnId}?download=1`,
    );
    assert.ok(trace.ok);
    await fs.writeFile(
      path.join(output, "2-complex-canvas.jsonl"),
      await trace.text(),
    );
    for (const item of report) {
      for (const turn of item.turns) {
        if (turn.elapsedMs < 0) {
          turn.elapsedMs = null;
          turn.timingWarning = "Host wall clock changed; duration unavailable";
        }
      }
    }
    await fs.writeFile(
      path.join(output, "real-results.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(fixture.canvas));
    assert.ok(report.every((item) => item.passed));
  } finally {
    if (session) {
      const endpoint = `/api/notes/${noteId}/chats/${session.id}`;
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = await json(endpoint);
        const running = current.messages.find(
          (message) => message.status === "generating",
        );
        if (!running) {
          break;
        }
        await fetch(`${base}${endpoint}/turns/${running.turnId}/stop`, {
          method: "POST",
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await fs.rm(path.join(directory, filename), { force: true });
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

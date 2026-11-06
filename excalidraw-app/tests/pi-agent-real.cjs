/* Real Qwen acceptance: strictly serial, fixed 3009 and existing preview storage. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const base = "http://127.0.0.1:3009";
const directory = path.resolve(".local-data/preview/notes");
const output = path.resolve(".local-data/acceptance/pi-runtime");
const results = [];
async function request(url, options) {
  const response = await fetch(base + url, options);
  assert.ok(
    response.ok,
    `${url}: HTTP ${response.status} ${
      response.ok ? "" : await response.text()
    }`,
  );
  return response;
}
async function json(url, options) {
  return (await request(url, options)).json();
}
async function scenario(cycle, kind) {
  const noteId = randomUUID();
  const filename = `__pi-real-${cycle}-${kind}-${noteId}.excalidraw`;
  const fixture = { cycle, kind, noteId, filename, turns: [] };
  results.push(fixture);
  let session;
  let activeTurn;
  const endpoint = () => `/api/notes/${noteId}/chats/${session.id}`;
  const artifact = (block) =>
    json(
      `${endpoint()}/html-artifacts/${block.ref.artifactId}?version=${
        block.ref.version
      }`,
    );
  const send = async (
    content,
    snapshot = { capturedAt: Date.now(), elements: [] },
  ) => {
    session = await json(endpoint());
    const turnId = (activeTurn = randomUUID());
    const started = performance.now();
    const response = await request(`${endpoint()}/turns`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chat-Protocol": "9",
        "X-Chat-Capabilities": "html-blocks",
      },
      signal: AbortSignal.timeout(620000),
      body: JSON.stringify({
        turnId,
        revision: session.revision,
        content,
        thinking: false,
        snapshot,
        workspace: session.appWorkspace?.selection,
        workspaceGeneration: session.appWorkspace?.generation,
      }),
    });
    const events = [];
    const decoder = new TextDecoder();
    let buffer = "";
    let firstHtmlAt;
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const line = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!line) {
          continue;
        }
        const event = JSON.parse(line.slice(6));
        events.push(event);
        if (
          !firstHtmlAt &&
          event.block?.type === "html" &&
          event.blockDelta?.includes("<")
        ) {
          firstHtmlAt = performance.now();
        }
      }
    }
    const done = events.findLast((event) => event.type === "done");
    activeTurn = undefined;
    const trace = await (
      await request(`${endpoint()}/agent-logs/${turnId}?download=1`)
    ).text();
    await fs.writeFile(
      path.join(output, `${cycle}-${kind}-${fixture.turns.length + 1}.jsonl`),
      trace,
    );
    const entries = trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const record = {
      turnId,
      elapsedMs: Math.round(performance.now() - started),
      firstHtmlMs: firstHtmlAt && firstHtmlAt - started,
      status: done?.message?.status,
      saved: done?.saved,
      error: done?.message?.error,
      requests: entries.filter((entry) => entry.kind === "model_request")
        .length,
      tools: entries
        .filter((entry) => entry.kind === "tool_call")
        .map((entry) => entry.data.name),
    };
    fixture.turns.push(record);
    await fs.writeFile(
      path.join(output, "real-results.json"),
      JSON.stringify(results, null, 2),
    );
    console.log(JSON.stringify({ cycle, kind, ...record }));
    assert.ok(done?.saved, "answer must be saved");
    assert.equal(done.message.status, "complete", done.message.error);
    return { message: done.message, entries };
  };
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
    if (kind === "chat") {
      const marker = `PI-${noteId}`;
      const { message } = await send(
        "只需要回答：读取当前笔记中proof文字元素，然后原样告诉我它的内容。不要创建或修改应用。",
        {
          capturedAt: Date.now(),
          elements: [{ id: "proof", type: "text", text: marker }],
        },
      );
      assert.ok(message.content.includes(marker));
      assert.ok(!message.blocks.some((block) => block.type === "html"));
      fixture.passed = true;
      return;
    }
    const instruction =
      kind === "simple"
        ? "生成一个可直接交互的计数器HTML应用，增加、减少、重置按钮，使用NoteApp保存计数，稳定控件ID。先输出可见结构再输出脚本。"
        : cycle === 1
        ? "生成一个计算机网络全架构交互知识图HTML应用：OSI七层与TCP/IP分组、DNS/HTTP/TLS/TCP/UDP/IP/ARP/ICMP/以太网/WiFi至少16个节点，分组及真实SVG关系线；点击节点显示职责、常见故障；提供TCP三次握手和四次挥手可点击步骤。响应式，NoteApp保存选择，本地SVG无需外部资源。先输出可见结构，随后补充交互。"
        : "生成一个Kubernetes详细知识架构交互HTML应用：控制平面、工作节点、网络和存储分组，至少16个节点，包含API Server/etcd/Scheduler/Controller/Kubelet/Proxy/Runtime/Pod/Service/Ingress/DNS/PV/PVC/Deployment/ReplicaSet/ConfigMap，真实SVG连线。点击节点联动职责、数据流、排障解释。响应式，NoteApp保存选择，本地SVG无需外部资源。先输出可见结构，再补充交互。";
    const created = await send(instruction);
    const firstBlock = created.message.blocks.findLast(
      (block) => block.type === "html" && block.saved,
    );
    assert.ok(firstBlock, "must publish an actual artifact");
    const original = await artifact(firstBlock);
    assert.ok(original.complete && original.source.includes("<"));
    session = await json(endpoint());
    session = await json(endpoint(), {
      method: "PATCH",
      body: JSON.stringify({
        revision: session.revision,
        workspace: { generation: randomUUID(), selection: firstBlock.ref },
      }),
    });
    for (let revision = 1; revision <= 2; revision++) {
      const title = `Pi验收-${cycle}-${kind}-第${revision}次修改`;
      const edited = await send(
        `请修改当前已引用的应用：只把主标题改为“${title}”，不改变其他逻辑。必须真实读取源码并局部编辑，不重新输出HTML。`,
      );
      assert.ok(
        edited.entries.some(
          (entry) =>
            entry.kind === "tool_call" && entry.data.name === "read_app_source",
        ),
      );
      assert.ok(
        edited.entries.some(
          (entry) =>
            entry.kind === "tool_call" && entry.data.name === "edit_app_source",
        ),
      );
      const block = edited.message.blocks.findLast(
        (block) => block.type === "html" && block.saved,
      );
      assert.ok(block);
      const candidate = await artifact(block);
      assert.ok(candidate.source.includes(title));
      assert.equal(candidate.artifactId, original.artifactId);
      assert.equal(
        (await artifact(firstBlock)).source,
        original.source,
        "immutable baseline",
      );
      if (revision === 2) {
        assert.ok(
          edited.entries.some(
            (entry) =>
              entry.kind === "tool_result" &&
              entry.data.name === "read_app_source" &&
              entry.data.result?.version === candidate.parentVersion,
          ),
          "must read previous candidate, not original",
        );
      }
    }
    fixture.canvas = await require("./pi-agent-canvas.cjs")({
      base,
      filename,
      endpoint: endpoint(),
      cycle,
      kind,
      output,
    });
    const canvasTrace = await (
      await request(
        `${endpoint()}/agent-logs/${fixture.canvas.turnId}?download=1`,
      )
    ).text();
    await fs.writeFile(
      path.join(output, `${cycle}-${kind}-canvas.jsonl`),
      canvasTrace,
    );
    fixture.passed = true;
  } finally {
    if (activeTurn && session) {
      await request(`${endpoint()}/turns/${activeTurn}/stop`, {
        method: "POST",
      }).catch(() => {});
      for (let attempt = 0; attempt < 100; attempt++) {
        const saved = await json(endpoint()).catch(() => null);
        if (
          !saved?.messages.some((message) => message.status === "generating")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    // Exact, uniquely named fixtures only. Never reset the shared data directory.
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
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  for (const cycle of [1, 2]) {
    for (const kind of ["chat", "simple", "complex"]) {
      await scenario(cycle, kind);
    }
  }
  await fs.writeFile(
    path.join(output, "real-results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log("Two serial real-model regression cycles passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

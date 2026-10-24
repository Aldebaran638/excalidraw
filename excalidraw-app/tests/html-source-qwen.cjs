/* Real model acceptance, unique fixtures in the unchanged preview dataset. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const base = "http://127.0.0.1:3009";
const directory = path.resolve(__dirname, "../../.local-data/preview/notes");
const headers = {
  "Content-Type": "application/json",
  "X-Chat-Protocol": "2",
  "X-Chat-Capabilities": "html-blocks",
};
const json = async (url, init) => {
  const response = await fetch(base + url, { ...init, headers });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
};
const turn = async (noteId, session, content, workspace) => {
  const response = await fetch(
    `${base}/api/notes/${noteId}/chats/${session.id}/turns`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        turnId: randomUUID(),
        revision: session.revision,
        content,
        thinking: false,
        workspace,
        snapshot: { capturedAt: Date.now(), elements: [] },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of event.split("\n")) {
        if (line.startsWith("data: ")) {
          events.push(JSON.parse(line.slice(6)));
        }
      }
    }
  }
  return {
    events,
    session: await json(`/api/notes/${noteId}/chats/${session.id}`),
  };
};
(async () => {
  const noteId = randomUUID();
  const filename = `__qwen-source-${noteId}.excalidraw`;
  const report = [];
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
  try {
    for (const [name, requirement] of [
      ["计数器", "增加和重置按钮以及计数显示"],
      ["番茄钟", "开始、暂停、重置和剩余时间；以绝对截止时间保存NoteApp状态"],
      ["矩阵演示", "四个输入格，点击按钮显示2×2矩阵的转置，不使用Canvas"],
      [
        "架构讲解",
        "点击客户端、服务端、数据库三个节点显示解释，使用内联SVG或HTML",
      ],
    ]) {
      let session = await json(`/api/notes/${noteId}/chats`, {
        method: "POST",
      });
      const created = await turn(
        noteId,
        session,
        `生成一个精简的${name}交互HTML应用：${requirement}。主标题必须是“源码验收-${name}”，ID为app-title。少于100行，自包含，无CDN。不要说明实现，直接给html代码块。`,
      );
      session = created.session;
      const message = session.messages.at(-1);
      const block = message.blocks?.find(
        (block) => block.type === "html" && block.complete && block.saved,
      );
      if (!block) {
        report.push({
          name,
          created: false,
          status: message.status,
          error: message.error,
        });
        continue;
      }
      const artifact = await json(
        `/api/notes/${noteId}/chats/${session.id}/html-artifacts/${block.ref.artifactId}?version=${block.ref.version}`,
      );
      assert.ok(artifact.source.length > 50);
      const revised = await turn(
        noteId,
        session,
        `请先用read_app_source读取当前应用，再用edit_app_source精确替换，把主标题“源码验收-${name}”改为“已局部修改-${name}”。只改这段文字，其他源码逐字不变。不重新输出HTML。`,
        block.ref,
      );
      const answer = revised.session.messages.at(-1);
      const candidate = answer.blocks?.find(
        (block) => block.type === "html" && block.saved,
      );
      let exact = false;
      if (candidate) {
        const value = await json(
          `/api/notes/${noteId}/chats/${session.id}/html-artifacts/${candidate.ref.artifactId}?version=${candidate.ref.version}`,
        );
        const change = value.changes?.[0];
        exact = Boolean(
          value.changes?.length === 1 &&
            change &&
            change.after ===
              change.before.replace(`源码验收-${name}`, `已局部修改-${name}`) &&
            value.source ===
              artifact.source.replace(change.before, change.after),
        );
      }
      const tools = answer.activities?.map((activity) => activity.name) || [];
      report.push({
        name,
        created: true,
        sourceBytes: Buffer.byteLength(artifact.source),
        progress: created.events.some(
          (event) =>
            event.type === "block" &&
            event.block?.type === "html" &&
            !event.block.complete,
        ),
        exact,
        tools,
        status: answer.status,
      });
      console.log(JSON.stringify(report.at(-1)));
    }
    await fs.mkdir(".local-data/acceptance/html-source", { recursive: true });
    await fs.writeFile(
      ".local-data/acceptance/html-source/qwen-report.json",
      JSON.stringify(report, null, 2),
    );
    assert.ok(
      report.every((entry) => entry.created && entry.exact),
      JSON.stringify(report),
    );
  } finally {
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

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { editSource, sourceHash, validateAppSource } from "../server/appSource";
import { ChatHtmlStore } from "../server/chatHtmlStore";
import { ChatStore } from "../server/chatStore";
import { createChatService } from "../server/chat";
import { readSSE } from "../data/sse";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
const source =
  '<!doctype html><html><body><h1 id="title">计数器</h1><button id="count">+1</button><script>(()=>{let n=NoteApp.get("n",0);document.getElementById("count").onclick=()=>NoteApp.set("n",++n)})()</script></body></html>';
describe("canonical HTML source", () => {
  it("streams a read/edit tool loop and publishes a candidate without rewriting the original", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "html-source-tools-"),
    );
    folders.push(directory);
    const noteId = randomUUID();
    await fs.writeFile(
      path.join(directory, "note.excalidraw"),
      JSON.stringify({
        elements: [],
        repositoryMetadata: { version: 1, noteId },
      }),
    );
    const session = await new ChatStore(directory).create(noteId);
    const store = new ChatHtmlStore(directory);
    const app = await store.write({
      kind: "html",
      artifactId: randomUUID(),
      version: 1,
      noteId,
      sessionId: session.id,
      source,
      title: "计数器",
      complete: true,
      revision: 0,
      state: { forms: {}, custom: { n: 7 } },
      createdAt: Date.now(),
    });
    let calls = 0;
    const service = await createChatService(
      directory,
      { baseUrl: "http://fixture/v1", model: "fixture" },
      async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        expect(request.tools.map((tool: any) => tool.function.name)).toContain(
          "read_app_source",
        );
        expect(
          request.tools.map((tool: any) => tool.function.name),
        ).not.toContain("create_widget_draft");
        const step = calls++;
        let deltas: unknown[];
        if (step < 2) {
          const name = step === 0 ? "read_app_source" : "edit_app_source";
          const args =
            step === 0
              ? { startLine: 1, lineCount: 10 }
              : {
                  sourceHash: sourceHash(source),
                  edits: [{ oldText: "计数器", newText: "局部修改的计数器" }],
                };
          const text = JSON.stringify(args);
          deltas = [
            {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${step}`,
                  function: { name, arguments: "" },
                },
              ],
            },
            ...Array.from(text, (character) => ({
              tool_calls: [{ index: 0, function: { arguments: character } }],
            })),
          ];
        } else {
          deltas = [{ content: "候选已就绪，请确认。" }];
        }
        return new Response(
          `${deltas
            .map(
              (delta) =>
                `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`,
            )
            .join("")}data: ${JSON.stringify({
            choices: [
              { delta: {}, finish_reason: step < 2 ? "tool_calls" : "stop" },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      },
    );
    const server = createServer((req, res) => {
      void service.handle(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${
          (server.address() as { port: number }).port
        }/api/notes/${noteId}/chats/${session.id}/turns`,
        {
          method: "POST",
          body: JSON.stringify({
            turnId: randomUUID(),
            revision: session.revision,
            content: "修改标题，其他代码不变",
            snapshot: { capturedAt: Date.now(), elements: [] },
            workspace: { kind: "html", artifactId: app.artifactId, version: 1 },
          }),
        },
      );
      const events = [];
      for await (const event of readSSE(response.body!)) {
        events.push(JSON.parse(event.data));
      }
      const message = events.at(-1).message;
      expect(message.status).toBe("complete");
      const candidate = message.blocks.find(
        (block: any) => block.type === "html",
      );
      expect(candidate.saved).toBe(true);
      const saved = await store.read(
        noteId,
        session.id,
        candidate.ref.artifactId,
        candidate.ref.version,
      );
      expect(saved.source).toBe(source.replace("计数器", "局部修改的计数器"));
      expect(saved.state.custom.n).toBe(7);
      expect(
        (await store.read(noteId, session.id, app.artifactId, 1)).source,
      ).toBe(source);
      expect(calls).toBe(3);
    } finally {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("changes only exact ranges and leaves all remaining bytes unchanged", () => {
    const next = editSource(source, sourceHash(source), [
      { oldText: "计数器", newText: "我的计数器" },
      { oldText: ">+1<", newText: ">增加<" },
    ]);
    expect(next).toBe(
      source.replace("计数器", "我的计数器").replace(">+1<", ">增加<"),
    );
    expect(source).not.toContain("我的");
  });
  it("rejects stale hashes, ambiguous/missing/overlapping edits and invalid scripts atomically", () => {
    expect(() =>
      editSource(source, "old", [{ oldText: "计数器", newText: "新" }]),
    ).toThrow("版本");
    for (const edits of [
      [{ oldText: "不存在", newText: "新" }],
      [{ oldText: "id=", newText: "name=" }],
      [
        { oldText: "计数器", newText: "新" },
        { oldText: "数器", newText: "x" },
      ],
    ]) {
      expect(() => editSource(source, sourceHash(source), edits)).toThrow();
    }
    expect(() =>
      editSource(source, sourceHash(source), [
        { oldText: "++n", newText: "const =" },
      ]),
    ).toThrow("语法");
    expect(() => validateAppSource("<script>let x=1")).toThrow(/闭合|未完整/);
    expect(() =>
      validateAppSource('<script src="https://example.com/a.js"></script>'),
    ).toThrow("固定版本库清单");
  });
  it("publishes HTML independently, protects immutable versions, and detects missing or corrupt sources", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "html-source-"));
    folders.push(directory);
    const store = new ChatHtmlStore(directory);
    const data = {
      kind: "html" as const,
      artifactId: randomUUID(),
      version: 1,
      noteId: randomUUID(),
      sessionId: randomUUID(),
      title: "计数器",
      source,
      complete: true,
      revision: 0,
      state: { forms: {}, custom: { count: 4 } },
      createdAt: Date.now(),
    };
    const saved = await store.write(data);
    const folder = path.join(
      directory,
      ".apps",
      data.noteId,
      data.artifactId,
      "versions",
      "1",
    );
    expect(await fs.readFile(path.join(folder, "source.html"), "utf8")).toBe(
      source,
    );
    expect(
      JSON.parse(await fs.readFile(path.join(folder, "metadata.json"), "utf8")),
    ).not.toHaveProperty("source");
    expect(saved.sourceHash).toBe(sourceHash(source));
    await expect(
      store.write({ ...data, source: source.replace("计数器", "新") }),
    ).rejects.toThrow("不可覆盖");
    await fs.writeFile(path.join(folder, "source.html"), "tampered");
    await expect(
      store.readApp(data.noteId, data.artifactId, 1),
    ).rejects.toThrow("损坏");
    await fs.unlink(path.join(folder, "source.html"));
    await expect(
      store.readApp(data.noteId, data.artifactId, 1),
    ).rejects.toThrow("缺失");
    const recovered = await store.restore(data);
    expect(recovered.artifactId).toBe(data.artifactId);
    expect(recovered.version).toBe(1);
    expect(recovered.source).toBe(source);
  });
});

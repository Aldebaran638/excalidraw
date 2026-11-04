import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { HtmlFenceStream } from "../data/chatHtml";
import { ChatHtmlStore } from "../server/chatHtmlStore";
import { ChatStore } from "../server/chatStore";
import { createChatService } from "../server/agent/chat";
import { readSSE } from "../data/sse";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) {
    await action();
  }
});
const fixture = async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "excalidraw-chat-html-"),
  );
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const noteId = randomUUID();
  await fs.writeFile(
    path.join(directory, "a.excalidraw"),
    JSON.stringify({ repositoryMetadata: { version: 1, noteId } }),
  );
  const session = await new ChatStore(directory).create(noteId);
  return { directory, noteId, session };
};
describe("HTML chat artifacts", () => {
  it.each(["truncated", "unclosed", "prose-failed"])(
    "preserves %s output with bounded continuation only for truncation",
    async (mode) => {
      const { directory, noteId, session } = await fixture();
      let requests = 0;
      const transport: typeof fetch = async () => {
        requests++;
        const content = `\`\`\`html\n<button>保留内容</button>${
          mode === "prose-failed" ? "\n```\n" : ""
        }`;
        const chunks = [
          { choices: [{ delta: { content } }] },
          mode === "prose-failed"
            ? { error: { message: "文字失败" } }
            : {
                choices: [
                  {
                    delta: {},
                    finish_reason: mode === "truncated" ? "length" : "stop",
                  },
                ],
              },
        ];
        return new Response(
          `${chunks
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("")}data: [DONE]\n\n`,
        );
      };
      const service = await createChatService(
        directory,
        { baseUrl: "http://fixture/v1", model: "qwen3.8-27b" },
        transport,
      );
      cleanup.push(service.close);
      const server = createServer((req, res) => {
        void service.handle(req, res);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
      const response = await fetch(
        `http://127.0.0.1:${
          (server.address() as { port: number }).port
        }/api/notes/${noteId}/chats/${session.id}/turns`,
        {
          method: "POST",
          body: JSON.stringify({
            turnId: randomUUID(),
            revision: session.revision,
            content: "应用",
            snapshot: { capturedAt: Date.now(), elements: [] },
          }),
        },
      );
      const events = [];
      for await (const event of readSSE(response.body!)) {
        events.push(JSON.parse(event.data));
      }
      const message = events.at(-1).message;
      expect(requests).toBe(mode === "truncated" ? 3 : 1);
      expect(message.status).toBe("failed");
      const block = message.blocks.find(
        (block: { type: string }) => block.type === "html",
      );
      const data = await new ChatHtmlStore(directory).read(
        noteId,
        session.id,
        block.ref.artifactId,
        block.ref.version,
      );
      expect(data.source).toContain("保留内容");
      expect(data.complete).toBe(mode === "prose-failed");
      expect(Boolean(block.saved)).toBe(mode === "prose-failed");
    },
  );
  it("handles every fence boundary, Chinese, nested non-HTML fences and unfinished source", () => {
    const text =
      "前言\n```js\nconst x='html';\n```\n```html\n<input id=\"中文\"><script>let x='\\\"';</script>\n```\n结尾";
    for (let split = 0; split <= text.length; split++) {
      const out: [string, string][] = [];
      const parser = new HtmlFenceStream((kind, text) =>
        out.push([kind, text]),
      );
      parser.push(text.slice(0, split));
      parser.push(text.slice(split));
      parser.finish();
      expect(out.filter(([kind]) => kind === "open")).toHaveLength(1);
      expect(out.filter(([kind]) => kind === "close")).toHaveLength(1);
      expect(
        out
          .filter(([kind]) => kind === "html")
          .map(([, text]) => text)
          .join(""),
      ).toBe('<input id="中文"><script>let x=\'\\"\';</script>\n');
      expect(
        out
          .filter(([kind]) => kind === "text")
          .map(([, text]) => text)
          .join(""),
      ).toBe("前言\n```js\nconst x='html';\n```\n结尾");
    }
  });
  it("streams ordinary prose immediately and never fabricates closing fences", () => {
    const events: string[] = [];
    const parser = new HtmlFenceStream((kind, text) =>
      events.push(`${kind}:${text}`),
    );
    parser.push("你好");
    expect(events).toEqual(["text:你好"]);
    parser.push("\n```html\n<button>未完成");
    parser.finish();
    expect(events.some((event) => event.startsWith("close:"))).toBe(false);
  });
  it("keeps immutable source and serial revision-checked independent input state", async () => {
    const { directory, noteId, session } = await fixture();
    const store = new ChatHtmlStore(directory);
    const data = {
      kind: "html" as const,
      artifactId: randomUUID(),
      version: 1,
      noteId,
      sessionId: session.id,
      title: "测试",
      source: "<button>1</button>",
      complete: true,
      revision: 0,
      state: { forms: {}, custom: {} },
      createdAt: Date.now(),
    };
    await store.write(data);
    await expect(store.write(data)).rejects.toThrow("不可覆盖");
    const saved = await store.saveState(
      noteId,
      session.id,
      data.artifactId,
      1,
      0,
      { forms: {}, custom: { count: 3 } },
    );
    expect(saved.revision).toBe(1);
    expect(saved.source).toBe(data.source);
    await expect(
      store.saveState(noteId, session.id, data.artifactId, 1, 0, data.state),
    ).rejects.toThrow("其他页面");
    await expect(
      store.read(noteId, randomUUID(), data.artifactId, 1),
    ).rejects.toThrow("不存在");
  });
  it("preserves chronological blocks, saves HTML before completion and makes one generation request", async () => {
    const { directory, noteId, session } = await fixture();
    let requests = 0;
    const transport: typeof fetch = async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(true);
      expect(body.max_tokens).toBe(32768);
      const parts = [
        { reasoning_content: "先分析" },
        { content: "说明\n```html\n" },
        {
          content:
            "<button id='b'>你好</button><script>document.getElementById('b').onclick=()=>NoteApp.set('n',1)</script>\n",
        },
        { content: "```\n" },
        { reasoning_content: "再检查" },
        { content: "完成" },
      ];
      return new Response(
        `${parts
          .map(
            (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`,
          )
          .join("")}data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    };
    const service = await createChatService(
      directory,
      { baseUrl: "http://fixture/v1", model: "qwen3.8-27b" },
      transport,
    );
    cleanup.push(service.close);
    const server = createServer((req, res) => {
      void service.handle(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const base = `http://127.0.0.1:${
      (server.address() as { port: number }).port
    }`;
    const response = await fetch(
      `${base}/api/notes/${noteId}/chats/${session.id}/turns`,
      {
        method: "POST",
        body: JSON.stringify({
          turnId: randomUUID(),
          revision: session.revision,
          content: "生成一个按钮",
          snapshot: { capturedAt: Date.now(), elements: [] },
        }),
      },
    );
    const events = [];
    for await (const event of readSSE(response.body!)) {
      events.push(JSON.parse(event.data));
    }
    expect(requests).toBe(1);
    const message = events.at(-1).message;
    expect(message.status).toBe("complete");
    expect(message.blocks.map((block: { type: string }) => block.type)).toEqual(
      ["reasoning", "text", "html", "reasoning", "text"],
    );
    const block = message.blocks.find(
      (block: { type: string }) => block.type === "html",
    );
    expect(block.saved).toBe(true);
    expect(block.source).toBeUndefined();
    const artifact = await new ChatHtmlStore(directory).read(
      noteId,
      session.id,
      block.ref.artifactId,
      1,
    );
    expect(artifact.complete).toBe(true);
    expect(artifact.source).toContain("<button");
    const restored = await new ChatStore(directory).read(noteId, session.id);
    expect(restored.messages.at(-1)?.blocks).toEqual(message.blocks);
  });
});

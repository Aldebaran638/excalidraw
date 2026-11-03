import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatStore } from "../server/chatStore";
import { createChatService } from "../server/chat";
import { createNoteService } from "../server/notes";
import { sanitizeSnapshot, readNoteTool } from "../server/chatTools";
import { readSSE } from "../data/sse";

import type { ChatEvent, ChatSession } from "../data/chatTypes";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
const fixture = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-chat-test-"));
  cleanups.push(() => fs.rm(dir, { recursive: true }));
  const noteId = randomUUID();
  await fs.writeFile(
    path.join(dir, "a.excalidraw"),
    JSON.stringify({
      type: "excalidraw",
      elements: [],
      repositoryMetadata: { version: 1, noteId },
    }),
  );
  return { dir, noteId };
};
const serve = async (
  handle: Awaited<ReturnType<typeof createChatService>>["handle"],
) => {
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const stream = (chunks: unknown[]) => {
  const bytes = new TextEncoder().encode(
    `${chunks
      .map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`)
      .join("")}data: [DONE]\r\n\r\n`,
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) {
          controller.enqueue(bytes.slice(i, i + 3));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
};
const choice = (delta: object, finish_reason: string | null = null) => ({
  choices: [{ delta, finish_reason }],
});
describe("note-owned chat", () => {
  it.each(["ENOENT", "ENODATA", "EBUSY", "EIO"])(
    "retries transient %s reads without recreating sessions or hiding a real deletion",
    async (code) => {
      const { dir, noteId } = await fixture();
      const store = new ChatStore(dir);
      const original = await store.create(noteId);
      const read = vi
        .spyOn(fs, "readFile")
        .mockRejectedValueOnce(Object.assign(new Error("transient"), { code }));
      try {
        expect((await store.read(noteId, original.id)).id).toBe(original.id);
        expect(read).toHaveBeenCalledTimes(2);
      } finally {
        read.mockRestore();
      }
      const filename = path.join(dir, ".chats", noteId, `${original.id}.json`);
      await fs.unlink(filename);
      await expect(store.read(noteId, original.id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(fs.access(filename)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  it("edits and regenerates historical questions without losing the original conversation", async () => {
    const { dir, noteId } = await fixture();
    const inputs: string[] = [];
    const transport: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.max_tokens).toBe(32768);
      inputs.push(JSON.stringify(request.messages));
      return stream([
        choice({ content: `answer-${inputs.length}` }),
        choice({}, "stop"),
      ]);
    };
    const service = await createChatService(
      dir,
      { baseUrl: "http://fixture", model: "qwen" },
      transport,
    );
    cleanups.push(service.close);
    const base = `${await serve(service.handle)}/api/notes/${noteId}/chats`;
    let session = (await (
      await fetch(base, { method: "POST" })
    ).json()) as ChatSession;
    const send = async (
      content: string,
      replaceMessageId?: string,
      revision = session.revision,
    ) => {
      const response = await fetch(`${base}/${session.id}/turns`, {
        method: "POST",
        body: JSON.stringify({
          turnId: randomUUID(),
          content,
          replaceMessageId,
          revision,
          snapshot: { capturedAt: Date.now(), elements: [] },
        }),
      });
      if (!response.ok) {
        return response.status;
      }
      for await (const frame of readSSE(response.body!)) {
        const event = JSON.parse(frame.data) as ChatEvent;
        if (event.session) {
          session = event.session;
        }
      }
      return response.status;
    };
    await send("original-question");
    const originalQuestion = session.messages[0];
    await send("later-question");
    const original = structuredClone(session.messages);
    expect(await send("edited-question", originalQuestion.id, 0)).toBe(409);
    expect(await send("edited-question", randomUUID())).toBe(400);
    expect(await send("edited-question", originalQuestion.id)).toBe(200);
    expect(session.messages.map((m) => m.content)).toEqual([
      "edited-question",
      "answer-3",
    ]);
    expect(session.previousVersions?.[0].messages).toEqual(original);
    expect(inputs.at(-1)).not.toContain("later-question");
    expect(inputs.at(-1)).not.toContain("original-question");
    const edited = structuredClone(session.messages);
    await send("edited-question", session.messages[0].id);
    expect(session.messages.map((m) => m.content)).toEqual([
      "edited-question",
      "answer-4",
    ]);
    expect(session.previousVersions?.[1].messages).toEqual(edited);
    const stored = await new ChatStore(dir).read(noteId, session.id);
    expect(stored.previousVersions).toEqual(session.previousVersions);
    expect(await new ChatStore(dir).list(noteId)).not.toHaveProperty(
      "0.previousVersions",
    );
    expect(inputs).toHaveLength(4);
  });
  it.each([false, true])(
    "forwards thinking=%s and streams reasoning separately from answers",
    async (thinking) => {
      const { dir, noteId } = await fixture();
      const transport = vi.fn(async (_url, options) => {
        const request = JSON.parse(options!.body as string);
        expect(request.chat_template_kwargs.enable_thinking).toBe(thinking);
        return stream([
          ...(thinking
            ? [
                choice({ reasoning_content: "计算步骤" }),
                choice({ reasoning_content: "已完成" }),
              ]
            : []),
          choice({ content: "结果391" }),
          choice({}, "stop"),
        ]);
      }) as typeof fetch;
      const service = await createChatService(
        dir,
        { baseUrl: "http://fixture", model: "qwen3.8-27b" },
        transport,
      );
      cleanups.push(service.close);
      const base = `${await serve(service.handle)}/api/notes/${noteId}/chats`;
      const session = (await (
        await fetch(base, { method: "POST" })
      ).json()) as ChatSession;
      const response = await fetch(`${base}/${session.id}/turns`, {
        method: "POST",
        body: JSON.stringify({
          turnId: randomUUID(),
          content: "17乘23",
          revision: 0,
          thinking,
          snapshot: { capturedAt: Date.now(), elements: [] },
        }),
      });
      const events: ChatEvent[] = [];
      for await (const frame of readSSE(response.body!)) {
        events.push(JSON.parse(frame.data));
      }
      expect(
        events
          .filter((event) => event.type === "delta")
          .map((event) => event.delta)
          .join(""),
      ).toBe("结果391");
      expect(
        events
          .filter((event) => event.type === "reasoning")
          .map((event) => event.delta)
          .join(""),
      ).toBe(thinking ? "计算步骤已完成" : "");
      const stored = (await (
        await fetch(`${base}/${session.id}`)
      ).json()) as ChatSession;
      expect(stored.messages[1].thinking).toBe(thinking);
      expect(stored.messages[1].reasoning || "").toBe(
        thinking ? "计算步骤已完成" : "",
      );
      expect(stored.messages[1].content).toBe("结果391");
      expect(events.at(-1)?.saved).toBe(true);
      const invalid = await fetch(`${base}/${session.id}/turns`, {
        method: "POST",
        body: JSON.stringify({
          turnId: randomUUID(),
          content: "再算一次",
          revision: stored.revision,
          thinking: "true",
          snapshot: { capturedAt: Date.now(), elements: [] },
        }),
      });
      expect(invalid.status).toBe(400);
    },
  );
  it("parses split Chinese UTF-8 and CRLF SSE frames", async () => {
    const events = [];
    for await (const event of readSSE(
      stream([choice({ content: "中文流式" })]).body!,
    )) {
      events.push(event.data);
    }
    expect(JSON.parse(events[0]).choices[0].delta.content).toBe("中文流式");
    expect(events.at(-1)).toBe("[DONE]");
  });
  it("keeps sessions through rename, rejects duplicate note identity and recovers interrupted answers", async () => {
    const { dir, noteId } = await fixture();
    const store = new ChatStore(dir);
    const session = await store.create(noteId);
    await fs.rename(
      path.join(dir, "a.excalidraw"),
      path.join(dir, "renamed.excalidraw"),
    );
    expect(await store.assertNote(noteId)).toBe("renamed.excalidraw");
    await store.update(noteId, session.id, (current) =>
      current.messages.push({
        id: randomUUID(),
        turnId: randomUUID(),
        role: "assistant",
        content: "已生成部分",
        createdAt: Date.now(),
        status: "generating",
      }),
    );
    await new ChatStore(dir).recover();
    expect((await store.read(noteId, session.id)).messages[0].status).toBe(
      "interrupted",
    );
    await fs.copyFile(
      path.join(dir, "renamed.excalidraw"),
      path.join(dir, "copy.excalidraw"),
    );
    await expect(store.assertNote(noteId)).rejects.toThrow("复制笔记");
    expect(await store.list(noteId)).toHaveLength(1);
  });
  it("reads only requested current snapshot data and never sends the full note by default", async () => {
    const { dir, noteId } = await fixture();
    let calls = 0;
    const transport = vi.fn(async (_url, options) => {
      const body = JSON.parse(options!.body as string);
      expect(body.chat_template_kwargs.enable_thinking).toBe(false);
      if (++calls === 1) {
        expect(JSON.stringify(body.messages)).not.toContain("未保存的答案42");
        return stream([
          choice({
            tool_calls: [
              {
                index: 0,
                id: "call_read",
                function: { name: "read_note_elements", arguments: '{"ids":' },
              },
            ],
          }),
          choice({
            tool_calls: [
              { index: 0, function: { arguments: '["text-current"]}' } },
            ],
          }),
          choice({}, "tool_calls"),
        ]);
      }
      expect(body.messages.at(-1).role).toBe("tool");
      expect(body.messages.at(-1).content).toContain("未保存的答案42");
      expect(body.messages.at(-1).content).not.toContain("image-data");
      return stream([
        choice({ content: "当前答案" }),
        choice({ content: "是42。" }),
        choice({}, "stop"),
      ]);
    }) as typeof fetch;
    const service = await createChatService(
      dir,
      { baseUrl: "http://fixture/v1", model: "qwen3.8-27b" },
      transport,
    );
    cleanups.push(service.close);
    const base = `${await serve(service.handle)}/api/notes/${noteId}/chats`;
    const session = (await (
      await fetch(base, { method: "POST" })
    ).json()) as ChatSession;
    const turnId = randomUUID();
    const body = {
      turnId,
      content: "答案是什么？",
      revision: 0,
      snapshot: {
        capturedAt: Date.now(),
        elements: [
          {
            id: "text-current",
            type: "text",
            text: "未保存的答案42",
            file: "image-data",
          },
        ],
      },
    };
    const response = await fetch(`${base}/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const events: ChatEvent[] = [];
    for await (const event of readSSE(response.body!)) {
      events.push(JSON.parse(event.data));
    }
    expect(events.map((event) => event.type)).toContain("tool_end");
    expect(events.at(-1)?.saved).toBe(true);
    const stored = (await (
      await fetch(`${base}/${session.id}`)
    ).json()) as ChatSession;
    expect(stored.messages).toHaveLength(2);
    expect(stored.messages[1].content).toBe("当前答案是42。");
    expect(stored.messages[1].activities?.[0].elementIds).toEqual([
      "text-current",
    ]);
    const duplicate = await fetch(`${base}/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect((await duplicate.json()).duplicate).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
    expect((await fs.readdir(path.join(dir, ".chats", noteId))).sort()).toEqual(
      [`${session.id}.json`, "index.json", "agent-logs"].sort(),
    );
  });
  it("preserves failed answers and retries without duplicating the user message", async () => {
    const { dir, noteId } = await fixture();
    let calls = 0;
    const transport = vi.fn(async () =>
      ++calls <= 3
        ? new Response("offline", { status: 503 })
        : stream([choice({ content: "重试成功" }), choice({}, "stop")]),
    ) as typeof fetch;
    const service = await createChatService(
      dir,
      { baseUrl: "http://fixture", model: "fixture" },
      transport,
    );
    cleanups.push(service.close);
    const base = `${await serve(service.handle)}/api/notes/${noteId}/chats`;
    const session = (await (
      await fetch(base, { method: "POST" })
    ).json()) as ChatSession;
    const send = async (revision: number, retryMessageId?: string) => {
      const response = await fetch(`${base}/${session.id}/turns`, {
        method: "POST",
        body: JSON.stringify({
          turnId: randomUUID(),
          content: "你好",
          revision,
          retryMessageId,
          snapshot: { capturedAt: Date.now(), elements: [] },
        }),
      });
      await response.text();
      return (await (
        await fetch(`${base}/${session.id}`)
      ).json()) as ChatSession;
    };
    const failed = await send(0);
    expect(failed.messages[1].status).toBe("failed");
    const retried = await send(failed.revision, failed.messages[0].id);
    expect(
      retried.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(retried.messages.at(-1)?.content).toBe("重试成功");
  });
  it("rejects path access, foreign elements and preserves only safe snapshot fields", () => {
    const snapshot = sanitizeSnapshot({
      capturedAt: 1,
      elements: [
        {
          id: "a",
          type: "image",
          fileId: "secret",
          link: "http://secret",
          customData: { embeddable: { snapshot: "raw html" } },
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|raw html/);
    expect(() =>
      readNoteTool(snapshot, "get_note_outline", { path: "../other" }),
    ).toThrow("不能指定路径");
    expect(() =>
      readNoteTool(snapshot, "read_note_elements", { ids: ["foreign"] }),
    ).toThrow("不属于当前");
    expect(() => readNoteTool(snapshot, "execute", {})).toThrow("未授权");
  });
  it("pages large escaped definitions within the actual serialized result budget", () => {
    const snapshot = sanitizeSnapshot({
      capturedAt: 1,
      elements: [{ id: "large", type: "text", text: '"\\'.repeat(20000) }],
    });
    const page = readNoteTool(
      snapshot,
      "read_note_elements",
      { ids: ["large"] },
      800,
    );
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(800);
    expect(page.nextCursor).toBeGreaterThan(0);
    const next = readNoteTool(
      snapshot,
      "read_note_elements",
      { ids: ["large"], cursor: page.nextCursor },
      800,
    );
    expect(next.nextCursor).toBeGreaterThan(Number(page.nextCursor));
  });
  it("locks in-flight sessions and persists a stopped partial answer", async () => {
    const { dir, noteId } = await fixture();
    const transport = vi.fn(
      async (_url, options) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify(
                    choice({ content: "保留这部分" }),
                  )}\n\n`,
                ),
              );
              options!.signal!.addEventListener(
                "abort",
                () => controller.error(options!.signal!.reason),
                { once: true },
              );
            },
          }),
        ),
    ) as typeof fetch;
    const service = await createChatService(
      dir,
      { baseUrl: "http://fixture", model: "fixture" },
      transport,
    );
    cleanups.push(service.close);
    const base = `${await serve(service.handle)}/api/notes/${noteId}/chats`;
    const session = (await (
      await fetch(base, { method: "POST" })
    ).json()) as ChatSession;
    const turnId = randomUUID();
    const payload = {
      turnId,
      content: "请回答",
      revision: 0,
      snapshot: { capturedAt: Date.now(), elements: [] },
    };
    const response = await fetch(`${base}/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const consume = response.text();
    expect(
      (
        await fetch(`${base}/${session.id}/turns`, {
          method: "POST",
          body: JSON.stringify({ ...payload, turnId: randomUUID() }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(`${base}/${session.id}/turns/${turnId}/stop`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    await consume;
    const stored = (await (
      await fetch(`${base}/${session.id}`)
    ).json()) as ChatSession;
    expect(stored.messages.at(-1)?.status).toBe("stopped");
    expect(stored.messages.at(-1)?.content).toBe("保留这部分");
  });
  it("keeps metadata on old-client writes and refuses a copied identity", async () => {
    const { dir, noteId } = await fixture();
    const notes = await createNoteService(dir);
    cleanups.push(notes.close);
    const base = await serve(notes.handle);
    const plain = { type: "excalidraw", elements: [] };
    expect(
      (
        await fetch(`${base}/api/notes/a.excalidraw`, {
          method: "PUT",
          body: JSON.stringify(plain),
        })
      ).status,
    ).toBe(200);
    expect(
      JSON.parse(await fs.readFile(path.join(dir, "a.excalidraw"), "utf8"))
        .repositoryMetadata.noteId,
    ).toBe(noteId);
    expect(
      (
        await fetch(`${base}/api/notes/b.excalidraw`, {
          method: "PUT",
          body: JSON.stringify({
            ...plain,
            repositoryMetadata: { version: 1, noteId },
          }),
        })
      ).status,
    ).toBe(409);
  });
});

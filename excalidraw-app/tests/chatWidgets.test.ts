import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXAMPLES } from "../../packages/interactive-widgets/examples";
import { createChatService } from "../server/agent/chat";
import { ChatStore } from "../server/chatStore";
import { ChatArtifactStore } from "../server/agent/chatArtifacts";
import { readSSE } from "../data/sse";

import type { ChatEvent, ChatSession } from "../data/chatTypes";
import type { ChatWidgetData } from "../data/chatWidgets";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
const fixture = async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "excalidraw-chat-artifacts-"),
  );
  cleanups.push(() => fs.rm(directory, { recursive: true }));
  const noteId = randomUUID();
  await fs.writeFile(
    path.join(directory, "a.excalidraw"),
    JSON.stringify({
      type: "excalidraw",
      elements: [],
      repositoryMetadata: { version: 1, noteId },
    }),
  );
  const session = await new ChatStore(directory).create(noteId);
  return { directory, noteId, session };
};
const doc = () => ({
  version: 2 as const,
  catalogVersion: 2 as const,
  definition: { ...EXAMPLES.calculator, version: 2 as const },
  state: { ...EXAMPLES.calculator.initialState },
  prompt: "生成计算器",
});
const stream = (delta: object, finish = "stop") =>
  new Response(
    `data: ${JSON.stringify({
      choices: [{ delta, finish_reason: finish }],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
const serve = async (directory: string, transport: typeof fetch) => {
  const service = await createChatService(
    directory,
    { baseUrl: "http://fixture/v1", model: "qwen3.8-27b" },
    transport,
  );
  cleanups.push(service.close);
  const server = createServer((req, res) => {
    void service.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
describe("chat widget drafts", () => {
  it("keeps immutable definitions, version branches, idempotency, isolated trial state and revision conflicts", async () => {
    const { directory, noteId, session } = await fixture();
    const store = new ChatArtifactStore(directory);
    const first = await store.create({
      noteId,
      sessionId: session.id,
      document: doc(),
      region: { width: 700, height: 480 },
      turnId: randomUUID(),
      toolCallId: "create",
      summary: "新作品",
    });
    const request = {
      ...first,
      document: {
        ...doc(),
        definition: { ...doc().definition, title: "乘法" },
      },
      parentVersion: 1,
      turnId: randomUUID(),
      toolCallId: "revise",
    };
    const [second, duplicate] = await Promise.all([
      store.create(request),
      store.create(request),
    ]);
    expect(second.version).toBe(2);
    expect(duplicate.version).toBe(2);
    expect(
      (await store.read(noteId, session.id, first.artifactId, 1)).document
        .definition.title,
    ).toBe("通用计算器");
    await store.saveState(noteId, session.id, first.artifactId, 1, 0, {
      ...doc().state,
      a: 42,
    });
    await expect(
      store.saveState(noteId, session.id, first.artifactId, 1, 0, doc().state),
    ).rejects.toThrow("其他页面");
    expect(
      (await store.read(noteId, session.id, first.artifactId, 2)).document.state
        .a,
    ).toBe(3);
    await expect(
      store.read(noteId, randomUUID(), first.artifactId, 1),
    ).rejects.toThrow("不存在");
    const branched = await store.create({
      ...request,
      parentVersion: 1,
      turnId: randomUUID(),
      toolCallId: "branch",
    });
    expect(branched.version).toBe(3);
    expect(branched.parentVersion).toBe(1);
  });
  it("creates then revises saved drafts through tools without changing the note or leaking definitions into chat history", async () => {
    const { directory, noteId, session } = await fixture();
    let generated = 0;
    const transport = vi.fn(async (_url, options) => {
      const request = JSON.parse(options!.body as string);
      if (
        !request.stream ||
        request.messages[0].content.startsWith("You design interactive widgets")
      ) {
        generated++;
        expect(request.chat_template_kwargs.enable_thinking).toBe(true);
        if (generated === 2) {
          expect(JSON.parse(request.messages[1].content).currentState.a).toBe(
            71,
          );
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ...doc().definition,
                    title: generated === 1 ? "作品一" : "作品二",
                  }),
                },
              },
            ],
          }),
        );
      }
      if (request.messages.at(-1).role === "tool") {
        expect(request.tool_choice).toBeUndefined();
        expect(request.messages.at(-1).content.length).toBeLessThan(1500);
        return stream({ content: "请试用后手动导入。" });
      }
      return stream(
        {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              function: {
                name:
                  generated === 0
                    ? "create_widget_draft"
                    : "revise_widget_draft",
                arguments: JSON.stringify({ prompt: "按要求调整计算器" }),
              },
            },
          ],
        },
        "tool_calls",
      );
    }) as typeof fetch;
    const base = `${await serve(
      directory,
      transport,
    )}/api/notes/${noteId}/chats/${session.id}`;
    const snapshot = { capturedAt: Date.now(), elements: [] };
    const send = async (
      revision: number,
      workspace?: object,
      workspaceState?: object,
    ) => {
      const response = await fetch(`${base}/turns`, {
        method: "POST",
        body: JSON.stringify({
          turnId: randomUUID(),
          content: workspace
            ? "请调用 revise_widget_draft 修改组件"
            : "请调用 create_widget_draft 生成组件",
          revision,
          thinking: true,
          snapshot,
          workspace,
          workspaceState,
        }),
      });
      const events: ChatEvent[] = [];
      for await (const frame of readSSE(response.body!)) {
        events.push(JSON.parse(frame.data));
      }
      expect(events.at(-1)?.saved).toBe(true);
      return events;
    };
    const events = await send(0);
    const ref = events.find((event) => event.type === "widget_ready")!
      .artifact!;
    expect(events.some((event) => event.type === "widget_start")).toBe(true);
    let stored: ChatSession = await (await fetch(base)).json();
    expect(stored.messages[1].artifacts).toEqual([ref]);
    const data: ChatWidgetData = await (
      await fetch(`${base}/artifacts/${ref.artifactId}?version=1`)
    ).json();
    expect(data.document.definition.title).toBe("作品一");
    const updated = await send(
      stored.revision,
      { kind: "artifact", artifactId: ref.artifactId, version: 1 },
      { ...doc().state, a: 71 },
    );
    const nextRef = updated.find((event) => event.type === "widget_ready")!
      .artifact!;
    expect(nextRef.artifactId).toBe(ref.artifactId);
    expect(nextRef.version).toBe(2);
    expect(
      JSON.parse(
        await fs.readFile(path.join(directory, "a.excalidraw"), "utf8"),
      ).elements,
    ).toEqual([]);
    expect(
      (
        await fetch(`${base}/artifacts/${ref.artifactId}?version=1`, {
          method: "PATCH",
          body: JSON.stringify({ revision: 9, state: doc().state }),
        })
      ).status,
    ).toBe(409);
    stored = await (await fetch(base)).json();
    expect(stored.messages).toHaveLength(4);
    expect(
      vi
        .mocked(transport)
        .mock.calls.every(([, options]) =>
          JSON.parse(options!.body as string).messages[0].content.startsWith(
            "You design interactive widgets",
          ),
        ),
    ).toBe(true);
  });
  it("allows a same-turn retry after invalid output and its automatic repair both fail", async () => {
    const { directory, noteId, session } = await fixture();
    let generations = 0;
    let toolRounds = 0;
    const transport = vi.fn(async (_url, options) => {
      const request = JSON.parse(options!.body as string);
      if (
        !request.stream ||
        request.messages[0].content.startsWith("You design interactive widgets")
      ) {
        generations++;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    generations <= 2 ? { version: 999 } : doc().definition,
                  ),
                },
              },
            ],
          }),
        );
      }
      if (request.messages.at(-1).role === "tool") {
        const result = JSON.parse(request.messages.at(-1).content);
        if (toolRounds === 1) {
          expect(result.error).toBeTruthy();
          expect(result.retryable).toBe(true);
        } else {
          expect(result.artifact).toBeTruthy();
          return stream({ content: "组件已生成，请试用。" });
        }
      }
      toolRounds++;
      return stream(
        {
          tool_calls: [
            {
              index: 0,
              id: `retry-${toolRounds}`,
              function: {
                name: "create_widget_draft",
                arguments: JSON.stringify({ prompt: "生成计算器" }),
              },
            },
          ],
        },
        "tool_calls",
      );
    }) as typeof fetch;
    const base = `${await serve(
      directory,
      transport,
    )}/api/notes/${noteId}/chats/${session.id}`;
    const response = await fetch(`${base}/turns`, {
      method: "POST",
      body: JSON.stringify({
        turnId: randomUUID(),
        content: "生成",
        revision: 0,
        snapshot: { capturedAt: 1, elements: [] },
      }),
    });
    const events: ChatEvent[] = [];
    for await (const frame of readSSE(response.body!)) {
      events.push(JSON.parse(frame.data));
    }
    expect(generations).toBe(3);
    expect(
      events.filter((event) => event.type === "widget_error"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "widget_ready"),
    ).toHaveLength(1);
    const stored: ChatSession = await (await fetch(base)).json();
    expect(stored.messages[1].status).toBe("complete");
    expect(stored.messages[1].artifacts).toHaveLength(1);
    expect(stored.messages[1].activities?.at(-1)?.summary).toBe(
      "组件候选已生成并保存",
    );
    expect(
      JSON.parse(
        await fs.readFile(path.join(directory, "a.excalidraw"), "utf8"),
      ).elements,
    ).toEqual([]);
  });
  it("allows multiple artifacts in one turn and preserves them if the following answer fails", async () => {
    const { directory, noteId, session } = await fixture();
    let generations = 0;
    let retrying = false;
    const transport = vi.fn(async (_url, options) => {
      const request = JSON.parse(options!.body as string);
      if (retrying) {
        expect(
          request.tools.some(
            (tool: { function: { name: string } }) =>
              tool.function.name === "create_widget_draft",
          ),
        ).toBe(false);
        expect(
          request.messages.some(
            (message: { role: string; content: string }) =>
              message.role === "assistant" &&
              message.content.includes("本会话组件引用"),
          ),
        ).toBe(true);
        return stream({ content: "已有组件已保存，这里补充使用说明。" });
      }
      if (
        !request.stream ||
        request.messages[0].content.startsWith("You design interactive widgets")
      ) {
        generations++;
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify(doc().definition) } },
            ],
          }),
        );
      }
      if (request.messages.at(-1).role === "tool") {
        const results = request.messages.filter(
          (message: { role: string }) => message.role === "tool",
        );
        expect(results).toHaveLength(2);
        for (const result of results) {
          expect(JSON.parse(result.content).artifact).toBeTruthy();
        }
        return new Response("offline", { status: 503 });
      }
      return stream(
        {
          tool_calls: [0, 1].map((index) => ({
            index,
            id: `call-${index}`,
            function: {
              name: "create_widget_draft",
              arguments: JSON.stringify({ prompt: "生成计算器" }),
            },
          })),
        },
        "tool_calls",
      );
    }) as typeof fetch;
    const base = `${await serve(
      directory,
      transport,
    )}/api/notes/${noteId}/chats/${session.id}`;
    const response = await fetch(`${base}/turns`, {
      method: "POST",
      body: JSON.stringify({
        turnId: randomUUID(),
        content: "生成",
        revision: 0,
        snapshot: { capturedAt: 1, elements: [] },
      }),
    });
    const events: ChatEvent[] = [];
    for await (const frame of readSSE(response.body!)) {
      events.push(JSON.parse(frame.data));
    }
    expect(generations).toBe(2);
    expect(
      events.filter((event) => event.type === "widget_ready"),
    ).toHaveLength(2);
    expect(events.some((event) => event.type === "widget_error")).toBe(false);
    const stored: ChatSession = await (await fetch(base)).json();
    expect(stored.messages[1].status).toBe("failed");
    expect(stored.messages[1].artifacts).toHaveLength(2);
    expect(
      new Set(stored.messages[1].artifacts!.map((ref) => ref.artifactId)).size,
    ).toBe(2);
    for (const ref of stored.messages[1].artifacts!) {
      expect(
        (await fetch(`${base}/artifacts/${ref.artifactId}?version=1`)).status,
      ).toBe(200);
    }
    retrying = true;
    const retry = await fetch(`${base}/turns`, {
      method: "POST",
      body: JSON.stringify({
        turnId: randomUUID(),
        content: "生成",
        revision: stored.revision,
        retryMessageId: stored.messages[0].id,
        snapshot: { capturedAt: 2, elements: [] },
      }),
    });
    await retry.text();
    expect(generations).toBe(2);
    const retried: ChatSession = await (await fetch(base)).json();
    expect(retried.messages).toHaveLength(3);
    expect(retried.messages.at(-1)?.status).toBe("complete");
  });
  it("cancels nested generation without publishing a partial artifact", async () => {
    const { directory, noteId, session } = await fixture();
    let generating = false;
    const transport = vi.fn(async (_url, options) => {
      const request = JSON.parse(options!.body as string);
      if (
        request.stream &&
        !request.messages[0].content.startsWith(
          "You design interactive widgets",
        )
      ) {
        return stream(
          {
            tool_calls: [
              {
                index: 0,
                id: "call-stop",
                function: {
                  name: "create_widget_draft",
                  arguments: JSON.stringify({ prompt: "生成" }),
                },
              },
            ],
          },
          "tool_calls",
        );
      }
      generating = true;
      return new Promise<Response>((_resolve, reject) =>
        options!.signal!.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    }) as typeof fetch;
    const base = `${await serve(
      directory,
      transport,
    )}/api/notes/${noteId}/chats/${session.id}`;
    const turnId = randomUUID();
    const response = await fetch(`${base}/turns`, {
      method: "POST",
      body: JSON.stringify({
        turnId,
        content: "生成",
        revision: 0,
        snapshot: { capturedAt: 1, elements: [] },
      }),
    });
    const finished = response.text();
    await vi.waitFor(() => expect(generating).toBe(true));
    expect(
      (await fetch(`${base}/turns/${turnId}/stop`, { method: "POST" })).status,
    ).toBe(200);
    await finished;
    const stored: ChatSession = await (await fetch(base)).json();
    expect(stored.messages[1].status).toBe("stopped");
    expect(stored.messages[1].artifacts).toBeUndefined();
  });
  it("never publishes ready or a usable artifact if saving the generated candidate fails", async () => {
    const { directory, noteId, session } = await fixture();
    const save = vi
      .spyOn(ChatArtifactStore.prototype, "create")
      .mockRejectedValue(new Error("候选写入失败"));
    try {
      const transport = vi.fn(async (_url, options) => {
        const request = JSON.parse(options!.body as string);
        if (
          request.messages[0].content.startsWith(
            "You design interactive widgets",
          )
        ) {
          return new Response(
            JSON.stringify({
              choices: [
                { message: { content: JSON.stringify(doc().definition) } },
              ],
            }),
          );
        }
        if (request.messages.at(-1).role === "tool") {
          return stream({ content: "候选未保存，请重试。" });
        }
        return stream(
          {
            tool_calls: [
              {
                index: 0,
                id: "disk-failed",
                function: {
                  name: "create_widget_draft",
                  arguments: JSON.stringify({ prompt: "生成" }),
                },
              },
            ],
          },
          "tool_calls",
        );
      }) as typeof fetch;
      const base = `${await serve(
        directory,
        transport,
      )}/api/notes/${noteId}/chats/${session.id}`;
      const response = await fetch(`${base}/turns`, {
        method: "POST",
        body: JSON.stringify({
          turnId: randomUUID(),
          content: "生成",
          revision: 0,
          snapshot: { capturedAt: 1, elements: [] },
        }),
      });
      const events: ChatEvent[] = [];
      for await (const frame of readSSE(response.body!)) {
        events.push(JSON.parse(frame.data));
      }
      expect(events.some((event) => event.type === "widget_ready")).toBe(false);
      expect(
        events.find((event) => event.type === "widget_error")?.error,
      ).toContain("写入失败");
      expect(
        (await (await fetch(base)).json()).messages.at(-1).artifacts,
      ).toBeUndefined();
    } finally {
      save.mockRestore();
    }
  });
  it("rejects cross-session workspace and non-widget canvas targets before making an upstream request", async () => {
    const { directory, noteId, session } = await fixture();
    const transport = vi.fn() as unknown as typeof fetch;
    const base = `${await serve(
      directory,
      transport,
    )}/api/notes/${noteId}/chats/${session.id}`;
    const response = await fetch(`${base}/turns`, {
      method: "POST",
      body: JSON.stringify({
        turnId: randomUUID(),
        content: "修改",
        revision: 0,
        workspace: { kind: "element", elementId: "plain-text" },
        snapshot: {
          capturedAt: 1,
          elements: [{ id: "plain-text", type: "text", text: "不许修改" }],
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { ToolProseStream } from "../data/toolProse";
import { htmlBootstrap } from "../data/htmlRuntime";
import {
  HTML_ENVIRONMENT_GUIDE,
  HTML_THEME_TOKENS,
} from "../data/htmlEnvironment";
import { diagnoseStyles } from "../server/styleDiagnostics";
import {
  readSourcePage,
  searchSource,
  sourceErrorCode,
} from "../server/appSource";
import { validateSourceArguments } from "../server/agent/chatTools";
import { ChatStore } from "../server/chatStore";
import { ChatHtmlStore } from "../server/chatHtmlStore";
import { createChatService } from "../server/agent/chat";
import { readSSE } from "../data/sse";
import { CHAT_HEADERS } from "../data/clientProtocol";
import { previewStateKey } from "../data/appPreview";

const fake =
  "<tool_call>\n<function=edit_app_source>\n<parameter=edits>[]</parameter>\n</function>\n</tool_call>";
const source = "<!doctype html><main><h1>原版</h1><p>说明</p></main>";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});
const stream = (
  delta: any,
  finish = delta.tool_calls ? "tool_calls" : "stop",
) =>
  new Response(
    `data: ${JSON.stringify({
      choices: [{ delta }],
    })}\n\ndata: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: finish }],
    })}\n\ndata: [DONE]\n\n`,
  );
const call = (name: string, args: unknown) =>
  stream({
    tool_calls: [
      {
        index: 0,
        id: randomUUID(),
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });

async function fixture(
  respond: (request: any, index: number) => Response | Promise<Response>,
  initialSource = source,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "targeted-v2-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const noteId = randomUUID();
  await fs.writeFile(
    path.join(directory, "test.excalidraw"),
    JSON.stringify({ repositoryMetadata: { version: 1, noteId } }),
  );
  const store = new ChatStore(directory);
  let session = await store.create(noteId);
  const html = new ChatHtmlStore(directory);
  const app = await html.write({
    kind: "html",
    artifactId: randomUUID(),
    version: 1,
    title: "测试应用",
    source: initialSource,
    complete: true,
    revision: 0,
    noteId,
    sessionId: session.id,
    state: { forms: {}, custom: {} },
    createdAt: Date.now(),
  });
  const requests: any[] = [];
  const service = await createChatService(
    directory,
    { baseUrl: "http://fixture/v1", model: "fixture" },
    async (_, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      try {
        return await respond(request, requests.length - 1);
      } catch (error) {
        if (process.env.PI_TEST_DEBUG) {
          // eslint-disable-next-line no-console
          console.warn(error);
        }
        throw error;
      }
    },
  );
  const server = createServer((req, res) => {
    void service.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${
    (server.address() as { port: number }).port
  }/api/notes/${noteId}/chats/${session.id}`;
  const selection = { kind: "html", artifactId: app.artifactId, version: 1 };
  return {
    app,
    html,
    store,
    noteId,
    requests,
    session: () => session,
    select: async (value: any = selection, revision = session.revision) => {
      const response = await fetch(url, {
        method: "PATCH",
        body: JSON.stringify({
          revision,
          workspace: {
            generation: randomUUID(),
            selection: value ?? undefined,
          },
        }),
      });
      const data = await response.json();
      if (response.ok) {
        session = data;
      }
      return { status: response.status, data };
    },
    send: async (extra = {}, onEvent?: (event: any) => Promise<void>) => {
      const response = await fetch(`${url}/turns`, {
        method: "POST",
        headers: onEvent ? CHAT_HEADERS : undefined,
        body: JSON.stringify({
          turnId: randomUUID(),
          revision: session.revision,
          content: "请修改标题",
          workspace: session.appWorkspace?.selection || selection,
          workspaceGeneration: session.appWorkspace?.generation,
          snapshot: { capturedAt: Date.now(), elements: [] },
          ...extra,
        }),
      });
      const events: any[] = [];
      if (!response.ok) {
        return {
          status: response.status,
          events,
          error: await response.json(),
          message: undefined,
        };
      }
      for await (const event of readSSE(response.body!)) {
        const value = JSON.parse(event.data);
        events.push(value);
        await onEvent?.(value);
      }
      session = await store.read(noteId, session.id);
      return {
        status: response.status,
        events,
        message: session.messages.at(-1)!,
        error: undefined,
      };
    },
    url,
  };
}

describe("chat tool round limits", () => {
  it("reports incomplete tool responses separately from round exhaustion", async () => {
    const f = await fixture(() =>
      stream(
        {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              function: { name: "get_note_outline", arguments: "{}" },
            },
          ],
        },
        "stop",
      ),
    );
    const result = await f.send({ content: "解释当前应用" });
    expect(result.message?.error).toContain("模型工具响应不完整");
    expect(result.message?.activities).toHaveLength(0);
  });

  it("finishes after 100 successful rounds plus failed retries without the old 16-call cap", async () => {
    const f = await fixture((_, index) => {
      if (index < 10) {
        return call("read_app_source", { startLine: 0 });
      }
      return index < 110
        ? call("get_note_outline", {})
        : stream({ content: "完成" });
    });
    const result = await f.send({
      content: "解释当前应用",
      snapshot: {
        capturedAt: Date.now(),
        elements: [{ id: "budget-note", type: "text", text: "测试" }],
      },
    });
    expect(result.message?.status, result.message?.error).toBe("complete");
    expect(
      result.message?.activities?.filter((a) => a.status === "failed"),
    ).toHaveLength(10);
    expect(
      result.message?.activities?.filter((a) => a.status === "complete"),
    ).toHaveLength(100);
    expect(f.requests).toHaveLength(111);
  }, 30000);

  it("rejects a 101st normal round with an accurate reason", async () => {
    const f = await fixture(() => call("get_note_outline", {}));
    const result = await f.send({
      content: "解释当前笔记",
      snapshot: {
        capturedAt: Date.now(),
        elements: [{ id: "budget-note", type: "text", text: "测试" }],
      },
    });
    expect(result.message?.status).toBe("failed");
    expect(result.message?.error).toContain("100 次正常工具往返");
    expect(result.message?.activities).toHaveLength(100);
  }, 30000);

  it("bounds failures separately rather than retrying forever", async () => {
    const f = await fixture(() => call("read_app_source", { startLine: 0 }));
    const result = await f.send();
    expect(result.message?.status).toBe("failed");
    expect(result.message?.error).toContain("失败重试／恢复已达 100 次");
    expect(result.message?.activities).toHaveLength(100);
    expect(
      result.message?.activities?.every((a) => a.status === "failed"),
    ).toBe(true);
  }, 30000);
});

describe("agent automatic task completion", () => {
  it("continues the same candidate when the next turn clarifies the previous edit", async () => {
    const f = await fixture((request, index) => {
      const step = index % 3;
      const names = request.tools.map((tool: any) => tool.function.name);
      if (!step) {
        expect(names).not.toContain("edit_app_source");
        return call("read_app_source", {});
      }
      if (step === 1) {
        expect(names).toContain("edit_app_source");
        const current = JSON.parse(
          request.messages.findLast((message: any) => message.role === "tool")
            .content,
        );
        if (index > 2) {
          expect(current.source).toContain("第一候选");
        }
        return call("edit_app_source", {
          sourceHash: current.sourceHash,
          edits: [
            {
              oldText: index < 3 ? "原版" : "说明",
              newText: index < 3 ? "第一候选" : "RR与RC的业务场景对照",
            },
          ],
        });
      }
      return stream({ content: "候选已保存，等待确认。" });
    });
    await f.select();
    await f.send();
    const result = await f.send({
      content:
        "你理解错了，我说的实际使用例子指的是，一般什么业务场景使用RR，什么使用RC",
    });
    expect(result.message?.status, result.message?.error).toBe("complete");
    expect(result.message?.agentTask).toMatchObject({
      kind: "edit",
      target: { kind: "html", artifactId: f.app.artifactId },
    });
    expect(f.requests).toHaveLength(6);
    const head = await f.html.readApp(f.noteId, f.app.artifactId, 3);
    expect(head.source).toContain("第一候选");
    expect(head.source).toContain("RR与RC的业务场景对照");
    expect((await f.html.readApp(f.noteId, f.app.artifactId, 1)).source).toBe(
      source,
    );
  }, 15000);
  it("recovers the prior edit context when retrying a legacy misclassified clarification", async () => {
    const f = await fixture((request, index) => {
      if (!index) {
        return call("read_app_source", {});
      }
      if (index === 1) {
        expect(
          request.tools.some((t: any) => t.function.name === "edit_app_source"),
        ).toBe(true);
        return call("edit_app_source", {
          sourceHash: JSON.parse(
            request.messages.findLast((message: any) => message.role === "tool")
              .content,
          ).sourceHash,
          edits: [{ oldText: "说明", newText: "业务场景" }],
        });
      }
      return stream({ content: "已保存候选" });
    });
    const retryId = randomUUID();
    const clarification =
      "你理解错了，我说的是一般什么业务场景使用RR，什么使用RC";
    const previous = await f.store.update(
      f.noteId,
      f.session().id,
      (current) => {
        current.messages = [
          {
            id: randomUUID(),
            turnId: randomUUID(),
            role: "assistant",
            content: "候选已保存",
            createdAt: 1,
            status: "complete",
            blocks: [
              {
                id: "old",
                type: "html",
                ref: { kind: "html", artifactId: f.app.artifactId, version: 1 },
                saved: true,
                complete: true,
              },
            ],
          },
          {
            id: retryId,
            turnId: randomUUID(),
            role: "user",
            content: clarification,
            createdAt: 2,
            status: "complete",
          },
          {
            id: randomUUID(),
            turnId: randomUUID(),
            role: "assistant",
            content: fake,
            createdAt: 3,
            status: "complete",
            blocks: [
              { id: "fake", type: "protocol", text: fake, status: "failed" },
            ],
          },
        ];
      },
    );
    const result = await f.send({
      content: clarification,
      revision: previous.revision,
      retryMessageId: retryId,
    });
    expect(result.message?.status, result.message?.error).toBe("complete");
    expect(result.message?.agentTask?.kind).toBe("edit");
    expect(f.session().messages.filter((m) => m.role === "user")).toHaveLength(
      1,
    );
    expect(f.requests).toHaveLength(3);
  }, 15000);
  it("does not borrow a later edit task when editing an earlier question", async () => {
    const f = await fixture(() => stream({ content: "只解释，不修改。" }));
    const firstId = randomUUID();
    const previous = await f.store.update(
      f.noteId,
      f.session().id,
      (current) => {
        current.messages = [
          {
            id: firstId,
            turnId: randomUUID(),
            role: "user",
            content: "原始问题",
            createdAt: 1,
            status: "complete",
          },
          {
            id: randomUUID(),
            turnId: randomUUID(),
            role: "assistant",
            content: "已修改",
            createdAt: 2,
            status: "complete",
            agentTask: {
              kind: "edit",
              target: { kind: "html", artifactId: f.app.artifactId },
            },
          },
        ];
      },
    );
    const result = await f.send({
      content: "你理解错了，我说的是业务场景",
      revision: previous.revision,
      replaceMessageId: firstId,
    });
    expect(result.message?.agentTask?.kind).toBe("chat");
    expect(f.requests).toHaveLength(1);
    expect(f.session().previousVersions?.[0].messages).toHaveLength(2);
  });
  it("does not inherit modification intent after selecting another app", async () => {
    const f = await fixture(() =>
      stream({ content: "请明确要怎样修改这个新目标。" }),
    );
    const previous = await f.store.update(
      f.noteId,
      f.session().id,
      (current) => {
        current.messages = [
          {
            id: randomUUID(),
            turnId: randomUUID(),
            role: "assistant",
            content: "已保存",
            createdAt: 1,
            status: "complete",
            agentTask: {
              kind: "edit",
              target: { kind: "html", artifactId: "other-app" },
            },
          },
        ];
      },
    );
    const result = await f.send({
      content: "你理解错了，我说的是业务场景",
      revision: previous.revision,
    });
    expect(result.message?.agentTask?.kind).toBe("chat");
    expect(f.requests).toHaveLength(1);
    expect(result.message?.blocks?.some((b) => b.type === "html")).toBe(false);
  });
  it("keeps read-only tools and correction guidance consistent, and reports unexecuted calls as failed", async () => {
    const f = await fixture((request, index) => {
      expect(
        request.tools.some(
          (tool: any) => tool.function.name === "edit_app_source",
        ),
      ).toBe(false);
      if (!index) {
        return call("read_app_source", {});
      }
      if (index === 2) {
        expect(
          request.messages.some((message: any) =>
            JSON.stringify(message.content).includes("只读问答"),
          ),
        ).toBe(true);
        expect(
          request.messages.some((message: any) =>
            JSON.stringify(message.content).includes(
              "再真实调用 edit_app_source",
            ),
          ),
        ).toBe(false);
      }
      return stream({ content: fake });
    });
    const result = await f.send({ content: "不要修改，只解释当前应用" });
    expect(f.requests).toHaveLength(3);
    expect(result.message?.status).toBe("failed");
    expect(result.message?.error).toContain("未通过真实工具");
    expect(result.events.some((e) => e.type === "error")).toBe(true);
    expect(result.events.at(-1)?.message.status).toBe("failed");
    expect(
      result.message?.blocks?.some((b) => b.type === "html" && b.saved),
    ).toBe(false);
  });
  it("rejects a real edit call that was not authorized for a read-only question", async () => {
    const f = await fixture((request, index) => {
      if (!index) {
        return call("read_app_source", {});
      }
      if (index === 1) {
        expect(
          request.tools.some((t: any) => t.function.name === "edit_app_source"),
        ).toBe(false);
        return call("edit_app_source", {
          sourceHash: JSON.parse(
            request.messages.findLast((message: any) => message.role === "tool")
              .content,
          ).sourceHash,
          edits: [{ oldText: "原版", newText: "不该修改" }],
        });
      }
      expect(
        JSON.parse(
          request.messages.findLast((message: any) => message.role === "tool")
            .content,
        ).errorCode,
      ).toBe("protocol");
      return stream({ content: "本轮只读，原组件未修改。" });
    });
    const result = await f.send({ content: "只解释，不要修改" });
    expect(result.message?.activities?.at(-1)).toMatchObject({
      name: "edit_app_source",
      status: "failed",
      errorCode: "protocol",
    });
    expect(result.message?.blocks?.some((b) => b.type === "html")).toBe(false);
    expect((await f.html.readApp(f.noteId, f.app.artifactId, 1)).source).toBe(
      source,
    );
  });
  it("does not suggest unavailable edits when read-only source reading stalls", async () => {
    const f = await fixture((request, index) => {
      expect(
        request.tools.some(
          (tool: any) => tool.function.name === "edit_app_source",
        ),
      ).toBe(false);
      if (index < 4) {
        return call("read_app_source", {});
      }
      const result = JSON.parse(
        request.messages.findLast((message: any) => message.role === "tool")
          .content,
      );
      expect(result.error).toContain("本轮只读");
      expect(result.error).not.toContain("调用edit_app_source");
      return stream({ content: "根据已读源码说明。" });
    });
    const result = await f.send({ content: "只解释当前应用" });
    expect(result.message?.status, result.message?.error).toBe("complete");
    expect(result.message?.activities?.at(-1)?.status).toBe("failed");
    expect(f.requests).toHaveLength(5);
  });
  it("does not finish after a read when syntax repair is followed by preview repair", async () => {
    const sent = new Set<number>();
    const f = await fixture((request, index) => {
      if (index === 0) {
        return stream({
          content:
            '```html\n<main id="app"><p>十四</p></main><script>const n=3RC;</script>\n```',
        });
      }
      if (index === 1 || index === 3) {
        return call("read_app_source", {});
      }
      if (index === 2 || index === 4) {
        return call("edit_app_source", {
          sourceHash: JSON.parse(
            request.messages.filter((m: any) => m.role === "tool").at(-1)
              .content,
          ).sourceHash,
          edits: [
            index === 2
              ? { oldText: "3RC", newText: '"3RC"' }
              : { oldText: "十四", newText: "十六" },
          ],
        });
      }
      throw new Error("unexpected model round");
    });
    const result = await f.send(
      { content: "生成至少16个可点击节点的应用", workspace: undefined },
      async (event) => {
        const block = event.block;
        if (
          block?.type !== "html" ||
          !block.saved ||
          sent.has(block.ref.version)
        ) {
          return;
        }
        sent.add(block.ref.version);
        await fetch(`${f.url}/turns/${event.turnId}/preview`, {
          method: "POST",
          body: JSON.stringify({
            ref: block.ref,
            report: {
              ids: ["app"],
              nodes: block.ref.version === 2 ? 14 : 16,
              relations: 20,
              errors: [],
            },
          }),
        });
      },
    );
    expect(result.message?.status, result.message?.error).toBe("complete");
    expect(result.message?.activities?.map((a) => a.name)).toEqual([
      "read_app_source",
      "edit_app_source",
      "read_app_source",
      "edit_app_source",
    ]);
    expect(
      result.message?.blocks?.findLast((b) => b.type === "html"),
    ).toMatchObject({ ref: { version: 3 }, preview: { status: "checked" } });
    expect(f.requests).toHaveLength(5);
  });

  it("allows hash-bound range edits only after all changed lines have been read", async () => {
    const initial =
      "<!doctype html>\n<main>\n<h1>原版</h1>\n<p>保留说明</p>\n</main>";
    let hash = "";
    const f = await fixture((request, index) => {
      if (index === 0) {
        return call("read_app_source", { startLine: 1, lineCount: 1 });
      }
      if (index === 1) {
        hash = JSON.parse(
          request.messages.filter((m: any) => m.role === "tool").at(-1).content,
        ).sourceHash;
        return call("edit_app_source", {
          sourceHash: hash,
          edits: [{ startLine: 3, endLine: 3, newText: "<h1>新版</h1>" }],
        });
      }
      if (index === 2) {
        expect(
          JSON.parse(
            request.messages.findLast((message: any) => message.role === "tool")
              .content,
          ),
        ).toMatchObject({
          errorCode: "version_conflict",
        });
        return call("read_app_source", { startLine: 3, lineCount: 1 });
      }
      if (index === 3) {
        return call("edit_app_source", {
          sourceHash: hash,
          edits: [{ startLine: 3, endLine: 3, newText: "<h1>新版</h1>" }],
        });
      }
      return stream({ content: "候选已保存。" });
    }, initial);
    const result = await f.send();
    expect(result.message?.status, result.message?.error).toBe("complete");
    expect(result.message?.activities?.map((a) => a.status)).toEqual([
      "complete",
      "failed",
      "complete",
      "complete",
    ]);
    const block = result.message?.blocks?.findLast((b) => b.type === "html");
    expect(block?.type).toBe("html");
    if (block?.type !== "html") {
      throw new Error("missing candidate");
    }
    const candidate = await f.html.read(
      f.noteId,
      f.session().id,
      block.ref.artifactId,
      block.ref.version,
    );
    expect(candidate.source).toBe(initial.replace("原版", "新版"));
    expect(
      (await f.html.read(f.noteId, f.session().id, f.app.artifactId, 1)).source,
    ).toBe(initial);
  });

  it("uses real preview feedback to repair the same card through source tools", async () => {
    const f = await fixture((request, index) => {
      if (index === 0) {
        return stream({
          content: '```html\n<main id="app"><p>十四</p></main>\n```',
        });
      }
      if (index === 1) {
        return call("read_app_source", {});
      }
      if (index === 2) {
        return call("edit_app_source", {
          sourceHash: JSON.parse(
            request.messages.filter((m: any) => m.role === "tool").at(-1)
              .content,
          ).sourceHash,
          edits: [{ oldText: "十四", newText: "十六" }],
        });
      }
      return stream({ content: "已保存修正后的作品。" });
    });
    const sent = new Set<string>();
    const result = await f.send(
      { content: "生成至少16个可点击节点的架构图应用", workspace: undefined },
      async (event) => {
        const block = event.block;
        if (
          block?.type !== "html" ||
          !block.saved ||
          sent.has(`${block.ref.version}`)
        ) {
          return;
        }
        sent.add(`${block.ref.version}`);
        const response = await fetch(`${f.url}/turns/${event.turnId}/preview`, {
          method: "POST",
          body: JSON.stringify({
            ref: block.ref,
            report: {
              ids: ["app"],
              nodes: block.ref.version === 1 ? 14 : 16,
              relations: 20,
              errors: [],
            },
          }),
        });
        expect(response.status).toBe(200);
      },
    );
    expect(result.message?.status, result.message?.error).toBe("complete");
    const blocks =
      result.message?.blocks?.filter((b) => b.type === "html") || [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      saved: true,
      ref: { version: 2 },
      preview: { status: "checked" },
    });
    expect(result.message?.activities?.map((a) => a.name)).toEqual([
      "read_app_source",
      "edit_app_source",
    ]);
  });
  it("restores omitted original nodes and title from a read-only baseline in the same turn", async () => {
    const initial =
      '<main><h1 id="app-title">原版</h1><button data-node="old">old</button></main>';
    const review = '<button data-node="review">review</button>';
    const old = '<button data-node="old">old</button>';
    const f = await fixture((request, index) => {
      if (index === 0 || index === 5) {
        return call("read_app_source", {});
      }
      if (index === 1) {
        return call("edit_app_source", {
          sourceHash: JSON.parse(
            request.messages.findLast((message: any) => message.role === "tool")
              .content,
          ).sourceHash,
          edits: [{ oldText: old, newText: review }],
        });
      }
      if (index === 2) {
        return stream({ content: "修改已经完成。" });
      }
      if (index === 3) {
        return call("search_app_source", {
          query: "data-node",
          revision: "baseline",
        });
      }
      if (index === 4) {
        expect(
          JSON.parse(
            request.messages.findLast((message: any) => message.role === "tool")
              .content,
          ),
        ).toMatchObject({
          readonly: true,
          revision: "baseline",
        });
        return call("read_app_source", { revision: "baseline" });
      }
      if (index === 6) {
        return call("edit_app_source", {
          sourceHash: JSON.parse(
            request.messages.findLast((message: any) => message.role === "tool")
              .content,
          ).sourceHash,
          edits: [
            { oldText: "原版", newText: "新版" },
            { oldText: review, newText: old + review },
          ],
        });
      }
      return stream({ content: "修正候选已保存。" });
    }, initial);
    await f.select();
    const sent = new Set<number>();
    const result = await f.send(
      {
        content: "标题改为“新版”；新增data-node=review，保留全部原节点与交互。",
        workspacePreview: {
          ref: { artifactId: f.app.artifactId, version: 1 },
          report: {
            ids: ["app-title"],
            title: "原版",
            nodes: 1,
            nodeKeys: ["old"],
            relations: 0,
            errors: [],
            stateKey: previewStateKey(f.app.state),
          },
        },
      },
      async (event) => {
        const block = event.block;
        if (
          block?.type !== "html" ||
          !block.saved ||
          sent.has(block.ref.version)
        ) {
          return;
        }
        sent.add(block.ref.version);
        const repaired = block.ref.version >= 3;
        const response = await fetch(`${f.url}/turns/${event.turnId}/preview`, {
          method: "POST",
          body: JSON.stringify({
            ref: block.ref,
            report: {
              ids: ["app-title"],
              title: repaired ? "新版" : "原版",
              nodes: repaired ? 2 : 1,
              nodeKeys: repaired ? ["old", "review"] : ["review"],
              relations: 1,
              errors: [],
            },
          }),
        });
        expect(response.status).toBe(200);
      },
    );
    expect(result.message?.status, result.message?.error).toBe("complete");
    const blocks =
      result.message?.blocks?.filter((b) => b.type === "html") || [];
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block.type !== "html") {
      throw new Error("missing candidate");
    }
    expect(block.preview?.status).toBe("checked");
    const saved = await f.html.read(
      f.noteId,
      f.session().id,
      block.ref.artifactId,
      block.ref.version,
    );
    expect(saved.source).toBe(
      initial.replace("原版", "新版").replace(old, old + review),
    );
    expect(
      (await f.html.read(f.noteId, f.session().id, f.app.artifactId, 1)).source,
    ).toBe(initial);
    expect(
      f.requests[5].tools.some(
        (tool: any) => tool.function.name === "edit_app_source",
      ),
    ).toBe(false);
  });
  it("recovers a missing application without asking the user to resend", async () => {
    const f = await fixture((_, index) =>
      stream({
        content:
          index === 0
            ? "已经为你生成组件。"
            : "```html\n<main><button>试试</button></main>\n```",
      }),
    );
    const result = await f.send({
      content: "生成一个简单计数器组件",
      workspace: undefined,
    });
    expect(result.message?.status, result.message?.error).toBe("complete");
    expect(
      result.message?.blocks?.some((b) => b.type === "html" && b.saved),
    ).toBe(true);
    expect(f.requests).toHaveLength(2);
  });
  it("recovers false success after reading, then really edits the selected version", async () => {
    const f = await fixture((request, index) => {
      if (index === 0) {
        return call("read_app_source", {});
      }
      if (index === 1) {
        return stream({ content: "已成功修改标题。" });
      }
      if (index === 2) {
        const result = request.messages
          .filter((m: any) => m.role === "tool")
          .at(-1);
        return call("edit_app_source", {
          sourceHash: JSON.parse(result.content).sourceHash,
          edits: [{ oldText: "原版", newText: "真正修改" }],
        });
      }
      return stream({ content: "候选已经保存，请确认。" });
    });
    const result = await f.send();
    expect(result.message?.status, result.message?.error).toBe("complete");
    expect(
      result.message?.activities?.some(
        (a) => a.name === "edit_app_source" && a.status === "complete",
      ),
    ).toBe(true);
  });
  it("continues truncated HTML into the same card and validates the finished source", async () => {
    const f = await fixture((_, index) =>
      stream(
        {
          content:
            index === 0
              ? '```html\n<main id="app"><h1>中文'
              : "计数器</h1><button>增加</button></main>\n```",
        },
        index === 0 ? "length" : "stop",
      ),
    );
    const result = await f.send({
      content: "生成一个计数器组件",
      workspace: undefined,
    });
    const blocks =
      result.message?.blocks?.filter((b) => b.type === "html") || [];
    expect(result.message?.status, result.message?.error).toBe("complete");
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).saved).toBe(true);
    expect(f.requests).toHaveLength(2);
  });
  it("bounds no-progress recovery and never publishes a fabricated success", async () => {
    const f = await fixture(() => stream({ content: "我已经创建成功。" }));
    const result = await f.send({
      content: "生成一个计数器组件",
      workspace: undefined,
    });
    expect(result.message?.status).toBe("failed");
    expect(f.requests).toHaveLength(4);
    expect(
      result.message?.blocks?.some((b) => b.type === "html" && b.saved),
    ).toBe(false);
  });
  it("does not turn ordinary questions into automatic editing requests", async () => {
    const f = await fixture(() =>
      stream({ content: "TCP通过序号和确认实现可靠传输。" }),
    );
    const result = await f.send({ content: "解释一下TCP" });
    expect(result.message?.status, result.message?.error).toBe("complete");
    expect(f.requests).toHaveLength(1);
  });
});

describe("tool prose framing", () => {
  it("recognizes a real-shaped prose call at every split without executing it", () => {
    for (let i = 0; i <= fake.length; i++) {
      const output: string[][] = [];
      const parser = new ToolProseStream((...args) => output.push(args));
      parser.push(fake.slice(0, i));
      parser.push(fake.slice(i));
      parser.finish();
      expect(output.filter(([kind]) => kind === "protocol")).toEqual([
        ["protocol", fake],
      ]);
    }
  });
  it("does not classify fenced code, quoted calls or incomplete calls", () => {
    for (const text of [
      `\`\`\`xml\n${fake}\n\`\`\`\n`,
      `> ${fake.replaceAll("\n", "\n> ")}\n`,
      "<tool_call>unfinished",
    ]) {
      const output: string[][] = [];
      const parser = new ToolProseStream((...args) => output.push(args));
      for (const character of text) {
        parser.push(character);
      }
      parser.finish();
      expect(output.some(([kind]) => kind === "protocol")).toBe(false);
      expect(output.map(([, value]) => value).join("")).toBe(text);
    }
  });
});

describe("CSS warnings and shared environment", () => {
  it("finds direct and same-block cycles, but not inheritance or independent rules", () => {
    expect(
      diagnoseStyles("<style>main{--a:var(--a,red)}</style>")[0].code,
    ).toBe("css_variable_cycle");
    expect(
      diagnoseStyles("<style>main{--a:var(--b);--b:var(--a)}</style>"),
    ).toHaveLength(1);
    expect(
      diagnoseStyles(
        "<style>main{--local:var(--accent,red)}section{--accent:var(--local)}</style>",
      ),
    ).toHaveLength(0);
    expect(
      diagnoseStyles(
        "<style>main{--a:var(--b)}@media(max-width:500px){main{--b:var(--a)}}</style>",
      ),
    ).toHaveLength(0);
  });
  it("diagnoses inline styles, invalid syntax, and does not execute scripts", () => {
    expect(diagnoseStyles('<div style="--a:var(--a)"></div>')).toHaveLength(1);
    expect(diagnoseStyles("<style>main{color:red;</style>")[0].code).toBe(
      "css_parse",
    );
    expect(
      diagnoseStyles('<script>throw new Error("do not execute")</script>'),
    ).toEqual([]);
  });
  it("injects exactly the theme variables documented to the model", () => {
    const bootstrap = htmlBootstrap("token", { forms: {}, custom: {} }, 2);
    for (const [token, value] of Object.entries(HTML_THEME_TOKENS)) {
      expect(HTML_ENVIRONMENT_GUIDE).toContain(token);
      expect(bootstrap).toContain(`${token}:${value}`);
    }
    expect(HTML_ENVIRONMENT_GUIDE).toContain("不会跨 iframe 污染");
  });
  it("saves CSS warnings without rejecting the candidate", async () => {
    const f = await fixture(() => stream({ content: "完成" }));
    const app = await f.html.write({
      ...f.app,
      artifactId: randomUUID(),
      source: "<style>main{--accent:var(--accent)}</style><main>你好</main>",
    });
    expect(app.complete).toBe(true);
    expect(app.styleDiagnostics).toHaveLength(1);
  });
});

describe("source tool contracts", () => {
  it("rejects malformed parameters using catalog schemas", () => {
    expect(() =>
      validateSourceArguments("read_app_source", { lineCount: 201 }),
    ).toThrow();
    expect(() =>
      validateSourceArguments("search_app_source", {
        query: "标题",
        path: "/secret",
      }),
    ).toThrow();
    expect(() =>
      validateSourceArguments("edit_app_source", { edits: [] }),
    ).toThrow();
  });
  it("distinguishes bad pagination from a reading budget failure", () => {
    try {
      readSourcePage(source, 9999, 60, 1000);
    } catch (e) {
      expect(sourceErrorCode(e)).toBe("invalid_request");
    }
    try {
      readSourcePage("long line", 1, 1, 1);
    } catch (e) {
      expect(sourceErrorCode(e)).toBe("budget");
    }
    const page = readSourcePage("a\nb", 2, 60, 1000);
    expect(page.nextLine).toBeNull();
    expect(page.source).toBe("2: b");
  });
  it("searches literals with bounded pages", () => {
    const long = searchSource(
      `${"x".repeat(2000)}找到`,
      { query: "找到" },
      3000,
    );
    expect(long.matches[0].column).toBe(2000);
    expect(long.matches[0].context).toContain("找到");
    const a = searchSource(
      "标题\n[]\n标题\n标题",
      { query: "标题", limit: 1, contextLines: 0 },
      2000,
    );
    expect(a.matches[0].line).toBe(1);
    expect(a.nextCursor).toBe(2);
    expect(
      searchSource("标题\n[]", { query: "[]" }, 2000).matches[0].line,
    ).toBe(2);
  });
});

describe("authoritative editing and workspaces", () => {
  it("steers three identical reads into a real edit instead of exhausting 100 recovery rounds", async () => {
    const f = await fixture((request, index) => {
      if (index < 3) {
        return call("read_app_source", { startLine: 1, lineCount: 60 });
      }
      if (index === 3) {
        const names = request.tools.map((tool: any) => tool.function.name);
        expect(names).toContain("edit_app_source");
        expect(names).toContain("search_app_source");
        expect(names).not.toContain("read_app_source");
        expect(
          request.messages.some((message: any) =>
            JSON.stringify(message.content).includes("连续三次"),
          ),
        ).toBe(true);
        const result = request.messages.findLast(
          (message: any) => message.role === "tool",
        );
        return call("edit_app_source", {
          sourceHash: JSON.parse(result.content).sourceHash,
          edits: [{ oldText: "原版", newText: "修改完成" }],
        });
      }
      expect(request.tools.map((tool: any) => tool.function.name)).toContain(
        "read_app_source",
      );
      return stream({ content: "已保存修改候选。" });
    });
    await f.select();
    const { message } = await f.send();
    expect(message?.status, message?.error).toBe("complete");
    expect(f.requests).toHaveLength(5);
    expect(
      message?.activities?.filter((activity) => activity.status === "failed"),
    ).toHaveLength(0);
    expect(f.session().appWorkspace?.head?.version).toBe(2);
    expect(
      (await f.html.read(f.noteId, f.session().id, f.app.artifactId, 1)).source,
    ).toBe(source);
  });
  it("preserves a saved candidate if subsequent prose is a fake call and correction fails", async () => {
    const f = await fixture((request, i) => {
      if (!i) {
        return call("read_app_source", {});
      }
      if (i === 1) {
        return call("edit_app_source", {
          sourceHash: JSON.parse(
            request.messages.findLast((message: any) => message.role === "tool")
              .content,
          ).sourceHash,
          edits: [{ oldText: "原版", newText: "已保存" }],
        });
      }
      return stream({ content: fake });
    });
    await f.select();
    const { message } = await f.send();
    expect(f.requests).toHaveLength(4);
    expect(message?.status).toBe("failed");
    expect(message?.error).toContain("部分修改候选已保存");
    expect(message?.blocks?.at(-1)).toMatchObject({
      text: expect.stringContaining("部分操作完成"),
    });
    expect(
      message?.blocks?.filter((b) => b.type === "html" && b.saved),
    ).toHaveLength(1);
    expect(f.session().appWorkspace?.head?.version).toBe(2);
  });
  it("preserves a successful candidate when the final upstream request fails", async () => {
    const f = await fixture((request, i) => {
      if (!i) {
        return call("read_app_source", {});
      }
      if (i === 1) {
        return call("edit_app_source", {
          sourceHash: JSON.parse(
            request.messages.findLast((message: any) => message.role === "tool")
              .content,
          ).sourceHash,
          edits: [{ oldText: "原版", newText: "已保存" }],
        });
      }
      throw new Error("upstream unavailable");
    });
    await f.select();
    const { message } = await f.send();
    expect(message?.status).toBe("failed");
    expect(message?.blocks?.at(-1)).toMatchObject({
      text: expect.stringContaining("候选已保存，后续回答未完成"),
    });
    expect(f.session().appWorkspace?.head?.version).toBe(2);
  });
  it("does not replace a workspace changed while a tool request is in flight", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await fixture(async (request, i) => {
      if (!i) {
        return call("read_app_source", {});
      }
      if (i === 1) {
        started!();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return call("edit_app_source", {
          sourceHash: JSON.parse(
            request.messages.findLast((message: any) => message.role === "tool")
              .content,
          ).sourceHash,
          edits: [{ oldText: "原版", newText: "旧请求的候选" }],
        });
      }
      return stream({ content: "已保存候选" });
    });
    await f.select();
    const turn = f.send();
    await waiting;
    const current = await f.store.read(f.noteId, f.session().id);
    const changed = await f.select(null, current.revision);
    expect(changed.status).toBe(200);
    const generation = changed.data.appWorkspace.generation;
    release!();
    const result = await turn;
    expect(
      result.message?.blocks?.some((b) => b.type === "html" && b.saved),
    ).toBe(true);
    expect(f.session().appWorkspace?.generation).toBe(generation);
    expect(f.session().appWorkspace?.head).toBeUndefined();
  });
  it("corrects prose once using real reads/edits, then publishes a truthful result", async () => {
    const f = await fixture((request, i) => {
      if (!i) {
        return stream({ content: fake });
      }
      if (i === 1) {
        expect(
          request.messages.some((message: any) =>
            JSON.stringify(message.content).includes("没有执行"),
          ),
        ).toBe(true);
        return call("read_app_source", {});
      }
      if (i === 2) {
        const data = JSON.parse(
          request.messages.findLast((message: any) => message.role === "tool")
            .content,
        );
        return call("edit_app_source", {
          sourceHash: data.sourceHash,
          edits: [{ oldText: "原版", newText: "新版" }],
        });
      }
      return stream({ content: "已提交" });
    });
    await f.select();
    const { message } = await f.send();
    expect(message?.status, message?.error).toBe("complete");
    expect(message?.blocks?.find((b) => b.type === "protocol")).toMatchObject({
      status: "resolved",
    });
    expect(message?.blocks?.at(-1)).toMatchObject({
      type: "edit_result",
      text: expect.stringContaining("候选已保存"),
    });
    expect(f.requests).toHaveLength(4);
    expect(f.session().appWorkspace?.head?.version).toBe(2);
    expect((await f.html.readApp(f.noteId, f.app.artifactId, 1)).source).toBe(
      source,
    );
  });
  it("does not loop on repeated prose calls or claim success", async () => {
    const f = await fixture(() => stream({ content: fake }));
    await f.select();
    const { message } = await f.send();
    expect(f.requests).toHaveLength(5);
    expect(message?.blocks?.at(-1)).toMatchObject({
      type: "edit_result",
      text: expect.stringContaining("修改未完成"),
    });
    expect(f.session().appWorkspace?.head?.version).toBe(1);
    expect(f.session().appWorkspace?.candidateNumber).toBe(0);
  });
  it("does not correct length truncation", async () => {
    const f = await fixture(() => stream({ content: fake }, "length"));
    const { message } = await f.send();
    expect(f.requests).toHaveLength(1);
    expect(message?.status).toBe("failed");
  });
  it("continues the saved candidate across turns and retains cumulative diff", async () => {
    const f = await fixture((request, i) => {
      const step = i % 3;
      if (!step) {
        return call("read_app_source", {});
      }
      if (step === 1) {
        const result = JSON.parse(
          request.messages.findLast((message: any) => message.role === "tool")
            .content,
        );
        if (i > 2) {
          expect(result.source).toContain("第一候选");
        }
        return call("edit_app_source", {
          sourceHash: result.sourceHash,
          edits: [
            {
              oldText: i < 3 ? "原版" : "说明",
              newText: i < 3 ? "第一候选" : "第二次说明",
            },
          ],
        });
      }
      return stream({ content: "候选已提交" });
    });
    await f.select();
    await f.send();
    await f.send();
    const workspace = f.session().appWorkspace!;
    expect(workspace.candidateNumber).toBe(2);
    expect(workspace.head?.version).toBe(3);
    expect(workspace.base?.version).toBe(1);
    const head = await f.html.readApp(
      f.noteId,
      workspace.head!.artifactId,
      workspace.head!.version,
    );
    expect(head.source).toContain("第一候选");
    expect(head.source).toContain("第二次说明");
    expect(head.changes![0].before).toContain("原版");
    expect(head.changes![0].after).toContain("第一候选");
    const oldRevision = f.session().revision - 1;
    expect((await f.select(undefined, oldRevision)).status).toBe(409);
    expect((await f.send({ workspaceGeneration: randomUUID() })).status).toBe(
      409,
    );
  });
  it("does not let search alone authorize an edit", async () => {
    const f = await fixture((request, i) => {
      if (!i) {
        return call("search_app_source", { query: "原版", contextLines: 0 });
      }
      if (i === 1) {
        expect(
          request.tools.some((t: any) => t.function.name === "edit_app_source"),
        ).toBe(false);
        return stream({ content: "只搜索" });
      }
      throw new Error("unexpected request");
    });
    const { message } = await f.send();
    expect(message?.activities?.[0].status).toBe("complete");
    expect(message?.blocks?.some((b) => b.type === "html")).toBe(false);
  });
});

it.skipIf(!process.env.TARGETED_EDIT_REAL_QWEN)(
  "uses real Qwen for two successive edits of counter, timer and architecture sources",
  async () => {
    const applications = [
      '<main id="app"><h1>原版</h1><p>说明</p><button id="inc">增加</button><output id="value">0</output></main><script>(()=>{const render=()=>document.getElementById("value").textContent=String(NoteApp.get("n",0));NoteApp.on("inc","app","click","#inc",()=>{NoteApp.set("n",NoteApp.get("n",0)+1);render()});render()})()</script>',
      '<main id="app"><h1>原版</h1><p>说明</p><input id="task"><button id="start">开始</button><output id="time">25:00</output></main><script>(()=>{NoteApp.on("start","app","click","#start",()=>NoteApp.set("deadline",Date.now()+1500000));NoteApp.interval("tick",()=>{const t=Math.max(0,Math.ceil((NoteApp.get("deadline",Date.now())-Date.now())/1000));document.getElementById("time").textContent=String(t)},1000)})()</script>',
      '<main id="app"><h1>原版</h1><p>说明</p><button id="pod">Pod</button><button id="service">Service</button><output id="explain"></output></main><script>(()=>{NoteApp.on("select","app","click","button",(_,node)=>{NoteApp.set("selected",node.id);document.getElementById("explain").textContent=node.id==="pod"?"运行容器":"提供访问入口"})})()</script>',
    ];
    for (const initial of applications) {
      const f = await fixture(
        (request) =>
          fetch(
            `${
              process.env.QWEN_BASE_URL || "http://10.252.221.218:18006/v1"
            }/chat/completions`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...request,
                model: "qwen3.8-27b",
                chat_template_kwargs: { enable_thinking: false },
              }),
            },
          ),
        initial,
      );
      await f.select();
      const first = await f.send({
        content:
          "必须使用真实源码工具局部修改：只将 h1 文本 原版 改成 第一候选，不改其他任何字符，不重新输出 HTML。",
      });
      expect(
        first.message?.activities?.some(
          (a) => a.name === "edit_app_source" && a.status === "complete",
        ),
      ).toBe(true);
      const second = await f.send({
        content:
          "在刚才候选上继续，只将 p 文本 说明 改成 第二次说明，保留刚才的标题和其余所有字符，必须读取后通过工具局部编辑，不输出 HTML。",
      });
      expect(
        second.message?.activities?.some(
          (a) => a.name === "edit_app_source" && a.status === "complete",
        ),
        JSON.stringify({
          content: second.message?.content,
          error: second.message?.error,
          activities: second.message?.activities,
        }),
      ).toBe(true);
      const head = f.session().appWorkspace!.head!;
      const saved = await f.html.readApp(
        f.noteId,
        head.artifactId,
        head.version,
      );
      expect(saved.source).toBe(
        initial.replace("原版", "第一候选").replace("说明", "第二次说明"),
      );
    }
  },
  600000,
);

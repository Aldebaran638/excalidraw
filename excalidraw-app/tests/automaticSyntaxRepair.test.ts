/* eslint-disable no-console */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatService } from "../server/chat";
import { ChatStore } from "../server/chatStore";
import { ChatHtmlStore } from "../server/chatHtmlStore";
import {
  sourceHash,
  AppSyntaxError,
  validateAppSource,
} from "../server/appSource";
import { readSSE } from "../data/sse";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
const bad =
  '<!doctype html><html><body><h1>实验室</h1><input id="task"><script>const steps={3RC:1,3RR:2};</script></body></html>';
const good = bad.replace("3RC:", '"3RC":').replace("3RR:", '"3RR":');
const tool = (name: string, args: unknown, id = randomUUID()) => ({
  tool_calls: [
    { index: 0, id, function: { name, arguments: JSON.stringify(args) } },
  ],
});
const chunk = (delta: any, reason = delta.tool_calls ? "tool_calls" : "stop") =>
  new Response(
    `data: ${JSON.stringify({
      choices: [{ delta }],
    })}\n\ndata: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: reason }],
    })}\n\ndata: [DONE]\n\n`,
  );
const html = (source: string, reason = "stop") =>
  chunk({ content: `\`\`\`html\n${source}\n\`\`\`` }, reason);
const replace = (
  source: string,
  edits: { oldText: string; newText: string }[],
) => tool("edit_app_source", { sourceHash: sourceHash(source), edits });
const quotes = [
  { oldText: "3RC:", newText: '"3RC":' },
  { oldText: "3RR:", newText: '"3RR":' },
];

async function fixture(
  respond: (
    request: any,
    index: number,
    init?: RequestInit,
  ) => Response | Promise<Response>,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "auto-syntax-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const noteId = randomUUID();
  await fs.writeFile(
    path.join(directory, "note.excalidraw"),
    JSON.stringify({
      elements: [],
      repositoryMetadata: { version: 1, noteId },
    }),
  );
  const chat = new ChatStore(directory);
  const session = await chat.create(noteId);
  const store = new ChatHtmlStore(directory);
  const requests: any[] = [];
  const service = await createChatService(
    directory,
    { model: "fixture", baseUrl: "http://fixture/v1" },
    async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      return respond(request, requests.length - 1, init);
    },
  );
  const server = createServer((req, res) => {
    void service.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const turnId = randomUUID();
  const base = `http://127.0.0.1:${
    (server.address() as { port: number }).port
  }/api/notes/${noteId}/chats/${session.id}`;
  return {
    directory,
    noteId,
    session,
    store,
    requests,
    chat,
    stop: () => fetch(`${base}/turns/${turnId}/stop`, { method: "POST" }),
    async send(extra: Record<string, unknown> = {}) {
      const response = await fetch(
        `http://127.0.0.1:${
          (server.address() as { port: number }).port
        }/api/notes/${noteId}/chats/${session.id}/turns`,
        {
          method: "POST",
          body: JSON.stringify({
            content: "创建实验室",
            turnId,
            revision: session.revision,
            snapshot: { capturedAt: Date.now(), elements: [] },
            ...extra,
          }),
        },
      );
      const events: any[] = [];
      for await (const event of readSSE(response.body!)) {
        events.push(JSON.parse(event.data));
      }
      return { events, message: events.at(-1).message };
    },
  };
}

describe("automatic syntax repair", () => {
  it("repairs 3RC/3RR through real read/edit calls, keeps one card and preserves the latest input", async () => {
    const f: Awaited<ReturnType<typeof fixture>> = await fixture(
      async (request, index) => {
        if (!index) {
          return html(bad);
        }
        if (index === 1) {
          expect(request.tool_choice).toBeUndefined();
          expect(request.tools.map((tool: any) => tool.function.name)).toEqual([
            "read_app_source",
          ]);
          const id = (
            await fs.readdir(path.join(f.directory, ".apps", f.noteId))
          )[0];
          await f.store.saveState(f.noteId, f.session.id, id, 1, 0, {
            forms: { task: { type: "text", value: "保留这段输入" } },
            custom: { deadline: 123456 },
          });
          return chunk(tool("read_app_source", {}));
        }
        if (index === 2) {
          return chunk(replace(`${bad}\n`, quotes));
        }
        throw new Error("must not append a success-prose request");
      },
    );
    const { events, message } = await f.send();
    expect(message.status).toBe("complete");
    const blocks = message.blocks.filter((block: any) => block.type === "html");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].repair).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    const saved = await f.store.read(
      f.noteId,
      f.session.id,
      blocks[0].ref.artifactId,
      blocks[0].ref.version,
    );
    expect(saved.source.trim()).toBe(good);
    expect(saved.state.forms.task.value).toBe("保留这段输入");
    expect(saved.state.custom.deadline).toBe(123456);
    expect(
      new Set(
        events
          .filter((event) => event.block?.type === "html")
          .map((event) => event.block.id),
      ).size,
    ).toBe(1);
    expect(f.requests).toHaveLength(3);
  });

  it("repairs a failed edit on its draft, and includes the intended edit in the baseline diff", async () => {
    const original = good.replace("实验室", "原始实验室");
    const f = await fixture((_request, index) => {
      if (index === 0 || index === 2) {
        return chunk(tool("read_app_source", {}));
      }
      if (index === 1) {
        return chunk(
          replace(original, [
            { oldText: "原始实验室", newText: "新实验室" },
            { oldText: '"3RC":', newText: "3RC:" },
          ]),
        );
      }
      if (index === 3) {
        return chunk(
          replace(
            good.replace("实验室", "新实验室").replace('"3RC":', "3RC:"),
            [quotes[0]],
          ),
        );
      }
      throw new Error("unexpected request");
    });
    const app = await f.store.write({
      kind: "html",
      artifactId: randomUUID(),
      version: 1,
      noteId: f.noteId,
      sessionId: f.session.id,
      title: "原始实验室",
      source: original,
      complete: true,
      revision: 0,
      state: { forms: {}, custom: { n: 9 } },
      createdAt: Date.now(),
    });
    const { message } = await f.send({
      workspace: { kind: "html", artifactId: app.artifactId, version: 1 },
    });
    expect(message.status).toBe("complete");
    const blocks = message.blocks.filter((block: any) => block.type === "html");
    expect(blocks).toHaveLength(1);
    const result = await f.store.readApp(
      f.noteId,
      blocks[0].ref.artifactId,
      blocks[0].ref.version,
    );
    expect(result.source).toBe(good.replace("实验室", "新实验室"));
    expect(
      result.changes?.some(
        (edit) =>
          edit.before.includes("原始实验室") && edit.after.includes("新实验室"),
      ),
    ).toBe(true);
    expect((await f.store.readApp(f.noteId, app.artifactId, 1)).source).toBe(
      original,
    );
  });

  it("updates the same draft and succeeds on the second repair attempt", async () => {
    const first = bad.replace("3RC:", '"3RC":');
    const f = await fixture((_request, index) => {
      if (!index) {
        return html(bad);
      }
      if (index === 1 || index === 3) {
        return chunk(tool("read_app_source", {}));
      }
      if (index === 2) {
        return chunk(replace(`${bad}\n`, [quotes[0]]));
      }
      if (index === 4) {
        return chunk(replace(`${first}\n`, [quotes[1]]));
      }
      throw new Error("unexpected request");
    });
    const { message } = await f.send();
    expect(message.status).toBe("complete");
    expect(
      message.blocks.filter((block: any) => block.type === "html"),
    ).toHaveLength(1);
    expect(
      message.blocks.find((block: any) => block.type === "html").repair,
    ).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("stops after six repair edits, retaining the latest invalid draft", async () => {
    let current = `${bad}\n`;
    const f = await fixture((_request, index) => {
      if (!index) {
        return html(bad);
      }
      if (index % 2 === 1) {
        return chunk(tool("read_app_source", {}));
      }
      const attempt = index / 2;
      if (attempt > 6) {
        throw new Error("must stop after six edits");
      }
      const edit = {
        oldText: attempt === 1 ? "实验室" : `尝试${attempt - 1}`,
        newText: `尝试${attempt}`,
      };
      const response = chunk(replace(current, [edit]));
      current = current.replace(edit.oldText, edit.newText);
      return response;
    });
    const { message } = await f.send();
    expect(message.status).toBe("failed");
    const block = message.blocks.find((block: any) => block.type === "html");
    expect(block.repair).toMatchObject({ status: "failed", attempts: 6 });
    expect(block.saved).not.toBe(true);
    expect(
      (await f.store.read(f.noteId, f.session.id, block.ref.artifactId, 1))
        .source,
    ).toContain("尝试6");
    expect(f.requests).toHaveLength(13);
  });

  it("repairs three distinct syntax defects without asking the user to retry", async () => {
    let current = `${bad.replace("3RR:2", "3RR:2,4ZZ:3")}\n`;
    const edits = [...quotes, { oldText: "4ZZ:", newText: '"4ZZ":' }];
    const f = await fixture((_request, index) => {
      if (!index) {
        return html(current.trimEnd());
      }
      if (index % 2) {
        return chunk(tool("read_app_source", {}));
      }
      const edit = edits[index / 2 - 1];
      if (!edit) {
        throw new Error("must finish after third repair");
      }
      const response = chunk(replace(current, [edit]));
      current = current.replace(edit.oldText, edit.newText);
      return response;
    });
    const { message } = await f.send();
    expect(message.status).toBe("complete");
    expect(
      message.blocks.find((b: any) => b.type === "html").repair,
    ).toMatchObject({ status: "succeeded", attempts: 3 });
  });

  it("does not automatically repair truncated output or valid code with a runtime throw", async () => {
    const truncated = await fixture(() => html(bad, "length"));
    expect((await truncated.send()).message.status).toBe("failed");
    expect(truncated.requests).toHaveLength(1);
    const runtime = await fixture(() =>
      html('<script>throw new Error("runtime only")</script>'),
    );
    expect((await runtime.send()).message.status).toBe("complete");
    expect(runtime.requests).toHaveLength(1);
  });

  it("never promotes a full rewrite in edit mode through the repair path", async () => {
    const f = await fixture(() => html(bad));
    const app = await f.store.write({
      kind: "html",
      artifactId: randomUUID(),
      version: 1,
      noteId: f.noteId,
      sessionId: f.session.id,
      title: "base",
      source: good,
      complete: true,
      revision: 0,
      state: { forms: {}, custom: {} },
      createdAt: Date.now(),
    });
    const { message } = await f.send({
      workspace: { kind: "html", artifactId: app.artifactId, version: 1 },
    });
    expect(message.status).toBe("failed");
    const block = message.blocks.find((block: any) => block.type === "html");
    expect(block.repair).toBeUndefined();
    expect(
      (await f.store.read(f.noteId, f.session.id, block.ref.artifactId, 1))
        .recovery?.code,
    ).toBe("protocol");
    expect(f.requests).toHaveLength(1);
  });

  it("replays duplicate tool IDs without duplicate activities or attempts", async () => {
    const read = tool("read_app_source", {});
    const f = await fixture((_request, index) => {
      if (!index) {
        return html(bad);
      }
      if (index === 1 || index === 2) {
        return chunk(read);
      }
      if (index === 3) {
        return chunk(replace(`${bad}\n`, quotes));
      }
      throw new Error();
    });
    const { message } = await f.send();
    expect(message.status).toBe("complete");
    expect(message.activities).toHaveLength(2);
    expect(
      message.blocks.find((block: any) => block.type === "html").repair
        .attempts,
    ).toBe(1);
  });

  it("does not request repair if saving the failed draft fails", async () => {
    const f = await fixture(() => html(bad));
    vi.spyOn(ChatHtmlStore.prototype, "write").mockRejectedValue(
      new Error("ENOSPC"),
    );
    const { message } = await f.send();
    expect(message.status).toBe("failed");
    expect(f.requests).toHaveLength(1);
    expect(message.blocks.some((block: any) => block.saved)).toBe(false);
  });

  it("publishes one repaired version for duplicate edit calls in one response", async () => {
    const edit = replace(`${bad}\n`, quotes);
    const f = await fixture((_request, index) => {
      if (!index) {
        return html(bad);
      }
      if (index === 1) {
        return chunk(tool("read_app_source", {}));
      }
      return chunk({
        tool_calls: [edit.tool_calls[0], { ...edit.tool_calls[0], index: 1 }],
      });
    });
    const { message } = await f.send();
    expect(message.status).toBe("complete");
    expect(
      message.blocks.filter((block: any) => block.type === "html"),
    ).toHaveLength(1);
    expect(
      message.blocks.find((block: any) => block.type === "html").repair
        .attempts,
    ).toBe(1);
    expect(message.activities).toHaveLength(2);
  });

  it("classifies event handler errors structurally, but not truncated HTML", () => {
    expect(() =>
      validateAppSource('<button onclick="const s={3RC:1}">click</button>'),
    ).toThrow(AppSyntaxError);
    expect(() => validateAppSource("<script>let n=")).not.toThrow(
      AppSyntaxError,
    );
  });

  it("repairs inline event handler syntax without replacing the application", async () => {
    const source = '<button onclick="const s={3RC:1}">click</button>';
    const f = await fixture((_request, index) =>
      index === 0
        ? html(source)
        : index === 1
        ? chunk(tool("read_app_source", {}))
        : chunk(
            replace(`${source}\n`, [{ oldText: "3RC:", newText: "'3RC':" }]),
          ),
    );
    const { message } = await f.send();
    expect(message.status).toBe("complete");
    expect(
      message.blocks.find((block: any) => block.type === "html").repair.status,
    ).toBe("succeeded");
    expect(f.requests).toHaveLength(3);
  });

  it("stops an in-flight repair and preserves its draft without another request", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await fixture((_request, index, init) => {
      if (!index) {
        return html(bad);
      }
      started();
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        ),
      );
    });
    const pending = f.send();
    await ready;
    expect((await f.stop()).ok).toBe(true);
    const { message } = await pending;
    expect(message.status).toBe("stopped");
    expect(
      message.blocks.find((block: any) => block.type === "html").repair.status,
    ).toBe("interrupted");
    expect(f.requests).toHaveLength(2);
  });

  it("bounds pre-stream network retries during repair and preserves the draft", async () => {
    const f = await fixture((_request, index) => {
      if (!index) {
        return html(bad);
      }
      throw new Error("upstream network failed");
    });
    const { message } = await f.send();
    expect(message.status).toBe("failed");
    expect(
      message.blocks.find((block: any) => block.type === "html").draftSaved,
    ).toBe(true);
    expect(f.requests).toHaveLength(4);
  });

  it("does not reset reading budgets or tool-round limits during repair", async () => {
    const long = `<!--${"x".repeat(26000)}-->\n${bad}`;
    const f = await fixture((request, index) => {
      if (!index) {
        return html(long);
      }
      const previous = request.messages
        .filter((message: any) => message.role === "tool")
        .at(-1);
      const page = previous && JSON.parse(previous.content);
      return chunk(
        tool("read_app_source", {
          startLine: page?.nextLine || 1,
          startColumn: page?.nextColumn || 0,
        }),
      );
    });
    const { message } = await f.send();
    expect(message.status).toBe("failed");
    expect(
      message.blocks.find((block: any) => block.type === "html").saved,
    ).not.toBe(true);
    expect(f.requests.length).toBeLessThanOrEqual(201);
    expect(
      message.activities.some(
        (activity: any) => activity.errorCode === "budget",
      ),
    ).toBe(true);
  });

  it("marks interrupted repair messages on restart without requesting Qwen", async () => {
    const f = await fixture(() => {
      throw new Error("must not request");
    });
    await f.chat.update(f.noteId, f.session.id, (session) => {
      session.messages.push({
        id: randomUUID(),
        turnId: randomUUID(),
        role: "assistant",
        content: "",
        status: "generating",
        createdAt: Date.now(),
        blocks: [
          {
            id: randomUUID(),
            type: "html",
            ref: { kind: "html", artifactId: randomUUID(), version: 1 },
            complete: false,
            repair: {
              status: "repairing",
              attempts: 1,
              maxAttempts: 2,
              error: "syntax",
            },
          },
        ],
      });
    });
    await f.chat.recover();
    const message = (await f.chat.read(f.noteId, f.session.id)).messages.at(
      -1,
    )!;
    expect(message.status).toBe("interrupted");
    expect(
      message.blocks?.[0].type === "html" && message.blocks[0].repair?.status,
    ).toBe("interrupted");
    expect(f.requests).toHaveLength(0);
  });

  it.skipIf(process.env.AUTO_REPAIR_REAL_QWEN !== "1")(
    "uses real Qwen to read and minimally repair an injected 3RC/3RR regression",
    async () => {
      const base =
        process.env.QWEN_BASE_URL || "http://10.252.221.218:18006/v1";
      const f = await fixture(async (request, index, init) => {
        if (!index) {
          return html(bad);
        }
        const response = await fetch(`${base}/chat/completions`, {
          method: "POST",
          signal: init?.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...request,
            model: process.env.QWEN_MODEL || "qwen3.8-27b",
          }),
        });
        if (!response.ok) {
          console.log(
            "Qwen acceptance error",
            (await response.clone().text()).slice(0, 800),
          );
        }
        return response;
      });
      const { message } = await f.send();
      console.log(
        JSON.stringify({
          realQwenStatus: message.status,
          error: message.error,
          tools: message.activities?.map((activity: any) => ({
            name: activity.name,
            status: activity.status,
          })),
        }),
      );
      expect(message.status, message.error).toBe("complete");
      const block = message.blocks.find((block: any) => block.type === "html");
      expect(block.saved).toBe(true);
      const saved = await f.store.readApp(
        f.noteId,
        block.ref.artifactId,
        block.ref.version,
      );
      expect(
        saved.source
          .trim()
          .replaceAll("'3RC'", '"3RC"')
          .replaceAll("'3RR'", '"3RR"'),
      ).toBe(good);
      expect(message.activities.map((activity: any) => activity.name)).toEqual([
        "read_app_source",
        "edit_app_source",
      ]);
      console.log(
        JSON.stringify({
          realQwenRepair: true,
          seededInvalidGeneration: true,
          attempts: block.repair.attempts,
          onlyQuotesChanged: true,
        }),
      );
    },
    180000,
  );
});

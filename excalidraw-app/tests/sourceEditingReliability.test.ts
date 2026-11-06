// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatService } from "../server/agent/chat";
import { ChatStore } from "../server/chatStore";
import { ChatHtmlStore } from "../server/chatHtmlStore";
import {
  readSourcePage,
  sourceHash,
  validateAppSource,
} from "../server/appSource";
import { readSSE } from "../data/sse";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
const original =
  "<!doctype html><html><body><h1>计数器</h1><script>let count=0;</script></body></html>";
const tool = (name: string, args: unknown) => ({
  tool_calls: [
    {
      index: 0,
      id: randomUUID(),
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
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
async function fixture(
  respond: (request: any, call: number) => Response | Promise<Response>,
  source = original,
) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "source-reliability-"),
  );
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const noteId = randomUUID();
  await fs.writeFile(
    path.join(directory, "fixture.excalidraw"),
    JSON.stringify({
      elements: [],
      repositoryMetadata: { version: 1, noteId },
    }),
  );
  const chat = new ChatStore(directory);
  let session = await chat.create(noteId);
  const html = new ChatHtmlStore(directory);
  const app = await html.write({
    kind: "html",
    artifactId: randomUUID(),
    version: 1,
    noteId,
    sessionId: session.id,
    title: "计数器",
    source,
    complete: true,
    revision: 0,
    createdAt: Date.now(),
    state: { forms: {}, custom: { count: 7 } },
  });
  const requests: any[] = [];
  const service = await createChatService(
    directory,
    { baseUrl: "http://fixture/v1", model: "fixture" },
    async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      return respond(request, requests.length - 1);
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
  const workspace = { kind: "html", artifactId: app.artifactId, version: 1 };
  const send = async (extra: Record<string, unknown> = {}) => {
    const response = await fetch(
      `http://127.0.0.1:${
        (server.address() as { port: number }).port
      }/api/notes/${noteId}/chats/${session.id}/turns`,
      {
        method: "POST",
        body: JSON.stringify({
          turnId: randomUUID(),
          revision: session.revision,
          content: "请局部修改标题",
          workspace,
          snapshot: { capturedAt: Date.now(), elements: [] },
          ...extra,
        }),
      },
    );
    const events: any[] = [];
    if (!response.ok) {
      return {
        error: await response.json(),
        events,
        message: undefined,
        status: response.status,
      };
    }
    for await (const frame of readSSE(response.body!)) {
      events.push(JSON.parse(frame.data));
    }
    session = await chat.read(noteId, session.id);
    return {
      events,
      message: session.messages.at(-1)!,
      error: undefined,
      status: response.status,
    };
  };
  return { send, html, app, requests, chat, noteId, getSession: () => session };
}

describe("source editing reliability", () => {
  it("pages escaped long lines without losing characters or UTF-16 pairs", () => {
    const source = '中文😀\\"'.repeat(2000);
    let startLine = 1;
    let startColumn = 0;
    let restored = "";
    let count = 0;
    do {
      const page = readSourcePage(source, startLine, 60, 500, startColumn);
      expect(JSON.stringify(page.source).length).toBeLessThan(510);
      restored += page.source.replace(/^\d+(?: \(column \d+\))?: /, "");
      if (page.nextLine === null) {
        break;
      }
      startLine = page.nextLine;
      startColumn = page.nextColumn;
      expect(++count).toBeLessThan(300);
    } while (true);
    expect(restored).toBe(source);
  });

  it("reports the script number, HTML location and nearby invalid code", () => {
    expect(() =>
      validateAppSource(
        "<!doctype html>\n<script>let a=0;</script>\n<script>\nconst broken = ;\n</script>",
      ),
    ).toThrow(/脚本 2，HTML 第 4 行[\s\S]*const broken/);
  });

  it("does not expose edit until read, re-reads each candidate, and preserves the original", async () => {
    let current = original;
    const f = await fixture((request, call) => {
      const names = request.tools.map((entry: any) => entry.function.name);
      if (call % 2 === 0 && call < 4) {
        expect(names).not.toContain("edit_app_source");
        return stream(tool("read_app_source", {}));
      }
      if (call < 4) {
        expect(names).toContain("edit_app_source");
        const oldText = call === 1 ? "计数器" : "候选一";
        const newText = call === 1 ? "候选一" : "候选二";
        const args = {
          sourceHash: sourceHash(current),
          edits: [{ oldText, newText }],
        };
        current = current.replace(oldText, newText);
        return stream(tool("edit_app_source", args));
      }
      return stream({ content: "候选已保存，请确认。" });
    });
    const { message } = await f.send();
    expect(message!.status).toBe("complete");
    const blocks = message!.blocks!.filter((block) => block.type === "html");
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      if (block.type !== "html") {
        continue;
      }
      expect(block.saved).toBe(true);
    }
    expect((await f.html.readApp(f.noteId, f.app.artifactId, 1)).source).toBe(
      original,
    );
    expect(message!.activities?.map((activity) => activity.summary)).toEqual([
      "已读取源码第 1–1 行",
      "修改候选已保存，等待确认",
      "已读取源码第 1–1 行",
      "修改候选已保存，等待确认",
    ]);
  });

  it("keeps full HTML returned during an edit as an explicit non-importable draft", async () => {
    const f = await fixture(() =>
      stream({
        content: `\`\`\`html\n${original.replace(
          "计数器",
          "整份重写",
        )}\n\`\`\``,
      }),
    );
    const { message } = await f.send();
    const block = message!.blocks!.find((block) => block.type === "html")!;
    if (block.type !== "html") {
      throw new Error();
    }
    expect(block.complete).toBe(false);
    expect(block.saved).not.toBe(true);
    expect(block.draftSaved).toBe(true);
    expect(block.error).toContain("未按编辑流程");
    const draft = await f.html.read(
      f.noteId,
      f.app.sessionId,
      block.ref.artifactId,
      1,
    );
    expect(draft.source).toContain("整份重写");
    expect(draft.recovery?.code).toBe("protocol");
    // Initial response plus the three existing bounded completion recoveries.
    // fc4ea2b5 already makes four calls here; none may publish a rewrite.
    expect(f.requests).toHaveLength(4);
    expect(message!.status).toBe("failed");
    expect(
      message!.blocks!.every(
        (entry) => entry.type !== "html" || (!entry.complete && !entry.saved),
      ),
    ).toBe(true);
    await expect(
      f.html.readApp(f.noteId, block.ref.artifactId, 1),
    ).rejects.toThrow("源码文件缺失");
  });

  it("saves invalid edits and fixes them only after the user explicitly selects recovery", async () => {
    let recovery = false;
    const invalid = original.replace("let count=0;", "let count=;");
    const f = await fixture((request, call) => {
      const step = recovery ? call - 3 : call;
      if (step === 0) {
        return stream(tool("read_app_source", {}));
      }
      if (step === 1) {
        return stream(
          tool("edit_app_source", {
            sourceHash: sourceHash(recovery ? invalid : original),
            edits: [
              {
                oldText: recovery ? "let count=;" : "let count=0;",
                newText: recovery ? "let count=1;" : "let count=;",
              },
            ],
          }),
        );
      }
      return stream({
        content: recovery ? "已修正，请确认" : "语法错误，原组件未改变",
      });
    });
    const failed = await f.send();
    const block = failed.message!.blocks!.find(
      (block) => block.type === "html",
    )!;
    if (block.type !== "html") {
      throw new Error();
    }
    expect(failed.message!.activities?.at(-1)?.status).toBe("failed");
    expect(failed.message!.activities?.at(-1)?.errorCode).toBe("syntax");
    expect(
      (await f.html.read(f.noteId, f.app.sessionId, block.ref.artifactId, 1))
        .source,
    ).toBe(invalid);
    recovery = true;
    const fixed = await f.send({ recovery: block.ref });
    const candidate = fixed.message!.blocks!.find(
      (block) => block.type === "html" && block.saved,
    )!;
    if (candidate.type !== "html") {
      throw new Error();
    }
    expect(
      (
        await f.html.readApp(
          f.noteId,
          candidate.ref.artifactId,
          candidate.ref.version,
        )
      ).source,
    ).toBe(original.replace("count=0", "count=1"));
    expect((await f.html.readApp(f.noteId, f.app.artifactId, 1)).source).toBe(
      original,
    );
    expect(f.requests).toHaveLength(6);
  });

  it("does not discard a saved candidate when the following prose stream fails", async () => {
    const f = await fixture((_request, call) =>
      call === 0
        ? stream(tool("read_app_source", {}))
        : call === 1
        ? stream(
            tool("edit_app_source", {
              sourceHash: sourceHash(original),
              edits: [{ oldText: "计数器", newText: "新版" }],
            }),
          )
        : stream({ content: "文字未完成" }, "length"),
    );
    const { message } = await f.send();
    expect(message!.status).toBe("failed");
    expect(
      message!.blocks!.some((block) => block.type === "html" && block.saved),
    ).toBe(true);
    expect(f.requests).toHaveLength(3);
  });

  it("rejects a recovery reference absent from the session before calling Qwen", async () => {
    const f = await fixture(() => {
      throw new Error("must not call");
    });
    const result = await f.send({
      recovery: { artifactId: randomUUID(), version: 1 },
    });
    expect(result.status).toBe(400);
    expect(f.requests).toHaveLength(0);
  });

  it("retains the final invalid source rather than an older streaming snapshot", async () => {
    const invalid = original.replace("let count=0;", "let count=;");
    const f = await fixture(() =>
      stream({ content: `\`\`\`html\n${invalid}\n\`\`\`` }),
    );
    const result = await f.send({ workspace: undefined, appIntent: "create" });
    const block = result.message!.blocks!.find(
      (block) => block.type === "html",
    )!;
    if (block.type !== "html") {
      throw new Error();
    }
    const draft = await f.html.read(
      f.noteId,
      f.app.sessionId,
      block.ref.artifactId,
      1,
    );
    expect(draft.source.trim()).toBe(invalid);
    expect(draft.complete).toBe(false);
    expect(draft.recovery?.code).toBe("syntax");
    expect(block.saved).not.toBe(true);
    expect(f.requests).toHaveLength(2);
  });

  it("does not announce a candidate when publishing it fails", async () => {
    const f = await fixture((_request, call) =>
      call === 0
        ? stream(tool("read_app_source", {}))
        : call === 1
        ? stream(
            tool("edit_app_source", {
              sourceHash: sourceHash(original),
              edits: [{ oldText: "计数器", newText: "新版" }],
            }),
          )
        : stream({ content: "保存失败，原组件未变" }),
    );
    const write = ChatHtmlStore.prototype.write;
    vi.spyOn(ChatHtmlStore.prototype, "write").mockImplementation(function (
      this: ChatHtmlStore,
      data,
    ) {
      if (data.complete && data.version === 2) {
        return Promise.reject(new Error("ENOSPC"));
      }
      return write.call(this, data);
    });
    const result = await f.send();
    expect(result.message!.activities?.at(-1)?.status).toBe("failed");
    expect(result.message!.activities?.at(-1)?.errorCode).toBe("storage");
    expect(
      result.events.some(
        (event) => event.type === "block" && event.block?.saved,
      ),
    ).toBe(false);
    expect((await f.html.readApp(f.noteId, f.app.artifactId, 1)).source).toBe(
      original,
    );
  });

  it("returns source pages above 32000 context characters instead of replacing them with an error", async () => {
    const source = `<!doctype html><html><body>\n${Array.from(
      { length: 240 },
      (_, i) => `<!-- ${i} ${"x".repeat(150)} -->`,
    ).join("\n")}\n</body></html>`;
    let seenOver32k = false;
    const f = await fixture((request, call) => {
      if (JSON.stringify(request.messages).length > 32000) {
        seenOver32k = true;
      }
      const results = request.messages
        .filter((message: any) => message.role === "tool")
        .map((message: any) => JSON.parse(message.content));
      expect(results.every((result: any) => !result.error)).toBe(true);
      if (call < 4) {
        return stream(
          tool("read_app_source", { startLine: call * 35 + 1, lineCount: 35 }),
        );
      }
      return stream({ content: "已读取，暂不修改。" });
    }, source);
    const result = await f.send({ content: "x".repeat(11000) });
    expect(result.message!.status).toBe("complete");
    expect(seenOver32k).toBe(true);
    expect(f.requests).toHaveLength(5);
  });
});

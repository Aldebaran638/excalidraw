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
import { validateSourceArguments } from "../server/chatTools";
import { ChatStore } from "../server/chatStore";
import { ChatHtmlStore } from "../server/chatHtmlStore";
import { createChatService } from "../server/chat";
import { readSSE } from "../data/sse";

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
    send: async (extra = {}) => {
      const response = await fetch(`${url}/turns`, {
        method: "POST",
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
        events.push(JSON.parse(event.data));
      }
      session = await store.read(noteId, session.id);
      return {
        status: response.status,
        events,
        message: session.messages.at(-1)!,
        error: undefined,
      };
    },
  };
}

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
  it("preserves a saved candidate if subsequent prose is a fake call and correction fails", async () => {
    const f = await fixture((request, i) => {
      if (!i) {
        return call("read_app_source", {});
      }
      if (i === 1) {
        return call("edit_app_source", {
          sourceHash: JSON.parse(request.messages.at(-1).content).sourceHash,
          edits: [{ oldText: "原版", newText: "已保存" }],
        });
      }
      return stream({ content: fake });
    });
    await f.select();
    const { message } = await f.send();
    expect(f.requests).toHaveLength(4);
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
          sourceHash: JSON.parse(request.messages.at(-1).content).sourceHash,
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
          sourceHash: JSON.parse(request.messages.at(-1).content).sourceHash,
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
        expect(request.messages.at(-1).content).toContain("没有执行");
        return call("read_app_source", {});
      }
      if (i === 2) {
        const data = JSON.parse(request.messages.at(-1).content);
        return call("edit_app_source", {
          sourceHash: data.sourceHash,
          edits: [{ oldText: "原版", newText: "新版" }],
        });
      }
      return stream({ content: "已提交" });
    });
    await f.select();
    const { message } = await f.send();
    expect(message?.status).toBe("complete");
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
    expect(f.requests).toHaveLength(2);
    expect(message?.blocks?.at(-1)).toMatchObject({
      type: "edit_result",
      text: expect.stringContaining("未通过真实工具"),
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
        const result = JSON.parse(request.messages.at(-1).content);
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

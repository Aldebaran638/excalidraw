import fs from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  agentTask,
  AgentCompletion,
  needsNoteTools,
  followsAppTask,
  permitsSourceEdit,
} from "../server/agent/agentPolicy";
import { compactAgentContext } from "../server/agent/agentContext";
import { requestAgentStream } from "../server/agent/agentTransport";
import {
  validateAppSource,
  replaceSource,
  sourceHash,
  readSourcePage,
  SourceReadCoverage,
} from "../server/appSource";
import { APP_CDN_SCRIPTS, isAppLibrary } from "../data/appLibraries";
import { HtmlLibraryStream } from "../data/htmlLibraryStream";
import {
  previewProblems,
  inspectSvgGeometry,
  inspectNodeInteractions,
} from "../data/appPreview";
import { AgentPreviews } from "../server/agent/agentPreview";
import { previewStateKey } from "../data/appPreview";
import { readUtf8 } from "../server/fileIO";
import { missingDomMeasurements } from "../server/agent/agentDom";
import { AgentReadProgress } from "../server/agent/agentProgress";

import type { ChatMessage } from "../data/chatTypes";

it("does not mistake an initially selected first node for a broken explanation", async () => {
  const root = document.createElement("div");
  root.innerHTML = `<button data-node="one">一</button><button data-node="two">二</button><div id="explanation">第一个节点的机制和用途已经显示。</div>`;
  document.body.appendChild(root);
  try {
    let broken = false;
    const explanation = root.querySelector("#explanation")!;
    const select = (event: Event) => {
      const node = event.currentTarget as Element;
      if (broken && node.getAttribute("data-node") === "one") {
        return;
      }
      explanation.textContent =
        node.getAttribute("data-node") === "one"
          ? "第一个节点的机制和用途已经显示。"
          : "第二个节点拥有不同的机制与典型场景。";
    };
    for (const node of root.querySelectorAll("[data-node]")) {
      vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
        height: 44,
      } as DOMRect);
      node.addEventListener("click", select);
    }
    expect(await inspectNodeInteractions(document)).toEqual([]);
    broken = true;
    expect(await inspectNodeInteractions(document)).toEqual([
      expect.stringContaining("data-node=one"),
    ]);
  } finally {
    root.remove();
  }
});

it("interrupts identical successful read loops without reducing useful tool rounds", () => {
  const progress = new AgentReadProgress();
  const page = { startLine: 196, lineCount: 30 };
  for (let i = 0; i < 3; i++) {
    expect(progress.blocked("read_app_source", "hash-v1", page)).toBe(false);
    progress.record("read_app_source", "hash-v1", page);
  }
  expect(progress.stalled).toBe(true);
  expect(
    progress.blocked("read_app_source", "hash-v1", {
      lineCount: 30,
      startLine: 196,
    }),
  ).toBe(true);
  expect(progress.blocked("read_app_source", "hash-v2", page)).toBe(false);
  expect(
    progress.blocked("read_app_source", "hash-v1", { startLine: 226 }),
  ).toBe(false);
  progress.record("search_app_source", "hash-v1", { query: "handler" });
  expect(progress.stalled).toBe(false);
  progress.record("read_app_source", "hash-v1", page);
  progress.editing();
  expect(progress.stalled).toBe(false);
  for (let line = 1; line <= 100; line++) {
    progress.record("read_app_source", "hash-v1", { startLine: line });
    expect(progress.stalled).toBe(false);
  }
});

describe("source/runtime DOM consistency", () => {
  it("detects missing container IDs in deferred node selection without running app code", () => {
    const source = `<div id="diagram"></div><script>
    function selectNode() {
      const el = document.getElementById('diagram');
      if (el) {
        const container = document.getElementById('diagram-container');
        const r = el.getBoundingClientRect();
        const c = container.getBoundingClientRect();
      }
    }</script>`;
    expect(missingDomMeasurements(source, ["diagram"])).toEqual([
      expect.stringContaining("#diagram-container"),
    ]);
    expect(
      missingDomMeasurements(source, ["diagram", "diagram-container"]),
    ).toEqual([]);
    expect(missingDomMeasurements(source, Array(300).fill("id"))).toEqual([]);
  });
  it("does not flag guarded, optional, reassigned or lazy DOM lookups", () => {
    for (const use of [
      "if (el) { const r = el.getBoundingClientRect(); }",
      "const r = el?.getBoundingClientRect();",
      "if (!el) return; const r = el.getBoundingClientRect();",
      "el = createNode(); const r = el.getBoundingClientRect();",
      "const run = () => el.getBoundingClientRect();",
    ]) {
      expect(
        missingDomMeasurements(
          `<script>function check(){ let el=document.getElementById('optional'); ${use} }</script>`,
          [],
        ),
      ).toEqual([]);
    }
  });
});

describe("repository transient reads", () => {
  it("retries the same mounted file without creating a replacement identity", async () => {
    const read = vi
      .spyOn(fs, "readFile")
      .mockRejectedValueOnce(
        Object.assign(new Error("temporarily unavailable"), {
          code: "ENODATA",
        }),
      )
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EIO" }))
      .mockResolvedValueOnce("original source");
    try {
      expect(await readUtf8("./read-only-unit-fixture.html")).toBe(
        "original source",
      );
      expect(read).toHaveBeenCalledTimes(3);
      expect(
        read.mock.calls.every(
          (args) => args[0] === "./read-only-unit-fixture.html",
        ),
      ).toBe(true);
    } finally {
      read.mockRestore();
    }
  });
  it("does not mask a persistent missing file or retry permission errors", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const read = vi.spyOn(fs, "readFile").mockRejectedValue(missing);
    try {
      await expect(readUtf8("./read-only-unit-fixture.html")).rejects.toBe(
        missing,
      );
      expect(read).toHaveBeenCalledTimes(4);
      read.mockReset();
      const denied = Object.assign(new Error("denied"), { code: "EACCES" });
      read.mockRejectedValue(denied);
      await expect(readUtf8("./read-only-unit-fixture.html")).rejects.toBe(
        denied,
      );
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });
});

describe("agent task and recovery policy", () => {
  it("recognizes corrective follow-ups only in an app-task context, not ordinary questions", () => {
    const clarification =
      "你理解错了，我说的实际使用例子指的是，一般什么业务场景使用RR，什么使用RC";
    expect(agentTask(clarification, true, true)).toBe("edit");
    expect(agentTask(clarification, true, false)).toBe("chat");
    expect(agentTask(clarification, false, true)).toBe("chat");
    for (const question of [
      "你理解错了，只回答什么业务场景使用RR，不要改代码",
      "你理解错了，我说的是为什么要用RR？",
      "为什么标题改成了蓝色？",
      "如何添加一个新节点？",
      "不要修改，仅解释组件代码",
    ]) {
      expect(agentTask(question, true, true)).toBe("chat");
    }
    expect(agentTask("我想要的是业务场景对照，不是两条SQL", true, true)).toBe(
      "edit",
    );
    expect(
      agentTask("I meant business scenarios, not SQL examples", true, true),
    ).toBe("edit");
    expect(agentTask("再生成一个TCP流程组件", true, true)).toBe("create");
    expect(permitsSourceEdit("chat", false)).toBe(false);
    expect(permitsSourceEdit("edit", false)).toBe(true);
    expect(permitsSourceEdit("chat", true)).toBe(true);
  });
  it("binds follow-up intent to the last real app task, including legacy saved results", () => {
    const target = {
      kind: "element" as const,
      elementId: "selected",
      appId: "app",
    };
    const previous: ChatMessage = {
      id: "answer",
      turnId: "turn",
      role: "assistant",
      content: "已完成",
      status: "complete",
      createdAt: 1,
      agentTask: { kind: "edit", target },
    };
    expect(followsAppTask([previous], target)).toBe(true);
    expect(followsAppTask([previous], { ...target, elementId: "other" })).toBe(
      false,
    );
    expect(
      followsAppTask([previous], { ...target, appId: "new-instance" }),
    ).toBe(false);
    expect(followsAppTask([previous], undefined)).toBe(false);
    expect(
      followsAppTask(
        [{ ...previous, agentTask: { kind: "chat", target } }],
        target,
      ),
    ).toBe(false);
    expect(
      followsAppTask([previous, { ...previous, role: "user" }], target),
    ).toBe(false);
    const legacy: ChatMessage = {
      ...previous,
      agentTask: undefined,
      blocks: [
        {
          id: "result",
          type: "edit_result",
          text: "候选已保存",
          application: {
            elementId: target.elementId,
            appId: target.appId,
            sourceHash: "hash",
          },
        },
      ],
    };
    expect(followsAppTask([legacy], target)).toBe(false);
    legacy.activities = [
      {
        id: "actual",
        name: "edit_app_source",
        status: "complete",
        elementIds: [],
        snapshotAt: 1,
      },
    ];
    expect(followsAppTask([legacy], target)).toBe(true);
    expect(
      followsAppTask(
        [{ ...previous, agentTask: undefined, content: "修改成功" }],
        target,
      ),
    ).toBe(false);
    const chatTarget = { kind: "html" as const, artifactId: "artifact" };
    legacy.blocks = [
      {
        id: "saved",
        type: "html",
        ref: { kind: "html", artifactId: "artifact", version: 2 },
        saved: true,
        complete: true,
      },
    ];
    expect(followsAppTask([legacy], chatTarget)).toBe(true);
    expect(
      followsAppTask([legacy], { ...chatTarget, artifactId: "unrelated" }),
    ).toBe(false);
  });
  it("combines actual long-line pages without authorizing unseen gaps or other revisions", () => {
    const source = `<p>${"中文🙂".repeat(200)}</p>\n<footer>done</footer>`;
    const coverage = new SourceReadCoverage();
    const hash = sourceHash(source);
    const pages = [];
    let line = 1;
    let column = 0;
    while (line) {
      const page = readSourcePage(source, line, 1, 200, column);
      pages.push(page);
      line = page.nextLine || 0;
      column = page.nextColumn;
    }
    coverage.record(source, pages[0]);
    coverage.record(source, pages.at(-1)!);
    expect(coverage.firstUnread(hash, 1, 2)).toBe(1);
    for (const page of pages.slice(1, -1).reverse()) {
      coverage.record(source, page);
    }
    expect(coverage.firstUnread(hash, 1, 2)).toBeNull();
    expect(coverage.firstUnread(sourceHash(`${source}changed`), 1, 1)).toBe(1);
    expect(coverage.firstUnread(hash, 3, 3)).toBe(3);
  });
  it("preserves on-demand note reading for referenced creation/editing", () => {
    expect(
      needsNoteTools("create", "根据笔记中的矩阵A生成计算工具", true),
    ).toBe(true);
    expect(needsNoteTools("edit", "读取画布里的数据，修改当前组件", true)).toBe(
      true,
    );
    expect(
      needsNoteTools(
        "edit",
        "修改当前引用的画布组件：标题改为新标题。使用真实源码工具局部修改。",
        true,
      ),
    ).toBe(false);
    expect(needsNoteTools("create", "生成K8s架构图", true)).toBe(false);
    expect(needsNoteTools("chat", "解释当前画布", true)).toBe(true);
    expect(needsNoteTools("create", "根据笔记生成工具", false)).toBe(false);
  });
  it("replaces whole lines against an exact hash, preserves newline and rejects overlaps", () => {
    const source = "<main>\n  <p>中文</p>\n  <p>中文</p>\n</main>";
    const hash = sourceHash(source);
    expect(
      replaceSource(source, hash, [
        { startLine: 2, endLine: 2, newText: "  <p>更改</p>" },
      ]),
    ).toBe("<main>\n  <p>更改</p>\n  <p>中文</p>\n</main>");
    expect(() =>
      replaceSource(source, "stale", [
        { startLine: 2, endLine: 2, newText: "x" },
      ]),
    ).toThrow("版本");
    expect(() =>
      replaceSource(source, hash, [{ startLine: 0, endLine: 2, newText: "x" }]),
    ).toThrow("行范围");
    expect(() =>
      replaceSource(source, hash, [
        { startLine: 2, endLine: 3, newText: "x" },
        { startLine: 3, endLine: 3, newText: "y" },
      ]),
    ).toThrow("重叠");
  });
  it("separates explanations from required creations and edits", () => {
    expect(agentTask("你好，解释TCP", false)).toBe("chat");
    expect(agentTask("解释TCP和UDP，不需要生成应用", false)).toBe("chat");
    expect(agentTask("生成计算机网络全架构图", false)).toBe("create");
    expect(agentTask("创建详细K8s交互知识架构图", false)).toBe("create");
    expect(agentTask("把当前应用改为深色，添加搜索", true)).toBe("edit");
    expect(agentTask("不要修改，仅解释组件代码", true)).toBe("chat");
    expect(agentTask("再生成一个TCP流程组件", true)).toBe("create");
    expect(agentTask("生成一个番茄钟", true)).toBe("create");
    expect(agentTask("标题换成学习计时，去掉底栏", true)).toBe("edit");
    expect(agentTask("按钮点击没反应", true)).toBe("edit");
    expect(agentTask("为什么标题改成了蓝色？", true)).toBe("chat");
    expect(agentTask("如何添加一个新节点？", true)).toBe("chat");
    expect(agentTask("请解释这个组件里添加节点的代码", true)).toBe("chat");
    expect(agentTask("请分析错误并修复按钮", true)).toBe("edit");
  });
  it("requires real output and bounds automatic completion recovery", () => {
    const create = new AgentCompletion("create");
    expect(create.recover(true)).toBe(false);
    expect([
      create.recover(false),
      create.recover(false),
      create.recover(false),
      create.recover(false),
    ]).toEqual([true, true, true, false]);
    expect(new AgentCompletion("chat").recover(false)).toBe(false);
  });
});

describe("agent model-only working memory", () => {
  it("retains mixed recent groups and in-flight native arguments unchanged", () => {
    const call = (id: string) => ({
      id,
      type: "function",
      function: {
        name: "read_app_source",
        arguments: JSON.stringify({ startLine: 1, lineCount: 20 }),
      },
    });
    const group = {
      role: "assistant",
      tool_calls: [call("old"), call("recent")],
    };
    const pending = { role: "assistant", tool_calls: [call("pending")] };
    const messages: any[] = [
      group,
      { role: "tool", tool_call_id: "old", content: "x".repeat(1000) },
      { role: "tool", tool_call_id: "recent", content: "{}" },
      pending,
    ];
    compactAgentContext(messages, 1000);
    expect(messages[0]).toBe(group);
    expect(messages.at(-1)).toBe(pending);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });
  it("archives old source pages and arguments without breaking tool pairs", () => {
    const messages: any[] = [{ role: "system", content: "policy" }];
    for (let i = 0; i < 15; i++) {
      messages.push({
        role: "assistant",
        tool_calls: [
          {
            id: `call-${i}`,
            function: {
              name: "edit_app_source",
              arguments: JSON.stringify({
                sourceHash: "hash",
                edits: [{ oldText: "x".repeat(3000), newText: "y" }],
              }),
            },
          },
        ],
      });
      messages.push({
        role: "tool",
        tool_call_id: `call-${i}`,
        content: JSON.stringify({
          source: "x".repeat(6000),
          sourceHash: "hash",
          version: i,
        }),
      });
    }
    compactAgentContext(messages, 120000);
    expect(JSON.stringify(messages).length).toBeLessThan(50000);
    expect(messages[1].content).toContain('"sourceHash":"hash"');
    expect(JSON.stringify(messages)).not.toContain('"archived"');
    expect(messages.filter((m) => m.tool_calls)).toHaveLength(3);
    expect(
      JSON.parse(messages.at(-2).tool_calls[0].function.arguments).edits[0]
        .oldText.length,
    ).toBe(3000);
    expect(JSON.parse(messages.at(-1).content).source.length).toBe(6000);
    expect(
      messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    ).toEqual(
      messages.filter((m) => m.tool_calls).map((m) => m.tool_calls[0].id),
    );
  });
});

describe("agent upstream transport", () => {
  it("recovers transient pre-stream failures but never retries accepted streams", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockRejectedValueOnce(new Error("socket"))
      .mockResolvedValueOnce(new Response("data: stream"));
    const response = await requestAgentStream(fetcher, "http://fixture", {});
    expect(await response.text()).toBe("data: stream");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("does not retry authentication failures or user cancellation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("no", { status: 401 }));
    expect(
      (await requestAgentStream(fetcher, "http://fixture", {})).status,
    ).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const abort = new AbortController();
    abort.abort(new Error("stop"));
    await expect(
      requestAgentStream(fetcher, "http://fixture", { signal: abort.signal }),
    ).rejects.toThrow("stop");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("isolated application libraries", () => {
  it("mirrors pinned scripts at every split without touching comments or script strings", () => {
    const url = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";
    const before = `<main>中文</main><!-- <script src="${url}"></script> --><script>const s='<script src="${url}">';</script>`;
    const after = "<script>window.rendered=typeof d3;</script>";
    const source = `${before}<script src="${url}"></script>${after}`;
    for (let i = 0; i <= source.length; i++) {
      const stream = new HtmlLibraryStream();
      const pieces = [
        ...stream.push(source.slice(0, i)),
        ...stream.push(source.slice(i), true),
      ];
      expect(
        pieces.map((p) => ("html" in p ? p.html : `[${p.library}]`)).join(""),
      ).toBe(`${before}[d3]${after}`);
    }
  });
  it("allows pinned CDN scripts, not arbitrary URLs, latest, paths or inherited keys", () => {
    for (const url of APP_CDN_SCRIPTS) {
      expect(() =>
        validateAppSource(`<main>Hello</main><script src="${url}"></script>`),
      ).not.toThrow();
    }
    for (const url of [
      "https://evil.example/a.js",
      "https://cdn.jsdelivr.net/npm/d3@latest/dist/d3.min.js",
      "file:///secret",
    ]) {
      expect(() =>
        validateAppSource(`<script src="${url}"></script>`),
      ).toThrow();
    }
    expect(isAppLibrary("react")).toBe(true);
    expect(isAppLibrary("__proto__")).toBe(false);
  });
});

describe("real preview feedback", () => {
  it("preserves explicitly requested original node identities, not just a minimum count", () => {
    const baseline = {
      ids: [],
      nodes: 2,
      nodeKeys: ["etcd", "pod"],
      relations: 1,
      errors: [],
    };
    const candidate = { ...baseline, nodeKeys: ["pod", "review"] };
    expect(
      previewProblems(
        "新增review，保留全部原节点与交互",
        candidate,
        baseline,
      ).join(" "),
    ).toContain("etcd");
    expect(previewProblems("删除etcd节点", candidate, baseline)).toEqual([]);
    expect(previewStateKey({ forms: {}, custom: { filter: "all" } })).toBe(
      previewStateKey({ forms: {}, custom: { filter: "all" } }),
    );
    expect(previewStateKey({ forms: {}, custom: { filter: "all" } })).not.toBe(
      previewStateKey({ forms: {}, custom: { filter: "pod" } }),
    );
  });
  it("checks requested visible titles without treating arbitrary body text as a title", () => {
    const report = {
      ids: ["app-title"],
      nodes: 18,
      relations: 20,
      errors: [],
      title: "原版标题",
    };
    expect(
      previewProblems("标题改为“TCP · 第1次优化”；保留节点", report).join(" "),
    ).toContain("实际主标题");
    expect(
      previewProblems("主标题id=app-title，文字为“TCP详解”", {
        ...report,
        title: "TCP详解",
      }),
    ).toEqual([]);
    expect(previewProblems("添加一段说明，文字为“流程”", report)).toEqual([]);
    expect(
      previewProblems("标题改为“TCP”", { ...report, title: null }),
    ).toHaveLength(1);
  });
  it("detects invalid SVG coordinates, including transforms and paths", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML =
      '<svg><g id="bad" transform="translate(12, undefined)"><rect y="NaN" width="40"/></g><path d="M 0 0 L Infinity 10"/></svg>';
    expect(inspectSvgGeometry(doc)).toHaveLength(3);
    doc.body.innerHTML =
      '<svg viewBox="0 0 200 200"><path d="M 0 0 L 10 20"/></svg>';
    expect(inspectSvgGeometry(doc)).toEqual([]);
  });
  it("detects exact node collisions without rejecting nested groups", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML =
      '<svg><g data-node="pod"></g><g data-node="node"></g></svg>';
    for (const node of Array.from(doc.querySelectorAll("g"))) {
      node.getBoundingClientRect = () =>
        ({ left: 380, top: 200, width: 90, height: 44 } as DOMRect);
    }
    expect(inspectSvgGeometry(doc)).toHaveLength(1);
    const groups = doc.querySelectorAll("g");
    groups[1].getBoundingClientRect = () =>
      ({ left: 400, top: 208, width: 90, height: 44 } as DOMRect);
    expect(inspectSvgGeometry(doc)).toHaveLength(1);
    groups[0].appendChild(groups[1]);
    expect(inspectSvgGeometry(doc)).toEqual([]);
  });
  it("detects clipped nodes but does not guess about transformed pan/zoom wrappers", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<svg><g data-node="dhcp"></g></svg>';
    const svg = doc.querySelector("svg");
    const node = doc.querySelector("g");
    if (!svg || !node) {
      throw new Error("invalid SVG fixture");
    }
    svg.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 400,
        bottom: 520,
        width: 400,
        height: 520,
      } as DOMRect);
    node.getBoundingClientRect = () =>
      ({ left: 380, top: 340, width: 55, height: 40 } as DOMRect);
    expect(inspectSvgGeometry(doc)).toHaveLength(1);
    const viewport = doc.createElementNS("http://www.w3.org/2000/svg", "g");
    viewport.setAttribute("transform", "scale(2)");
    svg.appendChild(viewport);
    viewport.appendChild(node);
    expect(inspectSvgGeometry(doc)).toEqual([]);
  });
  it("rejects unreadably scaled selectable SVG nodes, not nested labels", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<svg><g data-node="tcp"></g></svg>';
    const node = doc.querySelector("g")!;
    node.getBoundingClientRect = () =>
      ({ left: 10, top: 10, width: 40, height: 12 } as DOMRect);
    expect(inspectSvgGeometry(doc).join(" ")).toContain("max-width:none");
    node.getBoundingClientRect = () =>
      ({ left: 10, top: 10, width: 140, height: 44 } as DOMRect);
    expect(inspectSvgGeometry(doc)).toEqual([]);
  });
  it("checks actual runtime errors, explicit node counts and IDs without claiming visual quality", () => {
    expect(
      previewProblems("增加data-node=review", {
        ids: ["title", "title"],
        nodes: 2,
        relations: 1,
        errors: [],
        nodeKeys: ["a", "b"],
      }),
    ).toHaveLength(2);
    expect(
      previewProblems("至少16个可点击知识节点，标题id=app-title", {
        ids: ["app-title"],
        nodes: 14,
        relations: 20,
        errors: [],
      }),
    ).toHaveLength(1);
    expect(
      previewProblems("至少10个可点击步骤", {
        ids: [],
        nodes: 8,
        relations: 7,
        errors: ["不支持的局部更新字段"],
      }),
    ).toHaveLength(2);
    expect(
      previewProblems("生成架构图", {
        ids: [],
        nodes: 20,
        relations: 25,
        errors: [],
      }),
    ).toEqual([]);
  });
  it("rejects foreign/stale/malformed reports and responds to cancellation", async () => {
    const previews = new AgentPreviews();
    const report = { ids: ["app"], nodes: 3, relations: 2, errors: [] };
    expect(previews.report("foreign", 1, report)).toBe(false);
    previews.expect("app", 1);
    expect(previews.report("app", 2, report)).toBe(false);
    expect(previews.report("app", 1, { ...report, nodes: -1 })).toBe(false);
    const abort = new AbortController();
    const pending = previews.wait("app", 1, abort.signal);
    expect(previews.report("app", 1, report)).toBe(true);
    expect(await pending).toEqual(report);
    const waiting = previews.wait("app", 2, abort.signal);
    abort.abort(new Error("用户停止"));
    await expect(waiting).rejects.toThrow("用户停止");
  });
});

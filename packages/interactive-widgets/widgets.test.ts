import { describe, expect, it } from "vitest";

import { EXAMPLES } from "./examples";
import { ARCHITECTURE, WORKFLOW, SCENARIO } from "./designExamples";
import { applyAction, computeWidget } from "./compute";
import { readWidget, reconcileState, validateDefinition } from "./schema";
import { layoutWidget } from "./layout";
import { renderSnapshot } from "./snapshot";
import { renderFormula } from "./formula";
import { WidgetRuntimeState } from "./runtimeState";
import { layoutKey, rememberLayout } from "./layoutCache";

import type { ResolvedNode, WidgetDocument } from "./types";

const flatten = (node: ResolvedNode): ResolvedNode[] => [
  node,
  ...node.children.flatMap(flatten),
];
const document = (name: string): WidgetDocument => ({
  version: 1,
  catalogVersion: 1,
  definition: EXAMPLES[name],
  state: structuredClone(EXAMPLES[name].initialState),
  prompt: name,
});
describe("interactive component runtime", () => {
  it("links segmented choice, multiline text and conditional content without code", () => {
    validateDefinition(SCENARIO);
    const state = {
      ...SCENARIO.initialState,
      mode: "协作",
      details: true,
      note: "第一行\n第二行 <script>",
    };
    const { tree } = computeWidget(SCENARIO, state);
    expect(
      flatten(tree).find((node) => node.id === "explanation")?.value,
    ).toContain("共享");
    expect(flatten(tree).find((node) => node.id === "previewText")?.value).toBe(
      state.note,
    );
    const wide = layoutWidget(tree, 700);
    const narrow = layoutWidget(tree, 220);
    const choice = (layout: typeof wide) =>
      layout.boxes.find((box) => box.node.type === "segmented")!;
    expect(choice(narrow).height).toBeGreaterThan(choice(wide).height);
    expect(choice(narrow).segments).toHaveLength(3);
    expect(
      narrow.boxes.find((box) => box.node.type === "textarea")?.lines,
    ).toContain("第一行");
    const svg = renderSnapshot(
      {
        version: 2,
        catalogVersion: 2,
        definition: SCENARIO,
        state,
        prompt: "",
      },
      700,
      900,
    );
    expect(svg).toContain("#ededfc");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
    expect(
      flatten(computeWidget(SCENARIO, SCENARIO.initialState).tree).some(
        (node) => node.id === "notePreview",
      ),
    ).toBe(false);
  });
  it("rejects unusable segmented choices and preserves only compatible input", () => {
    const invalid = structuredClone(SCENARIO);
    invalid.root.children![1].options = ["专注", "专注"];
    expect(() => validateDefinition(invalid)).toThrow(/不重复/);
    invalid.root.children![1].options = ["一", "二"];
    expect(() => validateDefinition(invalid)).toThrow(/初始值/);
    const previous: WidgetDocument = {
      version: 2,
      catalogVersion: 2,
      definition: SCENARIO,
      state: { ...SCENARIO.initialState, mode: "休息" },
      prompt: "",
    };
    expect(reconcileState(previous, SCENARIO).state.mode).toBe("休息");
    const revised = structuredClone(SCENARIO);
    revised.root.children![1].options = ["专注", "协作"];
    expect(reconcileState(previous, revised).state.mode).toBe("专注");
  });
  it("shares a transient state source without resetting it when a second surface opens", () => {
    const committed = { a: 1 };
    const runtime = new WidgetRuntimeState(committed);
    runtime.set({ a: 9 });
    runtime.acceptDocument(committed);
    expect(runtime.state.a).toBe(9);
    runtime.acceptDocument({ a: 2 });
    expect(runtime.state.a).toBe(2);
  });
  it("uses the actual measured layout for both interactive content and SVG", () => {
    const doc = document("calculator");
    const { tree } = computeWidget(doc.definition, doc.state);
    const layout = layoutWidget(tree, 640, (text) => text.length * 20);
    const title = layout.boxes.find((box) => box.node.type === "title")!;
    title.lines = ["Shared measured line"];
    rememberLayout(layoutKey(doc.definition, doc.state, 640), layout);
    expect(renderSnapshot(doc, 640, 600)).toContain("Shared measured line");
  });
  for (const definition of [ARCHITECTURE, WORKFLOW]) {
    it(`lays out v2 diagram groups and feedback paths: ${definition.title}`, () => {
      validateDefinition(definition);
      const { tree } = computeWidget(definition, definition.initialState);
      const layout = layoutWidget(tree, 900);
      expect(layout.edges.length).toBeGreaterThan(3);
      expect(
        layout.edges.every((edge) => !/NaN|undefined/.test(edge.path)),
      ).toBe(true);
      expect(
        renderSnapshot(
          {
            version: 2,
            catalogVersion: 2,
            definition,
            state: definition.initialState,
            prompt: "",
          },
          900,
          800,
        ),
      ).toContain("marker-end");
      expect(
        readWidget({
          version: 2,
          catalogVersion: 2,
          definition,
          state: definition.initialState,
          prompt: "",
        }),
      ).not.toBeNull();
    });
  }
  it("rejects diagram references to nested content and duplicate relation ids", () => {
    const definition = structuredClone(WORKFLOW);
    const diagram = definition.root.children!.find(
      (node) => node.type === "diagram",
    )!;
    diagram.relations![0].from = "missing";
    expect(() => validateDefinition(definition)).toThrow(/端点/);
    diagram.relations![0].from = "request";
    diagram.relations![1].id = diagram.relations![0].id;
    expect(() => validateDefinition(definition)).toThrow(/重复/);
  });
  it("renders trusted fraction and script SVG identically for UI and export", () => {
    const svg = renderFormula("\\frac{x^2}{\\sqrt{d}}", 240, 100);
    expect(svg).toContain("<path");
    expect(svg).toContain("√");
    expect(svg).not.toContain("<foreignObject");
    expect(svg).not.toContain("<script");
    expect(renderFormula("<script>alert(1)</script>", 240, 100)).not.toContain(
      "<script",
    );
  });
  for (const [name, def] of Object.entries(EXAMPLES)) {
    it(`validates and renders the ${name} application`, () => {
      expect(validateDefinition(def)).toBe(def);
      const result = computeWidget(def, def.initialState);
      expect(result.errors).toEqual({});
      const snapshot = renderSnapshot(document(name), 640, 500);
      expect(snapshot).toContain("<svg");
      expect(snapshot).not.toContain("<script");
    });
  }
  it("clicks a repeated card and updates highlights and the dictionary explanation", () => {
    const def = EXAMPLES.kubernetes;
    const nodes = flatten(computeWidget(def, def.initialState).tree);
    const etcd = nodes.find(
      (n) =>
        n.type === "pressable" &&
        n.locals.item &&
        typeof n.locals.item === "object" &&
        !Array.isArray(n.locals.item) &&
        n.locals.item.id === "etcd",
    )!;
    const state = applyAction(def, def.initialState, etcd.action!, etcd.locals);
    expect(state.selected).toBe("etcd");
    const next = flatten(computeWidget(def, state).tree);
    expect(
      next.find((n) => n.instanceId === etcd.instanceId)?.resolved.selected,
    ).toBe(true);
    expect(next.find((n) => n.id === "detail")?.value).toContain("Raft");
    expect(applyAction(def, state, { type: "reset" })).toEqual(
      def.initialState,
    );
  });
  it("keeps stable repeat identity after reordering data", () => {
    const def = structuredClone(EXAMPLES.kubernetes);
    const before = flatten(computeWidget(def, def.initialState).tree)
      .map((n) => n.instanceId)
      .sort();
    (def.datasets!.concepts as unknown[]).reverse();
    expect(
      flatten(computeWidget(def, def.initialState).tree)
        .map((n) => n.instanceId)
        .sort(),
    ).toEqual(before);
  });
  it("rejects duplicate keys and cyclic derived values", () => {
    const def = structuredClone(EXAMPLES.kubernetes);
    def.datasets!.concepts = [
      { id: "same", name: "A" },
      { id: "same", name: "B" },
    ];
    expect(() => computeWidget(def, def.initialState)).toThrow("重复键");
    const cycle = structuredClone(EXAMPLES.calculator);
    cycle.computations = { answer: { ref: "other" }, other: { ref: "answer" } };
    expect(() => validateDefinition(cycle)).toThrow("循环");
  });
  it("rejects executable properties, prototype queries and malformed operation arity", () => {
    const def = structuredClone(EXAMPLES.calculator);
    expect(() => validateDefinition({ ...def, script: "alert(1)" })).toThrow();
    def.root.bindings = { text: { ref: "a.__proto__" } };
    expect(() => validateDefinition(def)).toThrow("属性查询");
    delete def.root.bindings;
    def.computations.answer = { op: "div", args: [{ literal: 1 }] };
    expect(() => validateDefinition(def)).toThrow("参数数量");
  });
  it("reports the position of nonnumeric matrix cells and preserves string display", () => {
    const def = structuredClone(EXAMPLES.matrix);
    const result = computeWidget(def, {
      m: [
        ["symbol", 0],
        [0, 1],
      ],
    });
    expect(Object.values(result.errors).join(" ")).toContain(
      "第 1 行、第 1 列",
    );
    expect(flatten(result.tree).find((n) => n.id === "letters")?.value).toEqual(
      [
        ["a", "b"],
        ["hello", "world"],
      ],
    );
  });
  it("computes stable Softmax and enforces sampling limits", () => {
    const def = structuredClone(EXAMPLES.attention);
    const result = computeWidget(def, def.initialState);
    const weights = result.outputs.weights as number[][];
    weights.forEach((row) =>
      expect(row.reduce((sum, n) => sum + n, 0)).toBeCloseTo(1),
    );
    def.computations.weights = {
      op: "sample",
      args: [{ literal: 0 }, { literal: 1 }, { literal: 2001 }, { ref: "x" }],
    };
    expect(
      Object.values(computeWidget(def, def.initialState).errors).join(" "),
    ).toContain("2–2000");
  });
  it("reflows rows at narrow widths and escapes snapshot text", () => {
    const doc = document("calculator");
    const tree = computeWidget(doc.definition, doc.state).tree;
    const wide = layoutWidget(tree, 640).boxes;
    const narrow = layoutWidget(tree, 280).boxes;
    expect(wide.find((b) => b.node.id === "a")!.y).toBe(
      wide.find((b) => b.node.id === "b")!.y,
    );
    expect(narrow.find((b) => b.node.id === "b")!.y).toBeGreaterThan(
      narrow.find((b) => b.node.id === "a")!.y,
    );
    doc.definition = structuredClone(doc.definition);
    doc.definition.root.children![0].text = '<script>alert("x")</script>';
    const svg = renderSnapshot(doc, 640, 500);
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
  });
  it("preserves compatible state and rejects unsupported document versions", () => {
    const doc = document("calculator");
    doc.state.a = 17;
    expect(reconcileState(doc, doc.definition).state.a).toBe(17);
    const next = structuredClone(doc.definition);
    next.root.children![1].children![0].type = "input";
    next.initialState.a = "";
    expect(reconcileState(doc, next).reset).toContain("A");
    expect(readWidget({ ...doc, catalogVersion: 9 })).toBeNull();
  });
  it("resets dictionary selections removed by an AI modification", () => {
    const doc = document("kubernetes");
    doc.state.selected = "etcd";
    const next = structuredClone(doc.definition);
    delete (next.datasets!.facts as Record<string, unknown>).etcd;
    const merged = reconcileState(doc, next);
    expect(merged.state.selected).toBe(next.initialState.selected);
    expect(merged.reset.length).toBeGreaterThan(0);
  });
  it("applies batch actions sequentially without mutating the old state", () => {
    const def = EXAMPLES.calculator;
    const state = applyAction(def, def.initialState, {
      type: "batch",
      actions: [
        { type: "set", target: "a", value: { literal: 10 } },
        { type: "set", target: "b", value: { ref: "a" } },
      ],
    });
    expect(state).toMatchObject({ a: 10, b: 10 });
    expect(def.initialState.a).toBe(3);
  });
});

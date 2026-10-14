import { describe, expect, it } from "vitest";

import { EXAMPLES } from "./examples";
import { applyAction, computeWidget } from "./compute";
import { readWidget, reconcileState, validateDefinition } from "./schema";
import { layoutWidget } from "./layout";
import { renderSnapshot } from "./snapshot";
import { renderFormula } from "./formula";

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

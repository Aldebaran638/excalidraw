import { CATALOG, isContainer } from "./catalog";
import { validateDefinition, validateValue } from "./schema";

import type { WidgetDocument, WidgetNode, WidgetState } from "./types";

export type WidgetGenerationProgress = {
  generationId: string;
  attempt: number;
  sequence: number;
  phase: "waiting" | "generating" | "repairing" | "validating";
  document?: WidgetDocument;
  completedNodes: number;
};

/** Parses only actual received tokens. Open containers are retained as shells;
 * unfinished strings/numbers are never guessed or executed. */
export const previewFromJSONPrefix = (
  source: string,
): {
  document: WidgetDocument;
  completedNodes: number;
} | null => {
  if (source.length > 262144) {
    throw new Error("组件定义过大");
  }
  const text = source.trimStart().replace(/^```(?:json)?\s*/, "");
  let offset = 0;
  let count = 0;
  const closed = new WeakSet<object>();
  const space = () => {
    while (/\s/.test(text[offset] || "X")) {
      offset++;
    }
  };
  const string = (): string | undefined => {
    const start = offset++;
    let escaped = false;
    while (offset < text.length) {
      const character = text[offset++];
      if (!escaped && character === '"') {
        return JSON.parse(text.slice(start, offset));
      }
      if (!escaped && character === "\\") {
        escaped = true;
      } else {
        escaped = false;
      }
    }
    return undefined;
  };
  const value = (depth: number): unknown => {
    if (depth > 40 || ++count > 16000) {
      throw new Error("组件预览超过解析预算");
    }
    space();
    const token = text[offset];
    if (token === '"') {
      return string();
    }
    if (token === "{" || token === "[") {
      const array = token === "[";
      const result: any = array ? [] : Object.create(null);
      offset++;
      space();
      while (offset < text.length) {
        if (text[offset] === (array ? "]" : "}")) {
          offset++;
          closed.add(result);
          return result;
        }
        let key: string | undefined;
        if (!array) {
          if (text[offset] !== '"') {
            throw new Error("无效 JSON 属性");
          }
          key = string();
          if (key === undefined) {
            return result;
          }
          if (["__proto__", "constructor", "prototype"].includes(key)) {
            throw new Error("不允许的属性名称");
          }
          space();
          if (offset === text.length) {
            return result;
          }
          if (text[offset++] !== ":") {
            throw new Error("无效 JSON 属性分隔符");
          }
        }
        const child = value(depth + 1);
        if (child !== undefined) {
          if (array) {
            result.push(child);
          } else {
            result[key!] = child;
          }
        }
        space();
        if (offset === text.length) {
          return result;
        }
        if (text[offset] === ",") {
          offset++;
          space();
        } else if (text[offset] !== (array ? "]" : "}")) {
          throw new Error("无效 JSON 分隔符");
        }
      }
      return result;
    }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/.test(text[offset])) {
      offset++;
    }
    if (offset === text.length) {
      return undefined;
    }
    return JSON.parse(text.slice(start, offset));
  };
  try {
    const input = value(0) as any;
    if (!input || !input.root) {
      return null;
    }
    const state: WidgetState = {};
    let completedNodes = 0;
    const project = (raw: any): WidgetNode | null => {
      if (
        !raw ||
        typeof raw.id !== "string" ||
        typeof raw.type !== "string" ||
        !Object.hasOwn(CATALOG, raw.type)
      ) {
        return null;
      }
      const shell = isContainer(raw.type) && Array.isArray(raw.children);
      if (!closed.has(raw) && !shell) {
        return null;
      }
      if (closed.has(raw)) {
        completedNodes++;
      }
      if (completedNodes > 300) {
        throw new Error("组件过多");
      }
      const node: WidgetNode = { id: raw.id, type: raw.type };
      for (const key of [
        "text",
        "label",
        "min",
        "max",
        "step",
        "columns",
        "icon",
        "chartType",
        "options",
        "style",
      ] as const) {
        if (
          raw[key] !== undefined &&
          (typeof raw[key] !== "object" || closed.has(raw[key]))
        ) {
          (node as any)[key] = raw[key];
        }
      }
      if (shell) {
        node.children = raw.children.map(project).filter(Boolean);
      }
      // Graph endpoints and repeated templates require the final dependency graph.
      if (["diagram", "group", "repeat"].includes(node.type)) {
        node.type = "column";
      }
      const initial = input.initialState;
      if (
        typeof raw.bind === "string" &&
        initial &&
        Object.hasOwn(initial, raw.bind) &&
        validateValue(initial[raw.bind])
      ) {
        node.bind = raw.bind;
        state[raw.bind] = initial[raw.bind];
      }
      const data = raw.data;
      const literal =
        data && Object.hasOwn(data, "literal")
          ? data.literal
          : data &&
            typeof data.ref === "string" &&
            Object.hasOwn(input.datasets || {}, data.ref)
          ? input.datasets[data.ref]
          : data &&
            typeof data.ref === "string" &&
            Object.hasOwn(initial || {}, data.ref)
          ? initial[data.ref]
          : undefined;
      if (literal !== undefined && validateValue(literal)) {
        node.data = { literal };
      }
      if (
        ([
          "number",
          "input",
          "textarea",
          "slider",
          "select",
          "segmented",
          "toggle",
          "player",
        ].includes(node.type) &&
          !node.bind) ||
        ([
          "chart",
          "geometry",
          "matrix",
          "table",
          "heatmap",
          "result",
          "formula",
        ].includes(node.type) &&
          !node.data &&
          !node.bind)
      ) {
        node.type = "text";
        node.text = `${node.label || raw.type} · 等待数据与计算校验`;
        delete node.chartType;
      }
      // Never copy actions, bindings, computed expressions or remote resources.
      return node;
    };
    const root = project(input.root);
    if (!root || !completedNodes) {
      return null;
    }
    const definition = validateDefinition({
      version: 2,
      title: typeof input.title === "string" ? input.title : "搭建中的组件",
      initialState: state,
      computations: {},
      root,
    });
    return {
      document: {
        version: 2,
        catalogVersion: 2,
        definition,
        state,
        prompt: "",
      },
      completedNodes,
    };
  } catch {
    return null;
  }
};

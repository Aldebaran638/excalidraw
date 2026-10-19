import Ajv from "ajv";

import { CATALOG, ICONS, OPERATIONS } from "./catalog";
import { INPUT_TYPES, LIMITS } from "./types";

import type {
  Expression,
  Value,
  WidgetDefinition,
  WidgetDocument,
  WidgetNode,
} from "./types";

const ref = (name: string) => ({ $ref: `#/definitions/${name}` });
const expression = ref("expression");
const color = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
const styleProperties = {
  background: color,
  color,
  borderColor: color,
  padding: { type: "integer", minimum: 0, maximum: 32 },
  gap: { type: "integer", minimum: 0, maximum: 32 },
  radius: { type: "integer", minimum: 0, maximum: 24 },
  fontSize: { type: "integer", minimum: 12, maximum: 32 },
  align: { enum: ["start", "center", "end"] },
  weight: { enum: ["normal", "medium", "bold"] },
};
export const widgetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "title", "root", "initialState", "computations"],
  properties: {
    version: { enum: [1, 2] },
    title: { type: "string", maxLength: 200 },
    root: ref("node"),
    datasets: {
      type: "object",
      maxProperties: 100,
      additionalProperties: ref("value"),
    },
    initialState: {
      type: "object",
      maxProperties: 100,
      additionalProperties: ref("value"),
    },
    computations: {
      type: "object",
      maxProperties: 100,
      additionalProperties: expression,
    },
  },
  definitions: {
    value: {
      anyOf: [
        { type: ["string", "number", "boolean", "null"] },
        { type: "array", maxItems: 2000, items: ref("value") },
        {
          type: "object",
          maxProperties: 2000,
          additionalProperties: ref("value"),
        },
      ],
    },
    expression: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["literal"],
          properties: { literal: ref("value") },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["ref"],
          properties: { ref: { type: "string", maxLength: 160 } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["op", "args"],
          properties: {
            op: { enum: OPERATIONS },
            args: { type: "array", maxItems: 100, items: expression },
          },
        },
      ],
    },
    action: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { enum: ["set", "toggle", "reset", "step", "batch"] },
        target: { type: "string" },
        value: expression,
        actions: { type: "array", maxItems: 20, items: ref("action") },
      },
    },
    node: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type"],
      properties: {
        id: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,79}$" },
        type: { enum: Object.keys(CATALOG) },
        label: { type: "string", maxLength: 500 },
        text: { type: "string", maxLength: 10000 },
        bind: { type: "string" },
        data: expression,
        children: { type: "array", maxItems: 300, items: ref("node") },
        min: { type: "number" },
        max: { type: "number" },
        step: { type: "number", exclusiveMinimum: 0 },
        options: { type: "array", maxItems: 100, items: { type: "string" } },
        chartType: { enum: ["line", "scatter", "bar"] },
        action: ref("action"),
        style: {
          type: "object",
          additionalProperties: false,
          properties: styleProperties,
        },
        columns: { type: "integer", minimum: 1, maximum: 6 },
        icon: { enum: Object.keys(ICONS) },
        items: expression,
        itemKey: { type: "string" },
        direction: { enum: ["LR", "TB"] },
        relations: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "from", "to"],
            properties: {
              id: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,79}$" },
              from: { type: "string" },
              to: { type: "string" },
              label: { type: "string", maxLength: 100 },
              directed: { type: "boolean" },
            },
          },
        },
        bindings: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            [
              "text",
              "visible",
              "disabled",
              "selected",
              "background",
              "color",
              "borderColor",
            ].map((k) => [k, expression]),
          ),
        },
      },
    },
  },
};
const validate = new Ajv({ allErrors: true }).compile(widgetSchema);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const identifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
export const walkNodes = (root: WidgetNode): WidgetNode[] => [
  root,
  ...(root.children || []).flatMap(walkNodes),
];
export const validateValue = (v: unknown, depth = 0): v is Value => {
  if (depth > 16) {
    return false;
  }
  if (v === null || typeof v === "boolean") {
    return true;
  }
  if (typeof v === "number") {
    return Number.isFinite(v);
  }
  if (typeof v === "string") {
    return v.length <= 10000;
  }
  if (Array.isArray(v)) {
    return (
      v.length <= LIMITS.points && v.every((x) => validateValue(x, depth + 1))
    );
  }
  if (v && typeof v === "object") {
    return (
      Object.keys(v).length <= LIMITS.points &&
      Object.entries(v).every(
        ([k, x]) => !forbidden.has(k) && validateValue(x, depth + 1),
      )
    );
  }
  return false;
};
export const validateDefinition = (input: unknown): WidgetDefinition => {
  const text = JSON.stringify(input);
  if (!text || text.length > 262144) {
    throw new Error("组件定义过大或为空");
  }
  const inspect = (v: unknown, depth: number) => {
    if (depth > 40) {
      throw new Error("组件嵌套过深");
    }
    if (v && typeof v === "object") {
      Object.entries(v).forEach(([k, child]) => {
        if (forbidden.has(k)) {
          throw new Error("不允许的属性名称");
        }
        inspect(child, depth + 1);
      });
    }
  };
  inspect(input, 0);
  if (!validate(input)) {
    throw new Error(
      `组件格式不正确: ${validate.errors
        ?.slice(0, 5)
        .map((e) => `${e.dataPath} ${e.message}`)
        .join("; ")}`,
    );
  }
  const def = input as WidgetDefinition;
  const nodes = walkNodes(def.root);
  if (
    nodes.length > LIMITS.nodes ||
    new Set(nodes.map((n) => n.id)).size !== nodes.length
  ) {
    throw new Error("组件过多或 ID 重复");
  }
  const namespaces = [def.initialState, def.computations, def.datasets || {}];
  const keys = namespaces.flatMap(Object.keys);
  if (new Set(keys).size !== keys.length) {
    throw new Error("变量名称重复");
  }
  for (const key of keys) {
    if (
      !identifier.test(key) ||
      forbidden.has(key) ||
      ["x", "item", "index", "time"].includes(key)
    ) {
      throw new Error(`无效变量名: ${key}`);
    }
  }
  for (const v of [
    ...Object.values(def.initialState),
    ...Object.values(def.datasets || {}),
  ]) {
    if (!validateValue(v)) {
      throw new Error("数据超出限制");
    }
  }
  const refs = (expr: Expression, local = false): string[] => {
    if ("ref" in expr) {
      const parts = expr.ref.split(".");
      const key = parts[0];
      if (parts.some((p) => forbidden.has(p))) {
        throw new Error("不允许的属性查询");
      }
      if (local && ["item", "index", "x"].includes(key)) {
        return [];
      }
      if (key === "time") {
        return [];
      }
      if (!keys.includes(key)) {
        throw new Error(`未定义变量: ${key}`);
      }
      return [key];
    }
    if (!("op" in expr)) {
      if (!validateValue(expr.literal)) {
        throw new Error("无效字面量");
      }
      return [];
    }
    const arities: Record<string, number> = {
      sub: 2,
      div: 2,
      pow: 2,
      neg: 1,
      sqrt: 1,
      exp: 1,
      log: 1,
      sin: 1,
      cos: 1,
      tan: 1,
      abs: 1,
      round: 1,
      sum: 1,
      mean: 1,
      eq: 2,
      lt: 2,
      gt: 2,
      and: 2,
      or: 2,
      not: 1,
      if: 3,
      get: 2,
      lookup: 2,
      keys: 1,
      string: 1,
      length: 1,
      transpose: 1,
      matmul: 2,
      dot: 2,
      softmax: 1,
      scale: 2,
      transform2d: 2,
      sample: 4,
      filter: 2,
      map: 2,
    };
    if (
      arities[expr.op] !== undefined &&
      expr.args.length !== arities[expr.op]
    ) {
      throw new Error(`${expr.op} 参数数量不正确`);
    }
    return expr.args.flatMap((a, i) =>
      refs(
        a,
        local ||
          (["sample", "map", "filter"].includes(expr.op) &&
            i === expr.args.length - 1),
      ),
    );
  };
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) {
      throw new Error("计算关系存在循环");
    }
    if (done.has(key) || !Object.hasOwn(def.computations, key)) {
      return;
    }
    visiting.add(key);
    refs(def.computations[key]).forEach(visit);
    visiting.delete(key);
    done.add(key);
  };
  Object.keys(def.computations).forEach(visit);
  const checkAction = (
    action: NonNullable<WidgetNode["action"]>,
    local: boolean,
  ) => {
    if (action.type === "batch") {
      if (!action.actions?.length) {
        throw new Error("批量动作为空");
      }
      action.actions.forEach((a) => checkAction(a, local));
    } else if (
      action.type !== "reset" &&
      (!action.target || !Object.hasOwn(def.initialState, action.target))
    ) {
      throw new Error("按钮目标输入不存在");
    }
    if (action.type === "set" && !action.value) {
      throw new Error("赋值动作缺少值");
    }
    if (action.value) {
      refs(action.value, local);
    }
  };
  const visitNode = (node: WidgetNode, local: boolean) => {
    if (node.type === "diagram") {
      const descendants = (node.children || []).flatMap(walkNodes);
      const endpoints = descendants.filter(
        (n) =>
          n.type === "group" || n.type === "pressable" || n.type === "card",
      );
      if (endpoints.length > 60) {
        throw new Error("单图最多 60 个节点");
      }
      const explicit: WidgetNode[] = [];
      const collect = (children: WidgetNode[]) =>
        children.forEach((child) => {
          if (child.type === "group") {
            collect(child.children || []);
          } else if (["card", "pressable"].includes(child.type)) {
            explicit.push(child);
          } else {
            throw new Error(
              "图节点必须为 Card、Pressable 或 Group，不能使用重复模板",
            );
          }
        });
      collect(node.children || []);
      const ids = new Set(explicit.map((n) => n.id));
      const relations = new Set<string>();
      for (const relation of node.relations || []) {
        if (
          relations.has(relation.id) ||
          !ids.has(relation.from) ||
          !ids.has(relation.to)
        ) {
          throw new Error("图关系标识重复或端点不存在");
        }
        relations.add(relation.id);
      }
    } else if (node.relations || node.direction) {
      throw new Error("关系与方向仅用于 Diagram");
    }
    if (node.bind && !Object.hasOwn(def.initialState, node.bind)) {
      throw new Error(`输入绑定不存在: ${node.bind}`);
    }
    if (INPUT_TYPES.includes(node.type) && !node.bind) {
      throw new Error(`${node.type} 需要绑定输入`);
    }
    if (
      ["number", "slider", "player"].includes(node.type) &&
      typeof def.initialState[node.bind!] !== "number"
    ) {
      throw new Error("数字控件需要数字初始值");
    }
    if (
      node.type === "toggle" &&
      typeof def.initialState[node.bind!] !== "boolean"
    ) {
      throw new Error("开关需要布尔初始值");
    }
    if (
      ["input", "textarea"].includes(node.type) &&
      typeof def.initialState[node.bind!] !== "string"
    ) {
      throw new Error("文本控件需要字符串初始值");
    }
    if (["matrix", "table"].includes(node.type) && node.bind) {
      const rows = def.initialState[node.bind];
      if (
        !Array.isArray(rows) ||
        rows.length > 20 ||
        rows.some((r) => !Array.isArray(r) || r.length > 20)
      ) {
        throw new Error("矩阵/表格必须是最多 20×20 的二维数组");
      }
    }
    if (
      node.min !== undefined &&
      node.max !== undefined &&
      node.min >= node.max
    ) {
      throw new Error("输入范围不正确");
    }
    if (["select", "segmented"].includes(node.type)) {
      const options = node.options;
      if (
        !options?.length ||
        ((def.version === 2 || node.type === "segmented") &&
          (new Set(options).size !== options.length ||
            typeof def.initialState[node.bind!] !== "string" ||
            !options.includes(String(def.initialState[node.bind!]))))
      ) {
        throw new Error("选择控件需要不重复的选项，且初始值必须属于选项");
      }
      if (
        node.type === "segmented" &&
        (options.length < 2 ||
          options.length > 6 ||
          options.some((option) => !option.trim() || option.length > 32))
      ) {
        throw new Error("分段选择需要 2–6 个非空选项，每个最多 32 字符");
      }
    }
    if (node.type === "repeat" && (!node.items || !node.children?.length)) {
      throw new Error("重复组件缺少数据或模板");
    }
    if (node.data) {
      refs(node.data, local);
    }
    if (node.items) {
      refs(node.items, local);
    }
    Object.values(node.bindings || {}).forEach((expr) => refs(expr!, local));
    if (node.action) {
      checkAction(node.action, local);
    }
    node.children?.forEach((child) =>
      visitNode(child, local || node.type === "repeat"),
    );
  };
  visitNode(def.root, false);
  return def;
};
export const readWidget = (data: unknown): WidgetDocument | null => {
  try {
    const w = data as WidgetDocument;
    if (
      ![1, 2].includes(w.version) ||
      w.catalogVersion !== w.version ||
      w.definition?.version !== w.version ||
      typeof w.prompt !== "string"
    ) {
      return null;
    }
    validateDefinition(w.definition);
    if (!w.state || typeof w.state !== "object" || Array.isArray(w.state)) {
      return null;
    }
    if (
      Object.entries(w.state).some(
        ([k, v]) =>
          !Object.hasOwn(w.definition.initialState, k) || !validateValue(v),
      )
    ) {
      return null;
    }
    return w;
  } catch {
    return null;
  }
};
export const reconcileState = (
  previous: WidgetDocument | null,
  definition: WidgetDefinition,
) => {
  const state = structuredClone(definition.initialState);
  const reset: string[] = [];
  const oldNodes = previous ? walkNodes(previous.definition.root) : [];
  const lookupConstraints = new Map<string, Value[]>();
  const inspectQuery = (expr: Expression) => {
    if (!("op" in expr)) {
      return;
    }
    if (
      expr.op === "lookup" &&
      expr.args.length === 2 &&
      "ref" in expr.args[0] &&
      "ref" in expr.args[1]
    ) {
      const dataset = definition.datasets?.[expr.args[0].ref];
      if (dataset && typeof dataset === "object" && !Array.isArray(dataset)) {
        const key = expr.args[1].ref;
        lookupConstraints.set(key, [
          ...(lookupConstraints.get(key) || []),
          dataset,
        ]);
      }
    }
    expr.args.forEach(inspectQuery);
  };
  Object.values(definition.computations).forEach(inspectQuery);
  walkNodes(definition.root).forEach((node) => {
    if (node.data) {
      inspectQuery(node.data);
    }
    if (node.items) {
      inspectQuery(node.items);
    }
    Object.values(node.bindings || {}).forEach((expr) => inspectQuery(expr!));
  });
  for (const key of Object.keys(state)) {
    if (!previous || !Object.hasOwn(previous.state, key)) {
      continue;
    }
    const nodes = walkNodes(definition.root).filter((n) => n.bind === key);
    const compatible = nodes.every((node) =>
      oldNodes.some(
        (old) =>
          old.id === node.id && old.type === node.type && old.bind === key,
      ),
    );
    const value = previous.state[key];
    const choices = nodes.find((n) =>
      ["select", "segmented"].includes(n.type),
    )?.options;
    if (
      compatible &&
      typeof value === typeof state[key] &&
      Array.isArray(value) === Array.isArray(state[key]) &&
      (!choices || choices.includes(String(value))) &&
      (lookupConstraints.get(key) || []).every((dataset) =>
        Object.hasOwn(dataset as object, String(value)),
      )
    ) {
      state[key] = structuredClone(value);
    } else {
      reset.push(nodes[0]?.label || key);
    }
  }
  return { state, reset };
};

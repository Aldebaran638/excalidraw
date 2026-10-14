import { LIMITS } from "./types";

import type { ResolvedNode, WidgetNode, WidgetAction } from "./types";

import type { Expression, Value, WidgetDefinition, WidgetState } from "./types";

export const computeWidget = (
  definition: WidgetDefinition,
  state: WidgetState,
) => {
  let budget = LIMITS.operations;
  const consume = (n = 1) => {
    budget -= n;
    if (budget < 0) {
      throw new Error("计算规模超过限制");
    }
  };
  const number = (v: Value): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error("需要数字，字符/字符串无法参与数值计算");
    }
    return v;
  };
  const array = (v: Value): Value[] => {
    if (!Array.isArray(v)) {
      throw new Error("需要数组");
    }
    if (v.length > LIMITS.points) {
      throw new Error("数组过大");
    }
    return v;
  };
  const matrix = (v: Value): number[][] => {
    const rows = array(v);
    if (rows.length > LIMITS.matrix) {
      throw new Error("矩阵最多 20 行");
    }
    const out = rows.map((r, i) =>
      array(r).map((c, j) => {
        try {
          return number(c);
        } catch {
          throw new Error(`矩阵第 ${i + 1} 行、第 ${j + 1} 列不是数字`);
        }
      }),
    );
    if (
      !out.length ||
      !out[0].length ||
      out[0].length > LIMITS.matrix ||
      out.some((r) => r.length !== out[0].length)
    ) {
      throw new Error("矩阵必须是最多 20×20 的矩形");
    }
    return out;
  };
  const property = (v: Value, key: Value): Value => {
    const name = String(key);
    if (
      ["__proto__", "constructor", "prototype"].includes(name) ||
      !v ||
      typeof v !== "object" ||
      !Object.hasOwn(v, name)
    ) {
      throw new Error(`数据查询不存在: ${name}`);
    }
    return (v as Record<string, Value>)[name];
  };
  const cache: WidgetState = Object.assign(
    Object.create(null),
    definition.datasets,
    definition.initialState,
    state,
  );
  const visiting = new Set<string>();
  const resolve = (name: string): Value => {
    if (Object.hasOwn(cache, name)) {
      return cache[name];
    }
    if (!Object.hasOwn(definition.computations, name) || visiting.has(name)) {
      throw new Error(`无效计算引用: ${name}`);
    }
    visiting.add(name);
    const value = evaluate(definition.computations[name]);
    visiting.delete(name);
    cache[name] = value;
    return value;
  };
  const evaluate = (expr: Expression, locals: WidgetState = {}): Value => {
    consume();
    if ("literal" in expr) {
      return expr.literal;
    }
    if ("ref" in expr) {
      const [key, ...path] = expr.ref.split(".");
      let v = Object.hasOwn(locals, key)
        ? locals[key]
        : key === "time"
        ? state.time || 0
        : resolve(key);
      for (const part of path) {
        v = property(v, part);
      }
      return v;
    }
    const { op, args } = expr;
    const at = (i: number) => {
      if (!args[i]) {
        throw new Error(`${op} 缺少参数`);
      }
      return evaluate(args[i], locals);
    };
    if (op === "if") {
      return at(0) ? at(1) : at(2);
    }
    if (op === "and") {
      return Boolean(at(0) && at(1));
    }
    if (op === "or") {
      return Boolean(at(0) || at(1));
    }
    if (op === "sample") {
      const start = number(at(0));
      const end = number(at(1));
      const count = number(at(2));
      if (
        !Number.isInteger(count) ||
        count < 2 ||
        count > LIMITS.points ||
        !args[3]
      ) {
        throw new Error("采样数量必须为 2–2000");
      }
      return Array.from({ length: count }, (_, i) => {
        const x = start + ((end - start) * i) / (count - 1);
        return [x, evaluate(args[3], { ...locals, x, index: i })];
      });
    }
    if (op === "map" || op === "filter") {
      const values = array(at(0));
      if (!args[1]) {
        throw new Error("缺少数组表达式");
      }
      return op === "map"
        ? values.map((item, index) =>
            evaluate(args[1], { ...locals, item, x: item, index }),
          )
        : values.filter((item, index) =>
            Boolean(evaluate(args[1], { ...locals, item, x: item, index })),
          );
    }
    const values = args.map((a) => evaluate(a, locals));
    const n = (i: number) => number(values[i]);
    const a = (i: number) => array(values[i]);
    switch (op) {
      case "add":
        return values.reduce<number>((s, v) => s + number(v), 0);
      case "sub":
        return n(0) - n(1);
      case "mul":
        return values.reduce<number>((s, v) => s * number(v), 1);
      case "div":
        if (!n(1)) {
          throw new Error("不能除以零");
        }
        return n(0) / n(1);
      case "pow":
        return n(0) ** n(1);
      case "neg":
        return -n(0);
      case "sqrt":
        return Math.sqrt(n(0));
      case "exp":
        return Math.exp(n(0));
      case "log":
        return Math.log(n(0));
      case "sin":
        return Math.sin(n(0));
      case "cos":
        return Math.cos(n(0));
      case "tan":
        return Math.tan(n(0));
      case "abs":
        return Math.abs(n(0));
      case "round":
        return Math.round(n(0));
      case "min":
        return Math.min(
          ...(Array.isArray(values[0]) ? a(0) : values).map(number),
        );
      case "max":
        return Math.max(
          ...(Array.isArray(values[0]) ? a(0) : values).map(number),
        );
      case "sum":
        return a(0).reduce<number>((s, v) => s + number(v), 0);
      case "mean":
        if (!a(0).length) {
          throw new Error("空数组无法计算均值");
        }
        return a(0).reduce<number>((s, v) => s + number(v), 0) / a(0).length;
      case "eq":
        return JSON.stringify(values[0]) === JSON.stringify(values[1]);
      case "lt":
        return n(0) < n(1);
      case "gt":
        return n(0) > n(1);
      case "not":
        return !values[0];
      case "array":
        return values;
      case "get": {
        const idx = n(1);
        if (!Number.isInteger(idx) || idx < 0 || idx >= a(0).length) {
          throw new Error("数组索引越界");
        }
        return a(0)[idx];
      }
      case "lookup":
        return property(values[0], values[1]);
      case "keys":
        if (!values[0] || typeof values[0] !== "object") {
          throw new Error("需要字典");
        }
        return Object.keys(values[0]);
      case "join":
        return a(0)
          .map(String)
          .join(values[1] === undefined ? "" : String(values[1]));
      case "string":
        return String(values[0]);
      case "length":
        return typeof values[0] === "string" ? values[0].length : a(0).length;
      case "concat": {
        const result = values.flatMap(array);
        if (result.length > LIMITS.points) {
          throw new Error("数组过大");
        }
        return result;
      }
      case "transpose": {
        const m = matrix(values[0]);
        return m[0].map((_, j) => m.map((r) => r[j]));
      }
      case "matmul": {
        const l = matrix(values[0]);
        const r = matrix(values[1]);
        if (l[0].length !== r.length) {
          throw new Error("矩阵维度不匹配");
        }
        consume(l.length * r[0].length * r.length);
        return l.map((row) =>
          r[0].map((_, j) => row.reduce((s, v, k) => s + v * r[k][j], 0)),
        );
      }
      case "dot": {
        const l = a(0);
        const r = a(1);
        if (l.length !== r.length) {
          throw new Error("向量长度不一致");
        }
        return l.reduce<number>((s, v, i) => s + number(v) * number(r[i]), 0);
      }
      case "softmax": {
        const softmax = (vs: Value[]) => {
          const ns = vs.map(number);
          const max = Math.max(...ns);
          const exp = ns.map((v) => Math.exp(v - max));
          const total = exp.reduce((s, v) => s + v, 0);
          if (!total) {
            throw new Error("Softmax 输入为空");
          }
          return exp.map((v) => v / total);
        };
        return a(0).every(Array.isArray)
          ? a(0).map((row) => softmax(array(row)))
          : softmax(a(0));
      }
      case "scale": {
        const scalar = n(1);
        const scale = (v: Value): Value => {
          consume();
          return Array.isArray(v) ? v.map(scale) : number(v) * scalar;
        };
        return scale(values[0]);
      }
      case "transform2d": {
        const m = matrix(values[1]);
        if (m.length !== 2 || m[0].length !== 2) {
          throw new Error("二维变换需要 2×2 矩阵");
        }
        return a(0).map((p) => {
          const point = array(p);
          if (point.length !== 2) {
            throw new Error("坐标需要两个数值");
          }
          return [
            m[0][0] * number(point[0]) + m[0][1] * number(point[1]),
            m[1][0] * number(point[0]) + m[1][1] * number(point[1]),
          ];
        });
      }
      default:
        throw new Error(`不支持的运算: ${op}`);
    }
  };
  const errors: Record<string, string> = Object.create(null);
  for (const name of Object.keys(definition.computations)) {
    try {
      resolve(name);
    } catch (error) {
      visiting.clear();
      errors[name] = (error as Error).message;
    }
  }
  const outputs: Record<string, Value> = Object.create(null);
  // Templates are evaluated only with their repeat scope, never against the
  // global scope. Otherwise valid item.field bindings would report errors.
  let expanded = 0;
  const expand = (
    node: WidgetNode,
    locals: WidgetState = {},
    prefix = "",
  ): ResolvedNode[] => {
    consume();
    if (++expanded > LIMITS.expanded) {
      throw new Error("展开后组件超过 600 个");
    }
    if (node.type === "repeat") {
      const items = array(evaluate(node.items!, locals));
      const seen = new Set<string>();
      return items.flatMap((item, index) => {
        const key = node.itemKey ? property(item, node.itemKey) : item;
        if (typeof key !== "string" && typeof key !== "number") {
          throw new Error("重复组件需要稳定的字符串/数字键");
        }
        const id = String(key);
        if (seen.has(id)) {
          throw new Error(`重复键: ${id}`);
        }
        seen.add(id);
        const scope = { ...locals, item, index };
        return (node.children || []).flatMap((child) =>
          expand(
            child,
            scope,
            `${prefix + node.id}/${encodeURIComponent(id)}/`,
          ),
        );
      });
    }
    const resolved: Record<string, Value> = Object.create(null);
    let error: string | undefined;
    let value: Value | undefined;
    for (const [key, expr] of Object.entries(node.bindings || {})) {
      try {
        const result = evaluate(expr!, locals);
        if (
          ["background", "color", "borderColor"].includes(key) &&
          (typeof result !== "string" || !/^#[0-9a-fA-F]{6}$/.test(result))
        ) {
          throw new Error("动态颜色必须是六位十六进制颜色");
        }
        if (
          ["visible", "disabled", "selected"].includes(key) &&
          typeof result !== "boolean"
        ) {
          throw new Error("状态绑定需要布尔值");
        }
        resolved[key] = result;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    if (resolved.visible === false) {
      return [];
    }
    if (node.data) {
      try {
        value = evaluate(node.data, locals);
        const finite = (v: Value) => {
          if (typeof v === "number" && !Number.isFinite(v)) {
            throw new Error("结果不是有限数字");
          }
          if (v && typeof v === "object") {
            Object.values(v).forEach(finite);
          }
        };
        finite(value);
        outputs[prefix + node.id] = value;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    if (error) {
      errors[prefix + node.id] = error;
    }
    const children = (node.children || []).flatMap((child) =>
      expand(child, locals, prefix),
    );
    return [
      {
        ...node,
        instanceId: prefix + node.id,
        locals,
        value,
        resolved,
        error,
        children,
      },
    ];
  };
  const tree = expand(definition.root)[0] || {
    ...definition.root,
    instanceId: definition.root.id,
    locals: {},
    resolved: {},
    children: [],
  };
  return { outputs, errors, evaluate, tree };
};

export const applyAction = (
  def: WidgetDefinition,
  state: WidgetState,
  action: WidgetAction,
  locals: WidgetState = {},
): WidgetState => {
  let next = structuredClone(state);
  const run = (a: WidgetAction) => {
    if (a.type === "batch") {
      a.actions?.forEach(run);
      return;
    }
    if (a.type === "reset") {
      next = structuredClone(def.initialState);
      return;
    }
    if (!a.target || !Object.hasOwn(def.initialState, a.target)) {
      throw new Error("无效动作目标");
    }
    if (a.type === "set") {
      next[a.target] = computeWidget(def, next).evaluate(a.value!, locals);
    }
    if (a.type === "toggle") {
      next[a.target] = !next[a.target];
    }
    if (a.type === "step") {
      next[a.target] = Number(next[a.target]) + 1;
    }
  };
  run(action);
  return next;
};

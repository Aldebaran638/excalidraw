import type { Expression, WidgetDefinition, WidgetNode } from "./types";

const literal = (value: any): Expression => ({ literal: value });
const ref = (value: string): Expression => ({ ref: value });
const op = (name: string, ...args: Expression[]): Expression => ({
  op: name,
  args,
});
const base = (
  title: string,
  children: WidgetNode[],
  initialState = {},
  computations = {},
  datasets = {},
): WidgetDefinition => ({
  version: 1,
  title,
  initialState,
  computations,
  datasets,
  root: { id: "root", type: "column", children },
});
export const EXAMPLES: Record<string, WidgetDefinition> = {
  calculator: base(
    "通用计算器",
    [
      { id: "heading", type: "title", text: "通用计算器" },
      {
        id: "inputs",
        type: "row",
        children: [
          { id: "a", type: "number", bind: "a", label: "A" },
          { id: "b", type: "number", bind: "b", label: "B" },
        ],
      },
      {
        id: "operation",
        type: "select",
        bind: "operation",
        label: "运算",
        options: ["加法", "乘法"],
      },
      { id: "answer", type: "result", label: "结果", data: ref("answer") },
    ],
    { a: 3, b: 4, operation: "加法" },
    {
      answer: op(
        "if",
        op("eq", ref("operation"), literal("加法")),
        op("add", ref("a"), ref("b")),
        op("mul", ref("a"), ref("b")),
      ),
    },
  ),
  filter: base(
    "数据筛选",
    [
      { id: "heading", type: "title", text: "按阈值筛选数据" },
      {
        id: "threshold",
        type: "slider",
        bind: "threshold",
        label: "最小值",
        min: 0,
        max: 10,
      },
      { id: "values", type: "result", data: ref("filtered") },
      { id: "plot", type: "chart", chartType: "bar", data: ref("filtered") },
    ],
    { threshold: 4 },
    {
      filtered: op(
        "filter",
        ref("values"),
        op("gt", ref("item"), ref("threshold")),
      ),
    },
    { values: [1, 4, 6, 3, 9, 8] },
  ),
  matrix: base(
    "矩阵与二维变换",
    [
      { id: "heading", type: "title", text: "二维线性变换" },
      { id: "m", type: "matrix", bind: "m", label: "变换矩阵" },
      {
        id: "letters",
        type: "matrix",
        data: literal([
          ["a", "b"],
          ["hello", "world"],
        ]),
        label: "字符也能展示",
      },
      {
        id: "plot",
        type: "geometry",
        data: ref("transformed"),
        label: "变换后的坐标",
      },
    ],
    {
      m: [
        [1, 0],
        [0, 1],
      ],
    },
    { transformed: op("transform2d", ref("points"), ref("m")) },
    {
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    },
  ),
  attention: base(
    "Attention 演示",
    [
      { id: "heading", type: "title", text: "Attention: softmax(QKᵀ / √d)" },
      {
        id: "inputs",
        type: "row",
        children: [
          { id: "q", type: "matrix", bind: "q", label: "Q" },
          { id: "k", type: "matrix", bind: "k", label: "K" },
        ],
      },
      {
        id: "temperature",
        type: "slider",
        bind: "temperature",
        label: "温度",
        min: 0.1,
        max: 3,
        step: 0.1,
      },
      {
        id: "scores",
        type: "matrix",
        label: "缩放后的点积",
        data: ref("scores"),
      },
      {
        id: "weights",
        type: "heatmap",
        label: "Softmax 权重",
        data: ref("weights"),
      },
    ],
    {
      q: [
        [1, 0],
        [0, 1],
      ],
      k: [
        [1, 1],
        [1, -1],
      ],
      temperature: 1,
    },
    {
      scores: op(
        "scale",
        op("matmul", ref("q"), op("transpose", ref("k"))),
        op(
          "div",
          literal(1),
          op("mul", op("sqrt", literal(2)), ref("temperature")),
        ),
      ),
      weights: op("softmax", ref("scores")),
    },
  ),
  kubernetes: base(
    "Kubernetes 架构全景",
    [
      { id: "heading", type: "title", text: "Kubernetes 架构全景" },
      { id: "subtitle", type: "caption", text: "点击节点，查看对应解释" },
      {
        id: "control",
        type: "card",
        label: "Control Plane · 控制平面",
        children: [
          {
            id: "grid",
            type: "grid",
            columns: 2,
            children: [
              {
                id: "concepts",
                type: "repeat",
                items: ref("concepts"),
                itemKey: "id",
                children: [
                  {
                    id: "concept",
                    type: "pressable",
                    action: {
                      type: "set",
                      target: "selected",
                      value: ref("item.id"),
                    },
                    bindings: {
                      selected: op("eq", ref("selected"), ref("item.id")),
                      background: op(
                        "if",
                        op("eq", ref("selected"), ref("item.id")),
                        literal("#f3e3db"),
                        literal("#ffffff"),
                      ),
                    },
                    children: [
                      { id: "symbol", type: "icon", icon: "server" },
                      {
                        id: "conceptName",
                        type: "text",
                        bindings: { text: ref("item.name") },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "worker",
        type: "card",
        label: "Worker Nodes",
        children: [
          {
            id: "nodes",
            type: "row",
            children: [
              {
                id: "nodeRepeat",
                type: "repeat",
                items: literal(["A", "B"]),
                children: [
                  {
                    id: "workerNode",
                    type: "card",
                    bindings: { text: ref("item") },
                    label: "Worker Node",
                    children: [
                      {
                        id: "kubelet",
                        type: "text",
                        text: "kubelet → CRI → containerd",
                      },
                      {
                        id: "pod",
                        type: "pressable",
                        text: "Pod → Nginx 容器",
                        action: {
                          type: "set",
                          target: "selected",
                          value: literal("pod"),
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "explain",
        type: "card",
        label: "概念解释",
        children: [
          {
            id: "name",
            type: "title",
            data: op(
              "get",
              op("lookup", ref("facts"), ref("selected")),
              literal(0),
            ),
          },
          {
            id: "detail",
            type: "text",
            data: op(
              "get",
              op("lookup", ref("facts"), ref("selected")),
              literal(1),
            ),
          },
        ],
      },
      {
        id: "reset",
        type: "button",
        label: "重置选择",
        action: { type: "reset" },
      },
    ],
    { selected: "api" },
    {},
    {
      concepts: [
        { id: "api", name: "API Server" },
        { id: "etcd", name: "etcd" },
        { id: "controller", name: "Controller Manager" },
        { id: "scheduler", name: "Scheduler" },
      ],
      facts: {
        api: ["API Server", "集群统一 API 入口，负责认证、授权和资源操作。"],
        etcd: ["etcd", "保存持久化集群状态，使用 Raft 共识机制。"],
        controller: [
          "Controller Manager",
          "观察实际与期望状态的差异，持续协调。",
        ],
        scheduler: ["Scheduler", "为尚未分配节点的 Pod 过滤候选节点并评分。"],
        pod: ["Pod", "最小部署单元，包含一个或多个共享网络的容器。"],
      },
    },
  ),
};

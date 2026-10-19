import type { WidgetDefinition, WidgetNode } from "./types";

/** Generic state, conditional layout and text binding; no device/network effects. */
export const SCENARIO: WidgetDefinition = {
  version: 2,
  title: "场景联动 · 选择与解释",
  initialState: {
    mode: "专注",
    note: "写下这个场景的使用说明",
    details: false,
  },
  datasets: {
    explanations: {
      专注: "减少干扰，集中处理当前任务。",
      协作: "共享当前进展，及时讨论需要共同决策的问题。",
      休息: "暂时放下任务，为下一轮工作恢复精力。",
    },
  },
  computations: {},
  root: {
    id: "scenario",
    type: "column",
    children: [
      { id: "heading", type: "title", text: "把状态变成看得见的变化" },
      {
        id: "mode",
        type: "segmented",
        label: "当前场景",
        bind: "mode",
        options: ["专注", "协作", "休息"],
      },
      {
        id: "explanation",
        type: "text",
        data: {
          op: "lookup",
          args: [{ ref: "explanations" }, { ref: "mode" }],
        },
      },
      { id: "note", type: "textarea", label: "场景说明", bind: "note" },
      { id: "details", type: "toggle", label: "显示说明预览", bind: "details" },
      {
        id: "notePreview",
        type: "card",
        bindings: { visible: { ref: "details" } },
        children: [{ id: "previewText", type: "text", data: { ref: "note" } }],
      },
      {
        id: "reset",
        type: "button",
        label: "重置场景",
        action: { type: "reset" },
      },
    ],
  },
};

const concept = (id: string, label: string, icon: string): WidgetNode => ({
  id,
  type: "pressable",
  label,
  action: { type: "set", target: "selected", value: { literal: id } },
  bindings: {
    selected: { op: "eq", args: [{ ref: "selected" }, { literal: id }] },
  },
  children: [{ id: `${id}Icon`, type: "icon", icon }],
});
export const ARCHITECTURE: WidgetDefinition = {
  version: 2,
  title: "Kubernetes · 从请求到运行",
  initialState: { selected: "api" },
  computations: {},
  datasets: {
    facts: {
      api: "所有请求经过 API Server。它完成认证、授权和资源校验，也是组件之间共享状态的入口。",
      etcd: "etcd 保存集群的期望状态，通过 Raft 保持一致性；它不直接管理容器进程。",
      scheduler: "Scheduler 为未分配的 Pod 选择合适的节点，再把结果写回 API。",
      controller: "Controller 持续比较期望与实际状态，协调缺失的工作负载。",
      kubeletA:
        "节点 A 的 kubelet 根据分配给本节点的 Pod 规格，驱动容器运行时。",
      kubeletB: "节点 B 的 kubelet 独立维护本节点的 Pod，并回报运行状态。",
      podA: "Pod 是最小部署单元。内部容器共享网络和部分存储。",
      podB: "副本可以分布在不同节点，提高可用性。点击连线两端，观察它们的职责。",
      service:
        "Service 为一组 Pod 提供稳定的访问入口；流量按选择器路由到就绪端点，不负责调度或创建 Pod。",
    },
  },
  root: {
    id: "architecture",
    type: "column",
    style: { gap: 16, padding: 16 },
    children: [
      { id: "heading", type: "title", text: "Kubernetes 架构" },
      {
        id: "intro",
        type: "caption",
        text: "从一个请求开始 · 点击节点，沿着关系理解系统",
      },
      {
        id: "topology",
        type: "diagram",
        direction: "LR",
        children: [
          {
            id: "plane",
            type: "group",
            label: "CONTROL PLANE · 控制平面",
            children: [
              concept("api", "API Server", "network"),
              concept("etcd", "etcd · 集群状态", "database"),
              concept("scheduler", "Scheduler · 调度", "workflow"),
              concept("controller", "Controller · 协调", "refresh-cw"),
            ],
          },
          {
            id: "nodeA",
            type: "group",
            label: "WORKER A",
            children: [
              concept("kubeletA", "kubelet", "server"),
              concept("podA", "Pod · nginx", "package"),
            ],
          },
          {
            id: "nodeB",
            type: "group",
            label: "WORKER B",
            children: [
              concept("kubeletB", "kubelet", "server"),
              concept("podB", "Pod · nginx", "package"),
            ],
          },
          concept("service", "Service · 稳定入口", "network"),
        ],
        relations: [
          { id: "storage", from: "api", to: "etcd", label: "读写状态" },
          { id: "schedule", from: "scheduler", to: "api", label: "分配节点" },
          { id: "reconcile", from: "controller", to: "api", label: "协调资源" },
          { id: "assignA", from: "api", to: "kubeletA", label: "Pod 规格" },
          { id: "assignB", from: "api", to: "kubeletB", label: "Pod 规格" },
          { id: "runA", from: "kubeletA", to: "podA", label: "运行" },
          { id: "runB", from: "kubeletB", to: "podB", label: "运行" },
          { id: "trafficA", from: "service", to: "podA", label: "流量" },
          { id: "trafficB", from: "service", to: "podB", label: "流量" },
        ],
      },
      {
        id: "explanation",
        type: "card",
        label: "理解这个节点",
        children: [
          {
            id: "detail",
            type: "text",
            data: {
              op: "lookup",
              args: [{ ref: "facts" }, { ref: "selected" }],
            },
          },
        ],
      },
    ],
  },
};
export const WORKFLOW: WidgetDefinition = {
  version: 2,
  title: "请求处理 · 成功与重试",
  initialState: { selected: "request" },
  computations: {},
  datasets: {
    facts: {
      request: "用户提交请求，进入处理流程。",
      queue: "队列缓冲突发请求，使处理速度与资源匹配。",
      process: "处理器执行任务；失败的任务可以进入重试流程。",
      result: "成功结果返回用户；重复请求需要考虑幂等性。",
    },
  },
  root: {
    id: "flow",
    type: "column",
    children: [
      { id: "heading", type: "title", text: "异步请求如何完成？" },
      {
        id: "diagram",
        type: "diagram",
        children: [
          concept("request", "提交请求", "network"),
          concept("queue", "进入队列", "layers"),
          concept("process", "执行任务", "server"),
          concept("result", "返回结果", "check"),
        ],
        relations: [
          { id: "submit", from: "request", to: "queue" },
          { id: "consume", from: "queue", to: "process" },
          { id: "success", from: "process", to: "result", label: "成功" },
          { id: "retry", from: "process", to: "queue", label: "失败重试" },
        ],
      },
      {
        id: "detail",
        type: "text",
        data: { op: "lookup", args: [{ ref: "facts" }, { ref: "selected" }] },
      },
    ],
  },
};

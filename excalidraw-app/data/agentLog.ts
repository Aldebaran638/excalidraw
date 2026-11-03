export type AgentLogKind =
  | "turn_start"
  | "model_request"
  | "model_headers"
  | "model_stream"
  | "model_response"
  | "transport_error"
  | "tool_call"
  | "tool_result"
  | "system_event"
  | "preview_feedback"
  | "turn_end";

export type AgentLogEntry = {
  version: 1;
  sequence: number;
  at: number;
  noteId: string;
  sessionId: string;
  turnId: string;
  kind: AgentLogKind;
  requestId?: string;
  data: unknown;
};

export type AgentLogTurn = {
  turnId: string;
  createdAt: number;
  updatedAt: number;
  bytes: number;
  running: boolean;
};

export type AgentLogPage = {
  entries: AgentLogEntry[];
  next: number;
  hasMore: boolean;
  incomplete: boolean;
  recordingError?: string;
};

export const agentLogLabels: Record<AgentLogKind, string> = {
  turn_start: "开始本轮",
  model_request: "系统 → Qwen · 实际请求",
  model_headers: "Qwen → 系统 · HTTP 状态",
  model_stream: "Qwen → 系统 · 原始 SSE 分片",
  model_response: "Qwen → 系统 · 完整输出／部分输出",
  transport_error: "连接失败",
  tool_call: "系统 → 工具 · 实际调用",
  tool_result: "工具 → 系统 · 执行结果",
  system_event: "系统 → 界面 · 状态反馈",
  preview_feedback: "浏览器 → 系统 · 预览检查",
  turn_end: "结束本轮",
};

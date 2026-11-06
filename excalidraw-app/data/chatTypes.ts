import type { ChatWidgetRef } from "./chatWidgets";
import type { ChatBlock } from "./chatHtml";
import type { ChatWorkspace } from "./chatWidgets";
import type { HtmlRef, HtmlArtifact } from "./chatHtml";
import type { WidgetGenerationProgress } from "../../packages/interactive-widgets/streamPreview";

export type ChatStatus =
  | "generating"
  | "complete"
  | "stopped"
  | "failed"
  | "interrupted";
export type ChatActivity = {
  id: string;
  name: string;
  status: "reading" | "complete" | "failed";
  errorCode?: string;
  elementIds: string[];
  snapshotAt: number;
  summary?: string;
  details?: string;
};
export type AppTaskTarget =
  | { kind: "element"; elementId: string; appId: string }
  | { kind: "html"; artifactId: string };
export type ChatAgentTask = {
  kind: "chat" | "create" | "edit";
  target?: AppTaskTarget;
};
export type ChatMessage = {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  thinking?: boolean;
  reasoning?: string;
  runtimeStatus?: string;
  artifacts?: ChatWidgetRef[];
  createdAt: number;
  status: ChatStatus;
  activities?: ChatActivity[];
  blocks?: ChatBlock[];
  error?: string;
  /** Communication evidence can fail independently of the answer save. */
  communicationLogError?: string;
  /** Server-derived routing context, never accepted from model prose. */
  agentTask?: ChatAgentTask;
};
export type AppWorkspace = {
  generation: string;
  selection?: ChatWorkspace;
  base?: HtmlRef;
  baseHash?: string;
  target?: HtmlArtifact["target"];
  head?: HtmlRef;
  candidateNumber: number;
};
export type ChatSession = {
  version: 1;
  noteId: string;
  id: string;
  title: string;
  manualTitle: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
  messages: ChatMessage[];
  appWorkspace?: AppWorkspace;
  previousVersions?: {
    id: string;
    createdAt: number;
    messages: ChatMessage[];
  }[];
};
export type ChatSummary = Omit<ChatSession, "messages" | "previousVersions"> & {
  generating: boolean;
};
export type NoteSnapshot = {
  capturedAt: number;
  elements: Record<string, unknown>[];
};
export type ChatEvent = {
  type:
    | "start"
    | "workspace"
    | "block"
    | "delta"
    | "reasoning"
    | "runtime_status"
    | "widget_start"
    | "widget_progress"
    | "widget_ready"
    | "widget_error"
    | "tool_start"
    | "tool_end"
    | "done"
    | "error";
  block?: ChatBlock;
  blockDelta?: string;
  sequence?: number;
  noteId: string;
  sessionId: string;
  turnId: string;
  message?: ChatMessage;
  delta?: string;
  runtimeStatus?: string;
  activity?: ChatActivity;
  session?: ChatSession;
  error?: string;
  saved?: boolean;
  artifact?: ChatWidgetRef;
  progress?: WidgetGenerationProgress;
  workspace?: AppWorkspace;
  revision?: number;
  toolCallId?: string;
};

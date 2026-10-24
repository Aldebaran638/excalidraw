import type { ChatWidgetRef } from "./chatWidgets";
import type { ChatBlock } from "./chatHtml";
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
export type ChatMessage = {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  thinking?: boolean;
  reasoning?: string;
  artifacts?: ChatWidgetRef[];
  createdAt: number;
  status: ChatStatus;
  activities?: ChatActivity[];
  blocks?: ChatBlock[];
  error?: string;
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
    | "block"
    | "delta"
    | "reasoning"
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
  activity?: ChatActivity;
  session?: ChatSession;
  error?: string;
  saved?: boolean;
  artifact?: ChatWidgetRef;
  progress?: WidgetGenerationProgress;
  toolCallId?: string;
};

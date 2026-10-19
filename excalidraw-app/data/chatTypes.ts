export type ChatStatus =
  | "generating"
  | "complete"
  | "stopped"
  | "failed"
  | "interrupted";
export type ChatActivity = {
  id: string;
  name: string;
  status: "reading" | "complete";
  elementIds: string[];
  snapshotAt: number;
  summary?: string;
};
export type ChatMessage = {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status: ChatStatus;
  activities?: ChatActivity[];
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
};
export type ChatSummary = Omit<ChatSession, "messages"> & {
  generating: boolean;
};
export type NoteSnapshot = {
  capturedAt: number;
  elements: Record<string, unknown>[];
};
export type ChatEvent = {
  type: "start" | "delta" | "tool_start" | "tool_end" | "done" | "error";
  noteId: string;
  sessionId: string;
  turnId: string;
  message?: ChatMessage;
  delta?: string;
  activity?: ChatActivity;
  session?: ChatSession;
  error?: string;
  saved?: boolean;
};

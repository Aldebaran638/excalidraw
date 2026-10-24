import { ChatError } from "./chatStore";

export type SourceErrorCode =
  | "invalid_request"
  | "budget"
  | "replacement"
  | "version_conflict"
  | "html_incomplete"
  | "syntax"
  | "protocol"
  | "storage";
export class SourceToolError extends ChatError {
  constructor(status: number, message: string, readonly code: SourceErrorCode) {
    super(status, message);
  }
}

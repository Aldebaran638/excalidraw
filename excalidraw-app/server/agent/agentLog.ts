import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import { validId } from "../../data/noteIdentity";
import { agentLogLabels } from "../../data/agentLog";

import { ChatError } from "../chatStore";

import type {
  AgentLogEntry,
  AgentLogKind,
  AgentLogPage,
} from "../../data/agentLog";

/** Separate append-only communication evidence, never included in model history. */
export class AgentLogStore {
  constructor(private directory: string) {}
  folder(noteId: string, sessionId: string) {
    if (!validId(noteId) || !validId(sessionId)) {
      throw new ChatError(400, "无效通信日志身份");
    }
    return path.join(this.directory, ".chats", noteId, "agent-logs", sessionId);
  }
  file(noteId: string, sessionId: string, turnId: string) {
    if (!validId(turnId)) {
      throw new ChatError(400, "无效通信轮次");
    }
    return path.join(this.folder(noteId, sessionId), `${turnId}.jsonl`);
  }
  async list(noteId: string, sessionId: string) {
    const folder = this.folder(noteId, sessionId);
    const names = await fs.readdir(folder).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    const turns = await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl") && validId(name.slice(0, -6)))
        .map(async (name) => {
          const stat = await fs.stat(path.join(folder, name));
          return {
            turnId: name.slice(0, -6),
            createdAt: stat.birthtimeMs || stat.mtimeMs,
            updatedAt: stat.mtimeMs,
            bytes: stat.size,
          };
        }),
    );
    return turns.sort((a, b) => b.createdAt - a.createdAt);
  }
  async page(
    noteId: string,
    sessionId: string,
    turnId: string,
    after: number,
    limit: number,
  ): Promise<AgentLogPage> {
    const file = this.file(noteId, sessionId, turnId);
    await fs.access(file).catch((error) => {
      if (error.code === "ENOENT") {
        throw new ChatError(404, "该轮没有通信日志；旧对话不会补造历史通信");
      }
      throw error;
    });
    const input = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const entries: AgentLogEntry[] = [];
    let hasMore = false;
    let incomplete = false;
    let bytes = 0;
    try {
      for await (const line of lines) {
        let entry: AgentLogEntry;
        try {
          entry = JSON.parse(line);
          if (
            entry.version !== 1 ||
            entry.noteId !== noteId ||
            entry.sessionId !== sessionId ||
            entry.turnId !== turnId ||
            !Number.isSafeInteger(entry.sequence) ||
            entry.sequence < 1 ||
            !Number.isFinite(entry.at) ||
            !Object.hasOwn(agentLogLabels, entry.kind)
          ) {
            throw new Error("身份或序号不匹配");
          }
        } catch {
          // A process crash or an in-progress append can leave a partial tail.
          incomplete = true;
          continue;
        }
        if (entry.sequence <= after) {
          continue;
        }
        if (
          entries.length >= limit ||
          (entries.length > 0 && bytes + line.length > 512000)
        ) {
          hasMore = true;
          break;
        }
        entries.push(entry);
        bytes += line.length;
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return {
      entries,
      next: entries.at(-1)?.sequence || after,
      hasMore,
      incomplete,
    };
  }
  start(noteId: string, sessionId: string, turnId: string) {
    return new AgentTurnLog(this.file(noteId, sessionId, turnId), {
      noteId,
      sessionId,
      turnId,
    });
  }
}

export class AgentTurnLog {
  private sequence = 0;
  private pending = Promise.resolve();
  private initialized = false;
  error?: string;
  private response?: {
    requestId: string;
    content: string;
    reasoning_content: string;
    tool_calls: Map<number, { id: string; name: string; arguments: string }>;
    finish_reason?: unknown;
    usage?: unknown;
    frames: string[];
    bytes: number;
  };
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private file: string,
    private identity: Pick<AgentLogEntry, "noteId" | "sessionId" | "turnId">,
  ) {}

  record(kind: AgentLogKind, data: unknown, requestId?: string) {
    if (this.error) {
      return;
    }
    // A host event caused by a model chunk must follow that chunk in evidence,
    // even if the 500ms stream-write batch has not fired yet.
    if (kind !== "model_stream" && this.response?.frames.length) {
      this.flushFrames();
    }
    // Serialize now, before mutable activities/messages are changed by the agent.
    const line = `${JSON.stringify({
      version: 1,
      ...this.identity,
      sequence: ++this.sequence,
      at: Date.now(),
      kind,
      requestId,
      data: redactImages(data),
    })}\n`;
    this.pending = this.pending
      .then(async () => {
        if (this.error) {
          return;
        }
        if (!this.initialized) {
          await fs.mkdir(path.dirname(this.file), { recursive: true });
          // Never overwrite/reuse an existing turn's evidence.
          await fs.writeFile(this.file, "", { flag: "wx", mode: 0o600 });
          this.initialized = true;
        }
        await fs.appendFile(this.file, line, "utf8");
      })
      .catch((error: Error) => {
        this.error = `通信日志未完整保存：${error.message}`;
      });
  }

  transport(transport: typeof fetch): typeof fetch {
    return async (url, init) => {
      this.endModel("连接重试前保留输出");
      const requestId = randomUUID();
      // Deliberately omit URL query, headers, credentials and environment.
      this.record(
        "model_request",
        JSON.parse(String(init?.body || "{}")),
        requestId,
      );
      this.response = {
        requestId,
        content: "",
        reasoning_content: "",
        tool_calls: new Map(),
        frames: [],
        bytes: 0,
      };
      try {
        const response = await transport(url, init);
        this.record(
          "model_headers",
          {
            status: response.status,
            contentType: response.headers.get("content-type"),
          },
          requestId,
        );
        if (!response.ok) {
          // Record the error body consumed by the normal agent, without a tee
          // that could buffer an unbounded stream or change cancellation.
          const text = await response.text();
          this.record(
            "transport_error",
            { status: response.status, body: text },
            requestId,
          );
          this.endModel(`HTTP ${response.status}`);
          return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        return response;
      } catch (error) {
        this.record(
          "transport_error",
          { error: (error as Error).message },
          requestId,
        );
        this.endModel((error as Error).message);
        throw error;
      }
    };
  }

  frame(raw: string) {
    const response = this.response;
    if (!response) {
      return;
    }
    response.frames.push(raw);
    response.bytes += raw.length;
    try {
      const frame = JSON.parse(raw);
      const choice = frame.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === "string") {
        response.content += delta.content;
      }
      if (typeof delta?.reasoning_content === "string") {
        response.reasoning_content += delta.reasoning_content;
      }
      for (const tool of delta?.tool_calls || []) {
        const call = response.tool_calls.get(tool.index) || {
          id: "",
          name: "",
          arguments: "",
        };
        if (tool.id) {
          call.id = tool.id;
        }
        call.name += tool.function?.name || "";
        call.arguments += tool.function?.arguments || "";
        response.tool_calls.set(tool.index, call);
      }
      if (choice?.finish_reason) {
        response.finish_reason = choice.finish_reason;
      }
      if (frame.usage) {
        response.usage = frame.usage;
      }
    } catch {
      // Preserve malformed frames verbatim; the normal parser reports failure.
    }
    if (response.bytes >= 64000) {
      this.flushFrames();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flushFrames(), 500);
      this.timer.unref();
    }
  }
  private flushFrames() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.response?.frames.length) {
      this.record(
        "model_stream",
        { frames: this.response.frames },
        this.response.requestId,
      );
      this.response.frames = [];
      this.response.bytes = 0;
    }
  }
  endModel(error?: string) {
    if (!this.response) {
      return;
    }
    this.flushFrames();
    const {
      requestId,
      content,
      reasoning_content,
      tool_calls,
      finish_reason,
      usage,
    } = this.response;
    this.record(
      "model_response",
      {
        content,
        reasoning_content,
        tool_calls: [...tool_calls.values()],
        finish_reason,
        usage,
        error,
      },
      requestId,
    );
    this.response = undefined;
  }
  async flush() {
    this.flushFrames();
    await this.pending;
  }
}

/** Communication evidence keeps metadata; image bytes live in the image store. */
export function redactImages(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactImages);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "image" && typeof obj.data === "string") {
      return {
        ...obj,
        data: `[image bytes omitted: ${obj.data.length} base64 chars]`,
      };
    }
    return Object.fromEntries(
      Object.entries(obj).map(([key, item]) => [key, redactImages(item)]),
    );
  }
  if (typeof value === "string" && value.startsWith("data:image/")) {
    return `[image data URL omitted: ${value.length} chars]`;
  }
  return value;
}

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { validId, readMetadata } from "../data/noteIdentity";

import type { ChatSession, ChatSummary } from "../data/chatTypes";

export class ChatError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const identityFiles = async (directory: string, noteId: string) => {
  const result: string[] = [];
  for (const name of await fs.readdir(directory)) {
    if (!name.toLowerCase().endsWith(".excalidraw")) {
      continue;
    }
    try {
      if (
        readMetadata(
          JSON.parse(await fs.readFile(path.join(directory, name), "utf8"))
            .repositoryMetadata,
        )?.noteId === noteId
      ) {
        result.push(name);
      }
    } catch {
      /* Not a readable note. */
    }
  }
  return result;
};
export class ChatStore {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private directory: string) {}
  private folder(noteId: string) {
    if (!validId(noteId)) {
      throw new ChatError(400, "无效笔记 ID");
    }
    return path.join(this.directory, ".chats", noteId);
  }
  private file(noteId: string, id: string) {
    if (!validId(id)) {
      throw new ChatError(400, "无效会话 ID");
    }
    return path.join(this.folder(noteId), `${id}.json`);
  }
  async assertNote(noteId: string) {
    this.folder(noteId);
    const files = await identityFiles(this.directory, noteId);
    if (files.length !== 1) {
      throw new ChatError(
        files.length ? 409 : 404,
        files.length
          ? "检测到复制笔记，请先为副本建立独立聊天身份"
          : "笔记不存在或尚未保存身份",
      );
    }
    return files[0];
  }
  async list(noteId: string): Promise<ChatSummary[]> {
    const folder = this.folder(noteId);
    const names = await fs.readdir(folder).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    const sessions: ChatSession[] = [];
    for (const name of names) {
      if (name === "index.json" || !name.endsWith(".json")) {
        continue;
      }
      const id = name.slice(0, -5);
      if (!validId(id)) {
        continue;
      }
      try {
        sessions.push(await this.read(noteId, id));
      } catch {
        sessions.push({
          version: 1,
          noteId,
          id,
          title: "无法读取的会话（原文件已保留）",
          manualTitle: true,
          createdAt: 0,
          updatedAt: 0,
          revision: 0,
          messages: [],
        });
      }
    }
    return sessions
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ messages, ...rest }) => ({
        ...rest,
        generating: messages.some((message) => message.status === "generating"),
      }));
  }
  async read(noteId: string, id: string): Promise<ChatSession> {
    try {
      const data = JSON.parse(
        await fs.readFile(this.file(noteId, id), "utf8"),
      ) as ChatSession;
      if (
        data.version !== 1 ||
        data.noteId !== noteId ||
        data.id !== id ||
        typeof data.title !== "string" ||
        !Number.isInteger(data.revision) ||
        !Array.isArray(data.messages) ||
        data.messages.some(
          (message) =>
            !message ||
            !validId(message.id) ||
            !validId(message.turnId) ||
            !["user", "assistant"].includes(message.role) ||
            typeof message.content !== "string" ||
            (message.artifacts !== undefined &&
              (!Array.isArray(message.artifacts) ||
                message.artifacts.some(
                  (ref) =>
                    !ref ||
                    !validId(ref.artifactId) ||
                    !Number.isSafeInteger(ref.version) ||
                    ref.version < 1 ||
                    typeof ref.title !== "string",
                ))) ||
            ![
              "generating",
              "complete",
              "stopped",
              "failed",
              "interrupted",
            ].includes(message.status) ||
            (message.activities !== undefined &&
              (!Array.isArray(message.activities) ||
                message.activities.some(
                  (activity) =>
                    !activity ||
                    typeof activity.id !== "string" ||
                    typeof activity.name !== "string" ||
                    !Array.isArray(activity.elementIds) ||
                    activity.elementIds.some((id) => typeof id !== "string") ||
                    !Number.isFinite(activity.snapshotAt),
                ))),
        )
      ) {
        throw new ChatError(422, "会话文件损坏，原始数据已保留");
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ChatError(404, "会话不存在");
      }
      throw error;
    }
  }
  async atomic(file: string, data: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  async update(
    noteId: string,
    id: string,
    change: (session: ChatSession) => void,
  ) {
    const file = this.file(noteId, id);
    const previous = this.queues.get(file) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const session = await this.read(noteId, id);
        change(session);
        session.updatedAt = Date.now();
        session.revision++;
        await this.atomic(file, session);
        await this.atomic(
          path.join(this.folder(noteId), "index.json"),
          await this.list(noteId),
        );
        return session;
      });
    this.queues.set(file, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(file) === next) {
        this.queues.delete(file);
      }
    }
  }
  async create(noteId: string) {
    const now = Date.now();
    const session: ChatSession = {
      version: 1,
      noteId,
      id: randomUUID(),
      title: "新对话",
      manualTitle: false,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      messages: [],
    };
    await this.atomic(this.file(noteId, session.id), session);
    await this.atomic(
      path.join(this.folder(noteId), "index.json"),
      await this.list(noteId),
    );
    return session;
  }
  async remove(noteId: string, id: string) {
    await fs.unlink(this.file(noteId, id));
    await this.atomic(
      path.join(this.folder(noteId), "index.json"),
      await this.list(noteId),
    );
  }
  async recover() {
    const root = path.join(this.directory, ".chats");
    for (const entry of await fs.readdir(root).catch(() => [])) {
      if (!validId(entry)) {
        continue;
      }
      for (const summary of await this.list(entry)) {
        if (summary.generating) {
          await this.update(entry, summary.id, (session) =>
            session.messages.forEach((message) => {
              if (message.status === "generating") {
                message.status = "interrupted";
              }
            }),
          );
        }
      }
    }
  }
}

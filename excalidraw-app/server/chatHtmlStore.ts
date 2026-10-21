import fs from "node:fs/promises";
import path from "node:path";

import { validId } from "../data/noteIdentity";

import { isHtmlState } from "../data/chatHtml";

import { ChatError, ChatStore } from "./chatStore";

import type { HtmlArtifact, HtmlState } from "../data/chatHtml";

export class ChatHtmlStore {
  private queues = new Map<string, Promise<unknown>>();
  private store: ChatStore;
  constructor(private directory: string) {
    this.store = new ChatStore(directory);
  }
  private file(noteId: string, sessionId: string, id: string, version: number) {
    if (
      ![noteId, sessionId, id].every(validId) ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      throw new ChatError(400, "无效 HTML 作品引用");
    }
    return path.join(
      this.directory,
      ".chats",
      noteId,
      "artifacts",
      sessionId,
      id,
      `html-v${version}.json`,
    );
  }
  async read(
    noteId: string,
    sessionId: string,
    id: string,
    version: number,
  ): Promise<HtmlArtifact> {
    try {
      const data = JSON.parse(
        await fs.readFile(this.file(noteId, sessionId, id, version), "utf8"),
      );
      if (
        data.kind !== "html" ||
        data.noteId !== noteId ||
        data.sessionId !== sessionId ||
        data.artifactId !== id ||
        data.version !== version ||
        typeof data.source !== "string" ||
        typeof data.complete !== "boolean" ||
        !isHtmlState(data.state) ||
        !Number.isSafeInteger(data.revision)
      ) {
        throw new ChatError(422, "HTML 作品文件损坏，原始数据已保留");
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ChatError(404, "HTML 作品不存在");
      }
      throw error;
    }
  }
  async serial<T>(file: string, action: () => Promise<T>) {
    const next = (this.queues.get(file) || Promise.resolve())
      .catch(() => {})
      .then(action);
    this.queues.set(file, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(file) === next) {
        this.queues.delete(file);
      }
    }
  }
  async write(data: HtmlArtifact) {
    const file = this.file(
      data.noteId,
      data.sessionId,
      data.artifactId,
      data.version,
    );
    return this.serial(file, async () => {
      const previous = await this.read(
        data.noteId,
        data.sessionId,
        data.artifactId,
        data.version,
      ).catch((error) => {
        if (error instanceof ChatError && error.status === 404) {
          return null;
        }
        throw error;
      });
      if (previous?.complete) {
        throw new ChatError(409, "完整 HTML 版本不可覆盖");
      }
      const next = {
        formatVersion: 1 as const,
        ...data,
        revision: previous?.revision || 0,
        state: previous?.state || data.state,
      };
      await this.store.atomic(file, next);
      return next;
    });
  }
  async saveState(
    noteId: string,
    sessionId: string,
    id: string,
    version: number,
    revision: number,
    state: HtmlState,
  ) {
    const file = this.file(noteId, sessionId, id, version);
    // A JSON round trip removes prototypes; bound size before persisting untrusted iframe data.
    if (!isHtmlState(state)) {
      throw new ChatError(400, "应用状态格式不正确或过大");
    }
    return this.serial(file, async () => {
      const data = await this.read(noteId, sessionId, id, version);
      if (data.revision !== revision) {
        throw new ChatError(409, "应用状态已被其他页面修改，请重新加载后再试");
      }
      const next = { ...data, state, revision: revision + 1 };
      await this.store.atomic(file, next);
      return next;
    });
  }
}

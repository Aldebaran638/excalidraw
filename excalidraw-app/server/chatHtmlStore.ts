import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { validId } from "../data/noteIdentity";

import { isHtmlState } from "../data/chatHtml";

import { ChatError, ChatStore } from "./chatStore";
import { sourceHash, validateAppSource } from "./appSource";

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
  private appFolder(noteId: string, id: string) {
    if (![noteId, id].every(validId)) {
      throw new ChatError(400, "应用身份无效");
    }
    return path.join(this.directory, ".apps", noteId, id);
  }
  private versionFolder(
    noteId: string,
    id: string,
    version: number,
    draft = false,
  ) {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new ChatError(400, "应用版本无效");
    }
    return path.join(
      this.appFolder(noteId, id),
      draft ? "drafts" : "versions",
      String(version),
    );
  }
  async readApp(
    noteId: string,
    id: string,
    version: number,
    allowDrafts = false,
  ): Promise<HtmlArtifact> {
    for (const draft of allowDrafts ? [false, true] : [false]) {
      const folder = this.versionFolder(noteId, id, version, draft);
      try {
        const data = JSON.parse(
          await fs.readFile(path.join(folder, "metadata.json"), "utf8"),
        );
        const source = await fs.readFile(
          path.join(folder, "source.html"),
          "utf8",
        );
        if (
          data.noteId !== noteId ||
          data.artifactId !== id ||
          data.version !== version ||
          !isHtmlState(data.state) ||
          data.sourceHash !== sourceHash(source)
        ) {
          throw new ChatError(422, "应用源码或元数据损坏，原始文件已保留");
        }
        return { ...data, source };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    throw new ChatError(
      404,
      "应用源码文件缺失；请明确恢复源码，不会自动创建新应用",
    );
  }
  async read(
    noteId: string,
    sessionId: string,
    id: string,
    version: number,
  ): Promise<HtmlArtifact> {
    // Validate IDs even when reading the new shared application store.
    this.file(noteId, sessionId, id, version);
    try {
      const current = await this.readApp(noteId, id, version, true);
      if (current.sessionId !== sessionId) {
        throw new ChatError(404, "HTML 作品不存在于当前会话");
      }
      return current;
    } catch (error) {
      if (!(error instanceof ChatError) || error.status !== 404) {
        throw error;
      }
    }
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
  async restore(data: HtmlArtifact) {
    validateAppSource(data.source);
    // Explicit recovery preserves the damaged directory, never silently forks an ID.
    const folder = this.versionFolder(
      data.noteId,
      data.artifactId,
      data.version,
    );
    const previous = await this.readApp(
      data.noteId,
      data.artifactId,
      data.version,
    ).catch((error) => {
      if (error instanceof ChatError && [404, 422].includes(error.status)) {
        return null;
      }
      throw error;
    });
    if (previous) {
      if (sourceHash(previous.source) !== sourceHash(data.source)) {
        throw new ChatError(409, "原版本仍存在，不允许用恢复操作覆盖");
      }
      return previous;
    }
    const recovery = path.join(
      this.appFolder(data.noteId, data.artifactId),
      "recovery",
      `${data.version}-${randomUUID()}`,
    );
    await fs.mkdir(path.dirname(recovery), { recursive: true });
    let moved = false;
    try {
      await fs.rename(folder, recovery);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    try {
      return await this.write(data);
    } catch (error) {
      if (moved) {
        await fs.rename(recovery, folder).catch(() => {});
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
        sourceHash: sourceHash(data.source),
      };
      if (!isHtmlState(next.state)) {
        throw new ChatError(400, "应用状态无效");
      }
      if (data.complete) {
        validateAppSource(data.source);
      }
      const folder = this.versionFolder(
        data.noteId,
        data.artifactId,
        data.version,
        !data.complete,
      );
      const { source, ...metadata } = next;
      if (data.complete) {
        const stage = `${folder}.pending-${randomUUID()}`;
        await fs.mkdir(stage, { recursive: true });
        await fs.writeFile(path.join(stage, "source.html"), source, "utf8");
        await this.store.atomic(path.join(stage, "metadata.json"), metadata);
        try {
          await fs.rename(stage, folder);
        } catch {
          throw new ChatError(409, "源码版本已存在，不会覆盖");
        }
        const versions = (await fs.readdir(path.dirname(folder)))
          .filter((v) => /^\d+$/.test(v))
          .map(Number)
          .sort((a, b) => a - b);
        await this.store.atomic(
          path.join(
            this.appFolder(data.noteId, data.artifactId),
            "manifest.json",
          ),
          {
            formatVersion: 1,
            appId: data.artifactId,
            noteId: data.noteId,
            versions,
          },
        );
      } else {
        await fs.mkdir(folder, { recursive: true });
        const temporary = path.join(folder, `source-${randomUUID()}.tmp`);
        await fs.writeFile(temporary, source, "utf8");
        await fs.rename(temporary, path.join(folder, "source.html"));
        await this.store.atomic(path.join(folder, "metadata.json"), metadata);
      }
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
      const folder = this.versionFolder(noteId, id, version, !data.complete);
      const metadata = path.join(folder, "metadata.json");
      if (
        await fs.access(metadata).then(
          () => true,
          () => false,
        )
      ) {
        const { source: _source, ...values } = {
          ...next,
          sourceHash: sourceHash(next.source),
        };
        await this.store.atomic(metadata, values);
      } else {
        await this.store.atomic(file, next);
      }
      return next;
    });
  }
}

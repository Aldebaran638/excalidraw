import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  readWidget,
  validateDefinition,
} from "../../packages/interactive-widgets/schema";
import { validId } from "../data/noteIdentity";

import { ChatError, ChatStore } from "./chatStore";

import type { ChatWidgetData, ChatWidgetVersion } from "../data/chatWidgets";
import type { WidgetState } from "../../packages/interactive-widgets/types";

type Meta = {
  versions: {
    version: number;
    title: string;
    turnId: string;
    toolCallId: string;
  }[];
};
export class ChatArtifactStore {
  private queues = new Map<string, Promise<unknown>>();
  private store: ChatStore;
  constructor(private directory: string) {
    this.store = new ChatStore(directory);
  }
  private folder(noteId: string, sessionId: string, artifactId: string) {
    if (![noteId, sessionId, artifactId].every(validId)) {
      throw new ChatError(400, "无效组件引用");
    }
    return path.join(
      this.directory,
      ".chats",
      noteId,
      "artifacts",
      sessionId,
      artifactId,
    );
  }
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) || Promise.resolve())
      .catch(() => {})
      .then(action);
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) {
        this.queues.delete(key);
      }
    }
  }
  async read(
    noteId: string,
    sessionId: string,
    artifactId: string,
    version?: number,
  ): Promise<ChatWidgetData> {
    const folder = this.folder(noteId, sessionId, artifactId);
    let meta: Meta;
    try {
      meta = JSON.parse(
        await fs.readFile(path.join(folder, "meta.json"), "utf8"),
      );
    } catch {
      throw new ChatError(404, "聊天作品不存在或无法读取");
    }
    const selected = version ?? meta.versions.at(-1)?.version;
    if (
      !Number.isSafeInteger(selected) ||
      !meta.versions.some((v) => v.version === selected)
    ) {
      throw new ChatError(404, "作品版本不存在");
    }
    try {
      const data: ChatWidgetVersion = JSON.parse(
        await fs.readFile(path.join(folder, `v${selected}.json`), "utf8"),
      );
      if (
        data.noteId !== noteId ||
        data.sessionId !== sessionId ||
        data.artifactId !== artifactId ||
        data.version !== selected ||
        !readWidget(data.document) ||
        !Number.isSafeInteger(data.revision) ||
        data.revision < 0 ||
        typeof data.summary !== "string" ||
        !data.region ||
        !Number.isFinite(data.region.width) ||
        !Number.isFinite(data.region.height) ||
        data.region.width <= 0 ||
        data.region.height <= 0 ||
        data.region.width > 20000 ||
        data.region.height > 20000
      ) {
        throw new Error();
      }
      if (data.target) {
        if (
          typeof data.target.elementId !== "string" ||
          !data.target.elementId.length ||
          data.target.elementId.length > 200
        ) {
          throw new Error();
        }
        validateDefinition(data.target.baseDefinition);
        if (data.target.baseDocument && !readWidget(data.target.baseDocument)) {
          throw new Error();
        }
      }
      return {
        ...data,
        versions: meta.versions.map(({ version, title }) => ({
          version,
          title,
        })),
      };
    } catch {
      throw new ChatError(422, "作品数据损坏，其他聊天内容不受影响");
    }
  }
  async create(
    input: Omit<
      ChatWidgetVersion,
      "artifactId" | "version" | "revision" | "createdAt"
    > & { artifactId?: string },
  ) {
    const artifactId = input.artifactId || randomUUID();
    const folder = this.folder(input.noteId, input.sessionId, artifactId);
    return this.serial(folder, async () => {
      if (!readWidget(input.document)) {
        throw new ChatError(422, "候选组件未通过校验");
      }
      let meta: Meta = { versions: [] };
      try {
        meta = JSON.parse(
          await fs.readFile(path.join(folder, "meta.json"), "utf8"),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw e;
        }
      }
      const duplicate = meta.versions.find(
        (v) => v.turnId === input.turnId && v.toolCallId === input.toolCallId,
      );
      if (duplicate) {
        return this.read(
          input.noteId,
          input.sessionId,
          artifactId,
          duplicate.version,
        );
      }
      const version = (meta.versions.at(-1)?.version || 0) + 1;
      const data: ChatWidgetVersion = {
        ...input,
        artifactId,
        version,
        revision: 0,
        createdAt: Date.now(),
      };
      await this.store.atomic(path.join(folder, `v${version}.json`), data);
      meta.versions.push({
        version,
        title: input.document.definition.title,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
      });
      await this.store.atomic(path.join(folder, "meta.json"), meta);
      return {
        ...data,
        versions: meta.versions.map(({ version: v, title }) => ({
          version: v,
          title,
        })),
      };
    });
  }
  async saveState(
    noteId: string,
    sessionId: string,
    artifactId: string,
    version: number,
    revision: number,
    state: WidgetState,
  ) {
    const folder = this.folder(noteId, sessionId, artifactId);
    return this.serial(folder, async () => {
      const data = await this.read(noteId, sessionId, artifactId, version);
      if (data.revision !== revision) {
        throw new ChatError(
          409,
          "作品试用输入已在其他页面更新，请重新加载后核对",
        );
      }
      const document = readWidget({ ...data.document, state });
      if (!document || JSON.stringify(state).length > 256 * 1024) {
        throw new ChatError(400, "无效或过大的试用输入");
      }
      const { versions, ...next } = {
        ...data,
        document,
        revision: revision + 1,
      };
      await this.store.atomic(path.join(folder, `v${version}.json`), next);
      return { ...next, versions };
    });
  }
}

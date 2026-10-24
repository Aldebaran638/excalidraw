import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { isHtmlState, readCanvasHtmlApp } from "../data/chatHtml";
import { HTML_RUNTIME_VERSION } from "../data/clientProtocol";

import { ChatHtmlStore } from "./chatHtmlStore";
import { ChatStore, ChatError } from "./chatStore";
import { readBody, sendJson } from "./notes";
import { sourceHash, validateAppSource } from "./appSource";

import type { IncomingMessage, ServerResponse } from "node:http";

export const createAppApi = (directory: string) => {
  const store = new ChatHtmlStore(directory);
  const notes = new ChatStore(directory);
  const queues = new Map<string, Promise<unknown>>();
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://localhost");
    const match = url.pathname.match(
      /^\/api\/notes\/([\w-]+)\/apps(?:\/([\w-]+))?(?:\/(restore))?$/,
    );
    if (!match) {
      return false;
    }
    try {
      if (
        req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host
      ) {
        throw new ChatError(403, "应用请求必须同源");
      }
      const [, noteId, id, restore] = match;
      const filename = await notes.assertNote(noteId);
      if (req.method === "GET" && id) {
        sendJson(
          res,
          200,
          await store.readApp(
            noteId,
            id,
            Number(url.searchParams.get("version")),
          ),
        );
      } else if (req.method === "POST") {
        if (id && !restore) {
          throw new ChatError(405, "不能直接覆盖源码版本");
        }
        const body = JSON.parse(await readBody(req, 512 * 1024));
        if (!isHtmlState(body.state)) {
          throw new ChatError(400, "应用状态无效");
        }
        validateAppSource(body.source);
        const key = `${noteId}/${body.target?.elementId || id || randomUUID()}`;
        const operation = (queues.get(key) || Promise.resolve())
          .catch(() => {})
          .then(async () => {
            let appId: string = randomUUID();
            let version = 1;
            if (body.target || restore) {
              const note = JSON.parse(
                await fs.readFile(path.join(directory, filename), "utf8"),
              );
              const element = note.elements.find(
                (e: any) =>
                  !e.isDeleted &&
                  (body.target
                    ? e.id === body.target.elementId
                    : e.customData?.htmlApp?.appId === id),
              );
              const current = readCanvasHtmlApp(element?.customData?.htmlApp);
              if (!current) {
                throw new ChatError(409, "目标组件不存在或已删除");
              }
              if (restore) {
                if (
                  sourceHash(body.source) !== current.sourceHash ||
                  body.source !== current.sourceSnapshot
                ) {
                  throw new ChatError(409, "恢复源码与笔记快照不一致");
                }
                appId = current.appId;
                version = current.version;
              } else {
                if (
                  current.appId !== body.target.appId ||
                  current.version !== body.target.version ||
                  current.sourceHash !== body.target.sourceHash
                ) {
                  throw new ChatError(409, "目标源码已改变，请基于新版修改");
                }
                appId = current.appId;
                version = current.version + 1;
                while (
                  await store.readApp(noteId, appId, version).then(
                    () => true,
                    (e) => {
                      if (e.status === 404) {
                        return false;
                      }
                      throw e;
                    },
                  )
                ) {
                  version++;
                }
              }
            }
            const value = {
              kind: "html" as const,
              artifactId: appId,
              version,
              noteId,
              sessionId: "canvas-app-source",
              source: body.source,
              sourceHash: sourceHash(body.source),
              title: String(body.title || "HTML 应用").slice(0, 100),
              complete: true,
              state: body.state,
              runtimeVersion: HTML_RUNTIME_VERSION,
              revision: 0,
              createdAt: Date.now(),
            };
            return restore ? store.restore(value) : store.write(value);
          });
        queues.set(key, operation);
        try {
          sendJson(res, 201, await operation);
        } finally {
          if (queues.get(key) === operation) {
            queues.delete(key);
          }
        }
      } else {
        throw new ChatError(405, "不支持此应用操作");
      }
    } catch (error) {
      sendJson(res, error instanceof ChatError ? error.status : 500, {
        error: (error as Error).message,
      });
    }
    return true;
  };
};

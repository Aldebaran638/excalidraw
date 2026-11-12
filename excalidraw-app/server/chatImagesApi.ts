import { readBody, sendJson } from "./notes";
import { ChatError } from "./chatStore";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatStore } from "./chatStore";
import type { ChatImageStore } from "./chatImageStore";

export function chatImagesApi(store: ChatStore, images: ChatImageStore) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const match = new URL(req.url || "/", "http://localhost").pathname.match(
      /^\/api\/notes\/([\w-]+)\/chats\/([\w-]+)\/(images|canvas-snapshots)(?:\/([\w-]+))?$/,
    );
    if (!match) {
      return false;
    }
    try {
      if (
        req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host
      ) {
        throw new ChatError(403, "图片请求必须同源");
      }
      const [, noteId, sessionId, kind, id] = match;
      await store.assertNote(noteId);
      await store.read(noteId, sessionId);
      if (kind === "images" && req.method === "POST" && !id) {
        const body = JSON.parse(await readBody(req, 3 * 1024 * 1024));
        if (
          typeof body.data !== "string" ||
          !/^[a-zA-Z0-9+/]*={0,2}$/.test(body.data)
        ) {
          throw new ChatError(400, "无效图片数据");
        }
        sendJson(
          res,
          201,
          await images.save(
            noteId,
            sessionId,
            Buffer.from(body.data, "base64"),
            { source: "upload", name: body.name },
          ),
        );
      } else if (kind === "images" && req.method === "GET" && id) {
        const image = await images.read(noteId, sessionId, id);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": image.data.length,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'",
        });
        res.end(image.data);
      } else if (kind === "canvas-snapshots" && id && req.method === "POST") {
        const body = JSON.parse(await readBody(req, 32 * 1024 * 1024));
        await images.writeSnapshot(noteId, sessionId, id, body);
        sendJson(res, 201, { saved: true, capturedAt: body.capturedAt });
      } else if (kind === "canvas-snapshots" && id && req.method === "GET") {
        sendJson(res, 200, await images.readSnapshot(noteId, sessionId, id));
      } else {
        throw new ChatError(405, "不支持此图片操作");
      }
    } catch (error) {
      sendJson(
        res,
        error instanceof ChatError
          ? error.status
          : error instanceof SyntaxError
          ? 400
          : (error as NodeJS.ErrnoException).code === "EEXIST"
          ? 409
          : 500,
        {
          error: (error as Error).message,
        },
      );
    }
    return true;
  };
}

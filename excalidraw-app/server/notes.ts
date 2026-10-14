import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { watch } from "chokidar";

import type { IncomingMessage, ServerResponse } from "node:http";

export type NoteChange = {
  name: string;
  kind: "updated" | "deleted";
  revision?: string;
  sourceId?: string;
};
export const revisionOf = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const sendJson = (
  res: ServerResponse,
  status: number,
  value: unknown,
) => {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
export const readBody = async (
  req: IncomingMessage,
  limit = 50 * 1024 * 1024,
) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > limit) {
      throw new RangeError("请求过大");
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
};
const pattern = /^[^/\\.][^/\\]*\.excalidraw$/i;
export const createNoteService = async (directory: string) => {
  await fs.mkdir(directory, { recursive: true });
  const clients = new Set<ServerResponse>();
  const recent = new Map<string, { revision: string; expires: number }>();
  const known = new Map<string, string>();
  const queues = new Map<string, Promise<unknown>>();
  const target = (name: string) =>
    pattern.test(name) && !name.includes("..")
      ? path.join(directory, name)
      : null;
  const publish = (change: NoteChange) => {
    for (const client of clients) {
      if (!client.destroyed && !client.writableEnded) {
        client.write(`data: ${JSON.stringify(change)}\n\n`);
      }
    }
  };
  const watcher = watch(directory, {
    ignoreInitial: true,
    usePolling: true,
    interval: 150,
    atomic: true,
    awaitWriteFinish: { pollInterval: 50, stabilityThreshold: 200 },
    depth: 0,
    ignored: (p) => p !== directory && !pattern.test(path.basename(p)),
  });
  const updated = async (file: string) => {
    const name = path.basename(file);
    if (!target(name)) {
      return;
    }
    try {
      const revision = revisionOf(await fs.readFile(file, "utf8"));
      const write = recent.get(file);
      if (write && write.expires > Date.now() && write.revision === revision) {
        return;
      }
      recent.delete(file);
      if (known.get(name) === revision) {
        return;
      }
      known.set(name, revision);
      publish({ name, kind: "updated", revision });
    } catch {
      /* A subsequent unlink event handles deletion. */
    }
  };
  watcher.on("add", (file) => void updated(file));
  watcher.on("change", (file) => void updated(file));
  watcher.on("unlink", (file) => {
    const name = path.basename(file);
    if (!target(name)) {
      return;
    }
    // Atomic replacement should be a change, never a deletion.
    setTimeout(() => {
      void fs.access(file).catch(() => {
        recent.delete(file);
        known.delete(name);
        publish({ name, kind: "deleted" });
      });
    }, 100);
  });
  await new Promise<void>((resolve, reject) => {
    watcher.once("ready", resolve);
    watcher.once("error", reject);
  });
  const expiry = setInterval(() => {
    for (const [p, w] of recent) {
      if (w.expires < Date.now()) {
        recent.delete(p);
      }
    }
  }, 5000);
  expiry.unref();
  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const url = new URL(req.url || "/", "http://localhost");
    if (
      url.pathname !== "/api/notes" &&
      !url.pathname.startsWith("/api/notes/")
    ) {
      return false;
    }
    try {
      if (url.pathname === "/api/notes/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("event: ready\ndata: {}\n\n");
        clients.add(res);
        const heartbeat = setInterval(
          () => res.write(": heartbeat\n\n"),
          15000,
        );
        heartbeat.unref();
        res.on("close", () => {
          clearInterval(heartbeat);
          clients.delete(res);
        });
        return true;
      }
      if (url.pathname === "/api/notes" && req.method === "GET") {
        const files = await fs.readdir(directory, { withFileTypes: true });
        sendJson(res, 200, {
          notes: files
            .filter((f) => f.isFile() && pattern.test(f.name))
            .map((f) => f.name)
            .sort(),
        });
        return true;
      }
      const name = decodeURIComponent(url.pathname.slice("/api/notes/".length));
      const file = target(name);
      if (!file) {
        sendJson(res, 400, { error: "Invalid note name" });
        return true;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const text = await fs.readFile(file, "utf8");
        res.setHeader("ETag", `"${revisionOf(text)}"`);
        res.setHeader("Cache-Control", "no-store");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(req.method === "HEAD" ? undefined : text);
        return true;
      }
      if (req.method === "PUT") {
        const content = await readBody(req);
        const parsed = JSON.parse(content);
        if (
          !parsed ||
          parsed.type !== "excalidraw" ||
          !Array.isArray(parsed.elements)
        ) {
          sendJson(res, 400, { error: "Invalid Excalidraw document" });
          return true;
        }
        const run = async () => {
          let existing: string | null = null;
          try {
            existing = await fs.readFile(file, "utf8");
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
              throw e;
            }
          }
          if (req.headers["if-none-match"] === "*" && existing !== null) {
            sendJson(res, 412, { error: "Repository note already exists" });
            return;
          }
          const expected = req.headers["if-match"]?.replaceAll('"', "");
          if (
            expected &&
            (existing === null || revisionOf(existing) !== expected)
          ) {
            sendJson(res, 409, { error: "Repository note changed locally" });
            return;
          }
          const revision = revisionOf(content);
          const client = req.headers["x-repository-client-id"];
          const sourceId =
            typeof client === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(client)
              ? client
              : undefined;
          const tmp = path.join(directory, `.${name}.${randomUUID()}.tmp`);
          recent.set(file, { revision, expires: Date.now() + 5000 });
          try {
            await fs.writeFile(tmp, content, "utf8");
            await fs.rename(tmp, file);
          } catch (e) {
            recent.delete(file);
            await fs.rm(tmp, { force: true });
            throw e;
          }
          known.set(name, revision);
          publish({ name, kind: "updated", revision, sourceId });
          sendJson(res, 200, { name, revision });
        };
        const previous = queues.get(file) || Promise.resolve();
        const next = previous.catch(() => undefined).then(run);
        queues.set(file, next);
        try {
          await next;
        } finally {
          if (queues.get(file) === next) {
            queues.delete(file);
          }
        }
        return true;
      }
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      sendJson(
        res,
        code === "ENOENT"
          ? 404
          : e instanceof SyntaxError
          ? 400
          : e instanceof RangeError
          ? 413
          : 500,
        {
          error:
            code === "ENOENT" ? "Note not found" : "Unable to access notes",
        },
      );
    }
    return true;
  };
  return {
    handle,
    close: async () => {
      clearInterval(expiry);
      for (const client of clients) {
        client.end();
      }
      await watcher.close();
    },
  };
};

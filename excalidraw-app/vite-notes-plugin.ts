import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { watch, type FSWatcher } from "chokidar";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";

const NOTES_DIRECTORY = path.resolve(__dirname, "../notes");
const NOTE_NAME_PATTERN = /^[^/\\.][^/\\]*\.excalidraw$/i;
const NOTE_HMR_EVENT = "repository-notes:changed";
const MAX_NOTE_SIZE_BYTES = 50 * 1024 * 1024;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RECENT_API_WRITE_TTL_MS = 5000;

const getNotePath = (name: string) => {
  if (!NOTE_NAME_PATTERN.test(name) || name.includes("..")) {
    return null;
  }
  const notePath = path.resolve(NOTES_DIRECTORY, name);
  return notePath.startsWith(`${NOTES_DIRECTORY}${path.sep}`) ? notePath : null;
};

const getNoteName = (notePath: string) => {
  const relativePath = path.relative(NOTES_DIRECTORY, notePath);
  return getNotePath(relativePath) ? relativePath : null;
};

const getRevision = (content: string) =>
  createHash("sha256").update(content).digest("hex");

const getClientId = (req: IncomingMessage) => {
  const value = req.headers["x-repository-client-id"];
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value)
    ? value
    : undefined;
};

const sendJson = (res: ServerResponse, status: number, data: unknown) => {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
};

const readRequestBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_NOTE_SIZE_BYTES) {
      throw new RangeError("Repository note is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const writeNoteAtomically = async (notePath: string, content: string) => {
  const temporaryPath = path.join(
    NOTES_DIRECTORY,
    `.${path.basename(notePath)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, content, "utf8");
    await fs.rename(temporaryPath, notePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const publishChange = async (
  server: ViteDevServer,
  notePath: string,
  kind: "updated" | "deleted",
  sourceId?: string,
  knownRevision?: string,
) => {
  const name = getNoteName(notePath);
  if (!name) {
    return;
  }
  let revision = knownRevision;
  if (kind === "updated" && !revision) {
    try {
      revision = getRevision(await fs.readFile(notePath, "utf8"));
    } catch {
      return;
    }
  }
  server.ws.send({
    type: "custom",
    event: NOTE_HMR_EVENT,
    data: {
      name,
      kind,
      ...(revision ? { revision } : {}),
      ...(sourceId ? { sourceId } : {}),
    },
  });
};

type RecentApiWrite = {
  revision: string;
  sourceId: string;
  state: "pending" | "done";
  expiresAt: number;
};

export const repositoryNotesPlugin = (): Plugin => ({
  name: "repository-notes",
  async configureServer(server) {
    await fs.mkdir(NOTES_DIRECTORY, { recursive: true });

    const recentApiWrites = new Map<string, RecentApiWrite>();

    const publishWatcherChange = async (filePath: string) => {
      const name = getNoteName(filePath);
      if (!name) {
        return;
      }
      let revision: string;
      try {
        revision = getRevision(await fs.readFile(filePath, "utf8"));
      } catch {
        return;
      }

      const recentWrite = recentApiWrites.get(filePath);
      if (recentWrite) {
        if (recentWrite.expiresAt <= Date.now()) {
          recentApiWrites.delete(filePath);
        } else if (revision === recentWrite.revision) {
          // The API already broadcast this write. Do not broadcast the same
          // operation again when chokidar reports the atomic rename. Keep the
          // entry until its short TTL expires because an atomic rename can
          // produce both an `add` and a `change` event.
          return;
        } else if (recentWrite.state === "pending") {
          // Chokidar can report the rename before the API continuation marks
          // the write complete. Re-check once the filesystem settles.
          setTimeout(() => void publishWatcherChange(filePath), 25);
          return;
        } else {
          recentApiWrites.delete(filePath);
        }
      }
      await publishChange(server, filePath, "updated", undefined, revision);
    };

    const onChange = (filePath: string) => {
      void publishWatcherChange(filePath);
    };
    const onUnlink = (filePath: string) => {
      const recentWrite = recentApiWrites.get(filePath);
      if (recentWrite && recentWrite.expiresAt > Date.now()) {
        // An API save uses a temporary file followed by rename(), which
        // briefly looks like an unlink. Wait for the replacement file before
        // deciding that a note was actually deleted.
        setTimeout(() => {
          const currentWrite = recentApiWrites.get(filePath);
          if (currentWrite !== recentWrite) {
            return;
          }
          void fs.access(filePath).catch(() => {
            recentApiWrites.delete(filePath);
            void publishChange(server, filePath, "deleted");
          });
        }, 50);
        return;
      }
      recentApiWrites.delete(filePath);
      void publishChange(server, filePath, "deleted");
    };
    // The repository is a sibling of the Vite root. A native filesystem
    // watcher does not reliably observe it on mounted filesystems (for
    // example WSL/Windows volumes), so use polling for this small directory.
    const notesWatcher: FSWatcher = watch(NOTES_DIRECTORY, {
      atomic: true,
      awaitWriteFinish: {
        pollInterval: 50,
        stabilityThreshold: 200,
      },
      ignored: (filePath) => {
        const basename = path.basename(filePath);
        return (
          basename !== path.basename(NOTES_DIRECTORY) &&
          !NOTE_NAME_PATTERN.test(basename) &&
          !basename.startsWith(".")
        );
      },
      ignoreInitial: true,
      interval: 150,
      usePolling: true,
    });
    notesWatcher.on("change", onChange);
    notesWatcher.on("add", onChange);
    notesWatcher.on("unlink", onUnlink);
    server.httpServer?.once("close", () => {
      void notesWatcher.close();
    });

    server.middlewares.use(async (req, res, next) => {
      const requestUrl = new URL(req.url || "/", "http://localhost");
      if (
        requestUrl.pathname !== "/api/notes" &&
        !requestUrl.pathname.startsWith("/api/notes/")
      ) {
        next();
        return;
      }
      try {
        if (requestUrl.pathname === "/api/notes" && req.method === "GET") {
          const entries = await fs.readdir(NOTES_DIRECTORY, {
            withFileTypes: true,
          });
          const notes = entries
            .filter(
              (entry) => entry.isFile() && NOTE_NAME_PATTERN.test(entry.name),
            )
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
          sendJson(res, 200, { notes });
          return;
        }

        const name = decodeURIComponent(
          requestUrl.pathname.slice("/api/notes/".length),
        );
        const notePath = getNotePath(name);
        if (!notePath) {
          sendJson(res, 400, { error: "Invalid note name" });
          return;
        }

        if (req.method === "HEAD" || req.method === "GET") {
          const content = await fs.readFile(notePath, "utf8");
          const revision = getRevision(content);
          res.setHeader("ETag", `"${revision}"`);
          if (req.method === "HEAD") {
            res.statusCode = 204;
            res.end();
            return;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(content);
          return;
        }

        if (req.method === "PUT") {
          let existingContent: string | null = null;
          try {
            existingContent = await fs.readFile(notePath, "utf8");
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
          if (
            req.headers["if-none-match"] === "*" &&
            existingContent !== null
          ) {
            sendJson(res, 412, { error: "Repository note already exists" });
            return;
          }
          const expectedRevision = req.headers["if-match"]?.replaceAll('"', "");
          if (
            expectedRevision &&
            (existingContent === null ||
              expectedRevision !== getRevision(existingContent))
          ) {
            sendJson(res, 409, { error: "Repository note changed locally" });
            return;
          }

          const content = await readRequestBody(req);
          const parsed = JSON.parse(content) as { type?: unknown };
          if (!parsed || parsed.type !== "excalidraw") {
            sendJson(res, 400, { error: "Invalid Excalidraw document" });
            return;
          }
          const revision = getRevision(content);
          const sourceId = getClientId(req);
          if (sourceId) {
            recentApiWrites.set(notePath, {
              revision,
              sourceId,
              state: "pending",
              expiresAt: Date.now() + RECENT_API_WRITE_TTL_MS,
            });
          }
          try {
            await writeNoteAtomically(notePath, content);
            if (sourceId) {
              const recentWrite = recentApiWrites.get(notePath);
              if (recentWrite?.revision === revision) {
                recentWrite.state = "done";
              }
            }
            await publishChange(
              server,
              notePath,
              "updated",
              sourceId,
              revision,
            );
          } catch (error) {
            if (sourceId) {
              recentApiWrites.delete(notePath);
            }
            throw error;
          }
          sendJson(res, 200, { name, revision });
          return;
        }

        res.setHeader("Allow", "GET, HEAD, PUT");
        sendJson(res, 405, { error: "Method not allowed" });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          sendJson(res, 404, { error: "Note not found" });
          return;
        }
        if (error instanceof RangeError) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        if (error instanceof SyntaxError) {
          sendJson(res, 400, { error: "Invalid JSON" });
          return;
        }
        sendJson(res, 500, { error: "Unable to access notes" });
      }
    });
  },
  handleHotUpdate(context) {
    return getNoteName(context.file) ? [] : undefined;
  },
});

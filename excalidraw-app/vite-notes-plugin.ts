import fs from "node:fs/promises";
import path from "node:path";

import type { Plugin } from "vite";

const NOTES_DIRECTORY = path.resolve(__dirname, "../notes");
const NOTE_NAME_PATTERN = /^[^/\\.][^/\\]*\.excalidraw$/i;

const getNotePath = (name: string) => {
  if (!NOTE_NAME_PATTERN.test(name) || name.includes("..")) {
    return null;
  }
  const notePath = path.resolve(NOTES_DIRECTORY, name);
  return notePath.startsWith(`${NOTES_DIRECTORY}${path.sep}`) ? notePath : null;
};

const sendJson = (res: any, status: number, data: unknown) => {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
};

export const repositoryNotesPlugin = (): Plugin => ({
  name: "repository-notes",
  async configureServer(server) {
    await fs.mkdir(NOTES_DIRECTORY, { recursive: true });
    server.middlewares.use(async (req, res, next) => {
      const requestUrl = new URL(req.url || "/", "http://localhost");
      if (!requestUrl.pathname.startsWith("/api/notes")) {
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

        if (req.method === "GET") {
          const content = await fs.readFile(notePath, "utf8");
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(content);
          return;
        }

        if (req.method === "PUT") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
          }
          const content = Buffer.concat(chunks).toString("utf8");
          const parsed = JSON.parse(content);
          if (!parsed || parsed.type !== "excalidraw") {
            sendJson(res, 400, { error: "Invalid Excalidraw document" });
            return;
          }
          await fs.writeFile(notePath, content, "utf8");
          sendJson(res, 200, { name });
          return;
        }

        res.setHeader("Allow", "GET, PUT");
        sendJson(res, 405, { error: "Method not allowed" });
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          sendJson(res, 404, { error: "Note not found" });
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
});

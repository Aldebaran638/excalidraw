import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { createServices } from "./services";
import { sendJson } from "./notes";

const notes = path.resolve(process.env.REPOSITORY_NOTES_DIR || "notes");
const publicDir = path.resolve(
  process.env.STATIC_DIR || "excalidraw-app/build",
);
const services = await createServices(notes);
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};
const server = createServer((req, res) => {
  void (async () => {
    if (await services.handle(req, res)) {
      return;
    }
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "Unknown endpoint" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const relative = decodeURIComponent(url.pathname);
    let file = path.resolve(publicDir, `.${relative}`);
    if (file !== publicDir && !file.startsWith(publicDir + path.sep)) {
      sendJson(res, 400, { error: "Invalid path" });
      return;
    }
    if (!path.extname(file) || relative === "/") {
      file = path.join(publicDir, "index.html");
    }
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": relative.startsWith("/assets/")
          ? "public,max-age=31536000,immutable"
          : "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      sendJson(res, 404, { error: "Not found" });
    }
  })().catch(() => sendJson(res, 500, { error: "Server error" }));
});
server.listen(Number(process.env.PORT || 3001), "0.0.0.0", () =>
  console.info(
    `Excalidraw production server listening on ${process.env.PORT || 3001}`,
  ),
);
const close = () => {
  server.close();
  void services.close().then(() => process.exit(0));
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Local mirrors of the pinned dependencies, no runtime npm/CDN fetches. */
export async function appLibraryAssets() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["react", "d3", "mermaid"].map(
      (name) => `excalidraw-app/libraries/${name}.ts`,
    ),
    outdir: "app-libraries",
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return result.outputFiles.map((file) => ({
    name: path.basename(file.path),
    source: file.text,
  }));
}

export function appLibrariesPlugin() {
  let assets;
  const load = () => (assets ||= appLibraryAssets());
  return {
    name: "note-app-libraries",
    async generateBundle() {
      for (const asset of await load()) {
        this.emitFile({
          type: "asset",
          fileName: `app-libraries/${asset.name}`,
          source: asset.source,
        });
      }
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!/^\/app-libraries\/(react|d3|mermaid)\.js$/.test(req.url || "")) {
          next();
          return;
        }
        try {
          const asset = (await load()).find(
            (a) => `/app-libraries/${a.name}` === req.url,
          );
          res.setHeader("Content-Type", "application/javascript");
          res.setHeader("Cache-Control", "no-cache");
          res.end(asset.source);
        } catch {
          res.statusCode = 500;
          res.end("Library build failed");
        }
      });
    },
  };
}

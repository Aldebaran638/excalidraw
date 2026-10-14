import { build } from "esbuild";
await build({
  entryPoints: ["excalidraw-app/server/main.ts"],
  outfile: "excalidraw-app/server-dist/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  external: ["fsevents"],
});

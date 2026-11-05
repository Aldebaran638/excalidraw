import { build } from "esbuild";
import { copyAgentRuntime } from "../../scripts/copy-agent-runtime.mjs";
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
  external: ["fsevents", "@earendil-works/*", "typebox"],
});

await copyAgentRuntime("excalidraw-app/server-dist");

import { defineConfig } from "vitest/config";

import base from "./vitest.config.mts";

// Server SDKs require Node's stream, abort and transport implementations.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    environment: "node",
    setupFiles: [],
    testTimeout: 20000,
    fileParallelism: false,
    include: ["excalidraw-app/tests/**/*.test.ts"],
  },
});

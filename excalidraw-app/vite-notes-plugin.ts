import path from "node:path";

import { createServices } from "./server/services";

import type { Plugin } from "vite";

export const repositoryNotesPlugin = (): Plugin => ({
  name: "repository-notes",
  async configureServer(server) {
    const services = await createServices(
      path.resolve(
        process.env.REPOSITORY_NOTES_DIR || path.join(__dirname, "../notes"),
      ),
    );
    if (server.httpServer) {
      // End SSE before close waits for open connections (including Vite restarts).
      const close = server.httpServer.close.bind(server.httpServer);
      server.httpServer.close = ((callback?: (error?: Error) => void) => {
        void services.close();
        return close(callback);
      }) as typeof server.httpServer.close;
    }
    server.middlewares.use((req, res, next) => {
      void services
        .handle(req, res)
        .then((handled) => {
          if (!handled) {
            next();
          }
        })
        .catch(next);
    });
  },
  handleHotUpdate(context) {
    return context.file.endsWith(".excalidraw") ? [] : undefined;
  },
});

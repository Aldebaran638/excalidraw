import { createAIHandler, aiConfigFromEnv } from "./ai";
import { createNoteService, sendJson } from "./notes";

import type { IncomingMessage, ServerResponse } from "node:http";

export const createServices = async (notesDirectory: string) => {
  const notes = await createNoteService(notesDirectory);
  const ai = createAIHandler(aiConfigFromEnv());
  return {
    close: notes.close,
    handle: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url?.split("?")[0] === "/api/health") {
        sendJson(res, 200, {
          healthy: true,
          repositoryNotes: true,
          widgets: true,
        });
        return true;
      }
      return (await notes.handle(req, res)) || (await ai(req, res));
    },
  };
};

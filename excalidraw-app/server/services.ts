import { createAIHandler, aiConfigFromEnv } from "./ai";
import { createNoteService, sendJson } from "./notes";
import { createChatService } from "./chat";

import type { IncomingMessage, ServerResponse } from "node:http";

export const createServices = async (notesDirectory: string) => {
  const notes = await createNoteService(notesDirectory);
  const ai = createAIHandler(aiConfigFromEnv());
  const chats = await createChatService(notesDirectory, aiConfigFromEnv());
  return {
    close: async () => {
      await chats.close();
      await notes.close();
    },
    handle: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url?.split("?")[0] === "/api/health") {
        sendJson(res, 200, {
          healthy: true,
          repositoryNotes: true,
          widgets: true,
          chats: true,
        });
        return true;
      }
      return (
        (await chats.handle(req, res)) ||
        (await notes.handle(req, res)) ||
        (await ai(req, res))
      );
    },
  };
};

import { createAIHandler, aiConfigFromEnv } from "./ai";
import { createNoteService, sendJson } from "./notes";
import { createChatService } from "./chat";
import { clientInfo } from "./clientInfo";
import { createAppApi } from "./appApi";

import type { IncomingMessage, ServerResponse } from "node:http";

export const createServices = async (notesDirectory: string) => {
  const notes = await createNoteService(notesDirectory);
  const apps = createAppApi(notesDirectory);
  const ai = createAIHandler(aiConfigFromEnv());
  const chats = await createChatService(
    notesDirectory,
    aiConfigFromEnv(),
    fetch,
    { requireClientCapabilities: true },
  );
  return {
    close: async () => {
      await chats.close();
      await notes.close();
    },
    handle: async (req: IncomingMessage, res: ServerResponse) => {
      if (
        req.url?.split("?")[0] === "/api/client-info" &&
        req.method === "GET"
      ) {
        sendJson(res, 200, await clientInfo());
        return true;
      }
      if (req.url?.split("?")[0] === "/api/health") {
        sendJson(res, 200, {
          healthy: true,
          repositoryNotes: true,
          widgets: true,
          chats: true,
        });
        return true;
      }
      if (req.url?.split("?")[0] === "/api/ai/widgets/generate") {
        sendJson(res, 410, {
          error: "旧 JSON 创作面板已退役，请通过聊天创建 HTML 应用。",
        });
        return true;
      }
      return (
        (await apps(req, res)) ||
        (await chats.handle(req, res)) ||
        (await notes.handle(req, res)) ||
        (await ai(req, res))
      );
    },
  };
};

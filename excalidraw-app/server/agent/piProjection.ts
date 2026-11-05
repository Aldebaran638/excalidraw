import fs from "node:fs/promises";
import path from "node:path";

import { ChatStore } from "../chatStore";
import { validId } from "../../data/noteIdentity";

import type { ChatMessage } from "../../data/chatTypes";

const fileFor = (directory: string, noteId: string, sessionId: string) => {
  if (![noteId, sessionId].every(validId)) {
    throw new Error("无效 Pi 投影身份");
  }
  return path.join(
    directory,
    ".chats",
    noteId,
    "pi",
    sessionId,
    "projection.json",
  );
};

/** Durable outbox: the transcript may settle before the UI projection is saved. */
export async function checkpointPiProjection(
  directory: string,
  noteId: string,
  sessionId: string,
  message: ChatMessage,
) {
  const file = fileFor(directory, noteId, sessionId);
  await new ChatStore(directory).atomic(file, {
    version: 1,
    noteId,
    sessionId,
    message,
  });
}

export async function acknowledgePiProjection(
  directory: string,
  noteId: string,
  sessionId: string,
) {
  await fs.rm(fileFor(directory, noteId, sessionId), { force: true });
}

export async function recoverPiProjections(
  directory: string,
  store: ChatStore,
) {
  const root = path.join(directory, ".chats");
  for (const noteId of await fs.readdir(root).catch(() => [])) {
    if (!validId(noteId)) {
      continue;
    }
    const sessions = await fs
      .readdir(path.join(root, noteId, "pi"))
      .catch(() => []);
    for (const sessionId of sessions) {
      if (!validId(sessionId)) {
        continue;
      }
      const file = fileFor(directory, noteId, sessionId);
      let data;
      try {
        data = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      const message = data.message as ChatMessage;
      if (
        data.version !== 1 ||
        data.noteId !== noteId ||
        data.sessionId !== sessionId ||
        !validId(message?.id) ||
        !validId(message?.turnId) ||
        message.role !== "assistant"
      ) {
        throw new Error("Pi 会话恢复数据损坏；原始数据已保留");
      }
      // Never resurrect deleted sessions, edited branches, or overwrite a newer answer.
      let current;
      try {
        current = await store.read(noteId, sessionId);
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          continue;
        }
        throw error;
      }
      if (
        current.messages.some(
          (m) =>
            m.id === message.id &&
            m.turnId === message.turnId &&
            ["generating", "interrupted"].includes(m.status),
        )
      ) {
        await store.update(noteId, sessionId, (session) => {
          const index = session.messages.findIndex(
            (m) =>
              m.id === message.id &&
              m.turnId === message.turnId &&
              ["generating", "interrupted"].includes(m.status),
          );
          if (index >= 0) {
            session.messages[index] =
              message.status === "generating"
                ? {
                    ...message,
                    status: "interrupted",
                    error: "服务重启，回答已中断；已恢复收到的内容",
                  }
                : message;
          }
        });
      }
      await acknowledgePiProjection(directory, noteId, sessionId);
    }
  }
}

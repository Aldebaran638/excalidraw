import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { expect, it } from "vitest";

import { ChatStore } from "../server/chatStore";
import { createChatService } from "../server/chat";
import { CHAT_HEADERS } from "../data/clientProtocol";

it("rejects an old client before model invocation and projects saved artifacts without changing storage", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "excalidraw-protocol-"),
  );
  const noteId = randomUUID();
  await fs.writeFile(
    path.join(directory, "a.excalidraw"),
    JSON.stringify({ repositoryMetadata: { version: 1, noteId } }),
  );
  const store = new ChatStore(directory);
  const session = await store.create(noteId);
  await store.update(noteId, session.id, (s) => {
    s.messages.push({
      id: randomUUID(),
      turnId: randomUUID(),
      role: "assistant",
      content: "说明",
      createdAt: Date.now(),
      status: "complete",
      blocks: [
        {
          id: randomUUID(),
          type: "html",
          ref: { kind: "html", artifactId: randomUUID(), version: 1 },
          complete: true,
          saved: true,
        },
      ],
    });
  });
  const before = await store.read(noteId, session.id);
  let calls = 0;
  const service = await createChatService(
    directory,
    { baseUrl: "http://unused/v1", model: "test" },
    async () => {
      calls++;
      throw new Error("must not call");
    },
    { requireClientCapabilities: true },
  );
  const server = createServer((req, res) => {
    void service.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${
    (server.address() as { port: number }).port
  }/api/notes/${noteId}/chats/${session.id}`;
  try {
    const old = await fetch(url).then((r) => r.json());
    expect(old.messages[0].content).toContain("更新并刷新");
    const modern = await fetch(url, { headers: CHAT_HEADERS }).then((r) =>
      r.json(),
    );
    expect(modern.messages[0].content).toBe("说明");
    expect(modern.messages[0].blocks[0].ref).toEqual(
      before.messages[0].blocks![0].type === "html" &&
        before.messages[0].blocks![0].ref,
    );
    const response = await fetch(`${url}/turns`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(426);
    const v2 = await fetch(`${url}/turns`, {
      method: "POST",
      headers: { "X-Chat-Protocol": "2", "X-Chat-Capabilities": "html-blocks" },
      body: "{}",
    });
    expect(v2.status).toBe(426);
    expect(calls).toBe(0);
    expect(await store.read(noteId, session.id)).toEqual(before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import { runNoteAgent } from "../server/agent/piRuntime";
import { AgentLogStore } from "../server/agent/agentLog";
import { ChatStore } from "../server/chatStore";
import {
  checkpointPiProjection,
  recoverPiProjections,
} from "../server/agent/piProjection";

it("runs a streamed answer through Pi with only the notes scenario", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-notes-"));
  const noteId = randomUUID();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const log = new AgentLogStore(directory).start(noteId, sessionId, turnId);
  let text = "";
  try {
    await runNoteAgent({
      directory,
      noteId,
      sessionId,
      turnId,
      assistantMessageId: randomUUID(),
      userContent: "hello",
      uiMessageIds: [randomUUID()],
      config: { model: "fixture", baseUrl: "http://fixture/v1" },
      thinking: false,
      signal: new AbortController().signal,
      log,
      messages: [
        { role: "system", content: "Answer briefly" },
        { role: "user", content: "hello" },
      ],
      checkpoint: async () => {},
      tools: [],
      availableTools: () => [],
      executeTool: async () => "{}",
      beforeResponse: () => {},
      onText: (delta) => {
        text += delta;
      },
      onThinking: () => {},
      afterResponse: async () => false,
      transport: async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    expect(text).toBe("你好");
  } finally {
    await log.flush();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("restores the persisted Pi tool transcript on the next user turn", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-continue-"));
  const noteId = randomUUID();
  const sessionId = randomUUID();
  const firstUser = randomUUID();
  const firstAssistant = randomUUID();
  const requests: any[] = [];
  const declaration = {
    function: {
      name: "read_note",
      description: "Read the current snapshot",
      parameters: { type: "object", properties: {} },
    },
  };
  const transport: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const delta =
      requests.length === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "read-one",
                type: "function",
                function: { name: "read_note", arguments: "{}" },
              },
            ],
          }
        : { content: "已读" };
    return new Response(
      `data: ${JSON.stringify({
        choices: [{ delta }],
      })}\n\ndata: ${JSON.stringify({
        choices: [
          {
            delta: {},
            finish_reason: requests.length === 1 ? "tool_calls" : "stop",
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const executeTool = async () => JSON.stringify({ text: "snapshot-proof" });
  const run = async (
    userContent: string,
    ids: string[],
    assistantId: string,
  ) => {
    const turnId = randomUUID();
    const log = new AgentLogStore(directory).start(noteId, sessionId, turnId);
    try {
      await runNoteAgent({
        directory,
        noteId,
        sessionId,
        turnId,
        assistantMessageId: assistantId,
        userContent,
        uiMessageIds: ids,
        config: { model: "fixture", baseUrl: "http://fixture/v1" },
        thinking: false,
        signal: new AbortController().signal,
        log,
        transport,
        messages: [
          { role: "system", content: "Use read_note if needed" },
          { role: "user", content: userContent },
        ],
        tools: [declaration],
        availableTools: () => [declaration],
        executeTool,
        beforeResponse: () => {},
        onText: () => {},
        onThinking: () => {},
        checkpoint: async () => {},
        afterResponse: async (response) => response.tools.length > 0,
      });
    } finally {
      await log.flush();
    }
  };
  try {
    await run("读取", [firstUser], firstAssistant);
    await run(
      "刚才读到了什么",
      [firstUser, firstAssistant, randomUUID()],
      randomUUID(),
    );
    expect(requests).toHaveLength(3);
    expect(requests[2].messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "read-one",
        content: JSON.stringify({ text: "snapshot-proof" }),
      }),
    );
    expect(requests[2].tools.map((t: any) => t.function.name)).toEqual([
      "read_note",
    ]);
    const files = await fs.readdir(
      path.join(directory, ".chats", noteId, "pi", sessionId),
    );
    expect(files.filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("recovers a pending UI projection without resurrecting edited history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-project-"));
  const noteId = randomUUID();
  try {
    await fs.writeFile(
      path.join(directory, "note.excalidraw"),
      JSON.stringify({
        elements: [],
        repositoryMetadata: { version: 1, noteId },
      }),
    );
    const store = new ChatStore(directory);
    const session = await store.create(noteId);
    const message = {
      id: randomUUID(),
      turnId: randomUUID(),
      role: "assistant" as const,
      content: "",
      createdAt: Date.now(),
      status: "generating" as const,
    };
    await store.update(noteId, session.id, (current) => {
      current.messages.push(message);
    });
    const complete = {
      ...message,
      content: "已持久化的模型结果",
      status: "complete" as const,
    };
    await checkpointPiProjection(directory, noteId, session.id, complete);
    await recoverPiProjections(directory, store);
    expect((await store.read(noteId, session.id)).messages[0]).toEqual(
      complete,
    );
    await checkpointPiProjection(directory, noteId, session.id, {
      ...complete,
      id: randomUUID(),
    });
    await recoverPiProjections(directory, store);
    expect((await store.read(noteId, session.id)).messages).toEqual([complete]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// @vitest-environment node
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

import { AgentLogStore } from "../server/agent/agentLog";
import { ChatStore } from "../server/chatStore";
import { createChatService } from "../server/agent/chat";
import { readSSE } from "../data/sse";

import type { AgentLogEntry } from "../data/agentLog";
import type { ChatEvent, ChatSession } from "../data/chatTypes";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
const directory = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-log-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
const setup = async (transport: typeof fetch) => {
  const dir = await directory();
  const noteId = randomUUID();
  await fs.writeFile(
    path.join(dir, "test.excalidraw"),
    JSON.stringify({
      repositoryMetadata: { version: 1, noteId },
      elements: [],
    }),
  );
  const session = await new ChatStore(dir).create(noteId);
  const service = await createChatService(
    dir,
    {
      baseUrl: "http://fixture",
      model: "qwen-test",
      apiKey: "SECRET-auth-only",
    },
    transport,
  );
  cleanups.push(service.close);
  const server = createServer((req, res) => {
    void service.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${
    (server.address() as { port: number }).port
  }/api/notes/${noteId}/chats/${session.id}`;
  const turnId = randomUUID();
  return { dir, noteId, session, base, turnId, service };
};
const stream = (frames: unknown[]) => {
  const bytes = new TextEncoder().encode(
    `${frames
      .map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`)
      .join("")}data: [DONE]\r\n\r\n`,
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) {
          controller.enqueue(bytes.slice(i, i + 3));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
};
const choice = (delta: object, finish_reason: string | null = null) => ({
  choices: [{ delta, finish_reason }],
});
const send = async (fixture: Awaited<ReturnType<typeof setup>>) => {
  const response = await fetch(`${fixture.base}/turns`, {
    method: "POST",
    body: JSON.stringify({
      turnId: fixture.turnId,
      content: "读取当前笔记的概览，告诉我内容",
      thinking: true,
      revision: fixture.session.revision,
      snapshot: {
        capturedAt: Date.now(),
        elements: [
          { id: "text-a", type: "text", text: "仅工具读取后可见的中文" },
        ],
      },
    }),
  });
  expect(response.status).toBe(200);
  let done: ChatEvent | undefined;
  for await (const frame of readSSE(response.body!)) {
    const event = JSON.parse(frame.data) as ChatEvent;
    if (event.type === "done") {
      done = event;
    }
  }
  return done!;
};
const readAll = async (base: string, turnId: string) => {
  const response = await fetch(`${base}/agent-logs/${turnId}?download=1`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain(
    "application/x-ndjson",
  );
  return (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line)) as AgentLogEntry[];
};

it("records exact prompts, fragmented reasoning/tools, tool feedback, retry attempts and final saved status without credentials", async () => {
  let calls = 0;
  const requests: unknown[] = [];
  const fixture = await setup(async (_url, init) => {
    calls++;
    requests.push(JSON.parse(String(init?.body)));
    if (calls === 1) {
      return new Response("queue unavailable", { status: 503 });
    }
    if (calls === 2) {
      return stream([
        choice({ reasoning_content: "先读" }),
        choice({ reasoning_content: "笔记。", content: "我来读取。" }),
        choice({
          tool_calls: [
            {
              index: 0,
              id: "real-call-1",
              function: { name: "get_note_", arguments: "{" },
            },
          ],
        }),
        choice({
          tool_calls: [
            { index: 0, function: { name: "outline", arguments: "}" } },
          ],
        }),
        choice({}, "tool_calls"),
      ]);
    }
    return stream([
      choice({ content: "中文答案。" }),
      { ...choice({}, "stop"), usage: { total_tokens: 123 } },
    ]);
  });
  const before = await (await fetch(`${fixture.base}/agent-logs`)).json();
  expect(before.turns).toEqual([]);
  const done = await send(fixture);
  expect(done.message?.status).toBe("complete");
  const entries = await readAll(fixture.base, fixture.turnId);
  expect(entries.map((entry) => entry.sequence)).toEqual(
    entries.map((_, i) => i + 1),
  );
  expect(
    entries.every(
      (entry) =>
        entry.noteId === fixture.noteId &&
        entry.sessionId === fixture.session.id &&
        entry.turnId === fixture.turnId,
    ),
  ).toBe(true);
  expect(
    entries
      .filter((entry) => entry.kind === "model_request")
      .map((entry) => entry.data),
  ).toEqual(requests);
  expect(JSON.stringify(requests[0])).not.toContain("仅工具读取后可见的中文");
  const tool = entries.find((entry) => entry.kind === "tool_call")!;
  expect(tool.data).toEqual({
    toolCallId: "real-call-1",
    name: "get_note_outline",
    arguments: "{}",
  });
  const result = entries.find((entry) => entry.kind === "tool_result")!;
  expect(JSON.stringify(result.data)).toContain("仅工具读取后可见的中文");
  expect((requests[2] as { messages: unknown[] }).messages).toContainEqual({
    role: "tool",
    tool_call_id: "real-call-1",
    content: (result.data as { modelContent: string }).modelContent,
  });
  const responses = entries.filter((entry) => entry.kind === "model_response");
  expect(responses[1].data).toMatchObject({
    reasoning_content: "先读笔记。",
    content: "我来读取。",
    finish_reason: "tool_calls",
    tool_calls: [
      { id: "real-call-1", name: "get_note_outline", arguments: "{}" },
    ],
  });
  expect(responses[2].data).toMatchObject({
    content: "中文答案。",
    usage: { total_tokens: 123 },
  });
  expect(
    entries.filter((entry) => entry.kind === "model_stream").length,
  ).toBeGreaterThan(0);
  expect(JSON.stringify(entries)).not.toContain("SECRET-auth-only");
  expect(entries.at(-1)).toMatchObject({
    kind: "turn_end",
    data: { saved: true, status: "complete" },
  });
  const page = await (
    await fetch(`${fixture.base}/agent-logs/${fixture.turnId}?limit=2`)
  ).json();
  expect(page.entries).toHaveLength(2);
  expect(page.hasMore).toBe(true);
  const next = await (
    await fetch(
      `${fixture.base}/agent-logs/${fixture.turnId}?after=${page.next}&limit=2`,
    )
  ).json();
  expect(next.entries[0].sequence).toBe(3);
  for (const query of ["after=-1", "limit=0", "limit=101", "after=abc"]) {
    expect(
      (await fetch(`${fixture.base}/agent-logs/${fixture.turnId}?${query}`))
        .status,
    ).toBe(400);
  }
  expect(
    (
      await fetch(`${fixture.base}/agent-logs`, {
        headers: { Origin: "http://another-host" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${fixture.base}/agent-logs/${randomUUID()}`)).status,
  ).toBe(404);
  expect(
    (
      await fetch(
        `${fixture.base.replace(fixture.session.id, randomUUID())}/agent-logs`,
      )
    ).status,
  ).toBe(404);
  const restored = new AgentLogStore(fixture.dir);
  expect(
    (
      await restored.page(
        fixture.noteId,
        fixture.session.id,
        fixture.turnId,
        0,
        2,
      )
    ).entries,
  ).toHaveLength(2);
});

it("retains partial output and the error when the upstream stream ends without a finish marker", async () => {
  const fixture = await setup(async () =>
    stream([choice({ content: "只收到一半" })]),
  );
  const done = await send(fixture);
  expect(done.message?.status).toBe("failed");
  const entries = await readAll(fixture.base, fixture.turnId);
  expect(
    entries.find((entry) => entry.kind === "model_response")?.data,
  ).toMatchObject({ content: "只收到一半" });
  expect(entries.at(-1)).toMatchObject({
    kind: "turn_end",
    data: { status: "failed", error: expect.stringContaining("提前结束") },
  });
});

it("keeps chat usable and reports independent trace storage failure", async () => {
  const fixture = await setup(async () =>
    stream([choice({ content: "正常回答" }), choice({}, "stop")]),
  );
  vi.spyOn(fs, "appendFile").mockRejectedValue(
    Object.assign(new Error("disk full"), { code: "ENOSPC" }),
  );
  const done = await send(fixture);
  expect(done.saved).toBe(true);
  expect(done.message).toMatchObject({
    content: "正常回答",
    status: "complete",
    communicationLogError: expect.stringContaining("disk full"),
  });
  const session = (await (await fetch(fixture.base)).json()) as ChatSession;
  expect(session.messages.at(-1)?.communicationLogError).toContain("disk full");
});

it("exposes real streamed output before completion and preserves it when the user stops", async () => {
  const fixture = await setup(
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(
                  choice({ content: "正在输出，尚未结束" }),
                )}\n\n`,
              ),
            );
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(init.signal!.reason),
              { once: true },
            );
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const response = await fetch(`${fixture.base}/turns`, {
    method: "POST",
    body: JSON.stringify({
      turnId: fixture.turnId,
      content: "你好",
      revision: fixture.session.revision,
      snapshot: { capturedAt: Date.now(), elements: [] },
    }),
  });
  const consume = (async () => {
    let done: ChatEvent | undefined;
    for await (const frame of readSSE(response.body!)) {
      const event = JSON.parse(frame.data) as ChatEvent;
      if (event.type === "done") {
        done = event;
      }
    }
    return done;
  })();
  await vi.waitFor(async () => {
    const live = await (
      await fetch(`${fixture.base}/agent-logs/${fixture.turnId}`)
    ).json();
    expect(JSON.stringify(live.entries)).toContain("正在输出，尚未结束");
    expect(
      live.entries.some((entry: AgentLogEntry) => entry.kind === "turn_end"),
    ).toBe(false);
  });
  expect(
    (
      await fetch(`${fixture.base}/turns/${fixture.turnId}/stop`, {
        method: "POST",
      })
    ).ok,
  ).toBe(true);
  const done = await consume;
  expect(done?.message?.status).toBe("stopped");
  const entries = await readAll(fixture.base, fixture.turnId);
  expect(
    entries.find((entry) => entry.kind === "model_response")?.data,
  ).toMatchObject({ content: "正在输出，尚未结束", error: "用户已停止" });
  expect(entries.at(-1)).toMatchObject({
    kind: "turn_end",
    data: { status: "stopped", saved: true },
  });
});

it("preserves malformed frames, validates scope, tolerates partial tails and never overwrites a previous turn", async () => {
  const dir = await directory();
  const store = new AgentLogStore(dir);
  const noteId = randomUUID();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  expect(() => store.file("../escape", sessionId, turnId)).toThrow();
  const writer = store.start(noteId, sessionId, turnId);
  const wrapped = writer.transport(async () => stream([]));
  await wrapped("http://fixture", {
    body: JSON.stringify({ model: "fixture", messages: [] }),
  });
  writer.frame("malformed frame");
  writer.endModel("stopped");
  writer.record("turn_end", { status: "stopped" });
  await writer.flush();
  const file = store.file(noteId, sessionId, turnId);
  const original = await fs.readFile(file, "utf8");
  const duplicate = store.start(noteId, sessionId, turnId);
  duplicate.record("turn_start", {});
  await duplicate.flush();
  expect(duplicate.error).toContain("未完整保存");
  expect(await fs.readFile(file, "utf8")).toBe(original);
  await fs.appendFile(
    file,
    `${JSON.stringify({
      version: 1,
      noteId,
      sessionId,
      turnId,
      sequence: 999,
      at: "invalid date",
      kind: "turn_end",
      data: {},
    })}\n{"unfinished":`,
  );
  const page = await store.page(noteId, sessionId, turnId, 0, 100);
  expect(page.incomplete).toBe(true);
  expect(
    page.entries.find((entry) => entry.kind === "model_stream")?.data,
  ).toEqual({ frames: ["malformed frame"] });
  expect(page.entries.at(-1)?.kind).toBe("turn_end");
});

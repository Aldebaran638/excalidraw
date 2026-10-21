import { describe, expect, it, vi } from "vitest";

import { NoteChatController } from "../data/noteChats";

import type { ChatEvent, ChatSession } from "../data/chatTypes";

const noteId = "note-current-123456";
const session: ChatSession = {
  version: 1,
  noteId,
  id: "session-current-123456",
  title: "新对话",
  manualTitle: false,
  createdAt: 1,
  updatedAt: 1,
  revision: 0,
  messages: [],
};
const browser = (fetch: typeof globalThis.fetch) => {
  const storage = new Map<string, string>();
  return {
    fetch,
    AbortController,
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
  } as unknown as Window & typeof globalThis;
};
const json = (data: unknown) => new Response(JSON.stringify(data));
describe("application-owned chat controller", () => {
  it("remembers the thinking preference per note across refresh", () => {
    const ownerWindow = browser(
      vi.fn(async () => json({ sessions: [] })) as typeof fetch,
    );
    const context = { noteId, name: "a.excalidraw", documentSession: 1 };
    const create = () =>
      new NoteChatController(
        ownerWindow,
        async () => ({ noteId, name: context.name }),
        () => ({ capturedAt: 1, elements: [] }),
      );
    const first = create();
    first.bind(context);
    expect(first.getState().ui[noteId].thinking).toBeUndefined();
    first.setThinking(noteId, true);
    first.dispose();
    const restored = create();
    restored.bind(context);
    expect(restored.getState().ui[noteId].thinking).toBe(true);
    restored.setThinking(noteId, false);
    expect(restored.getState().ui[noteId].thinking).toBe(false);
    restored.dispose();
  });
  it("does not let a late list response deselect a newly created session", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetch = vi.fn(async (_url, init) =>
      init?.method === "POST" ? json(session) : pending,
    ) as typeof globalThis.fetch;
    const controller = new NoteChatController(
      browser(fetch),
      async () => ({ noteId, name: "a.excalidraw" }),
      () => ({ capturedAt: 1, elements: [] }),
    );
    controller.bind({ noteId, name: "a.excalidraw", documentSession: 1 });
    await controller.create();
    resolve(json({ sessions: [] }));
    await new Promise((done) => setTimeout(done, 0));
    expect(controller.getState().ui[noteId].selected).toBe(session.id);
    controller.dispose();
  });
  it("keeps background output scoped to its note and never overwrites unsaved text with an older disk version", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let posted: { turnId: string };
    const fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/other-note-123456/")) {
        return json({ sessions: [] });
      }
      if (String(url).endsWith("/turns")) {
        posted = JSON.parse(init!.body as string);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (String(url).endsWith(`/chats/${session.id}`)) {
        return json(session);
      }
      return json({ sessions: [session] });
    }) as typeof globalThis.fetch;
    const controller = new NoteChatController(
      browser(fetch),
      async () => ({ noteId, name: "a.excalidraw" }),
      () => ({ capturedAt: 1, elements: [] }),
    );
    controller.bind({ noteId, name: "a.excalidraw", documentSession: 1 });
    await controller.select(noteId, session.id);
    controller.setDraft(noteId, session.id, "我的问题");
    const running = controller.send(noteId, session.id);
    await vi.waitFor(() => expect(streamController).toBeDefined());
    const assistant = {
      id: "answer-current-123456",
      turnId: posted!.turnId,
      role: "assistant" as const,
      content: "",
      createdAt: 1,
      status: "generating" as const,
    };
    const started = {
      ...session,
      revision: 1,
      messages: [
        {
          ...assistant,
          id: "question-current-123456",
          role: "user" as const,
          status: "complete" as const,
          content: "我的问题",
        },
        assistant,
      ],
    };
    const push = (event: Partial<ChatEvent>) =>
      streamController.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({
            noteId,
            sessionId: session.id,
            turnId: posted!.turnId,
            ...event,
          })}\n\n`,
        ),
      );
    push({ type: "start", session: started });
    const progress = {
      generationId: "generation-one",
      attempt: 1,
      sequence: 2,
      phase: "generating" as const,
      completedNodes: 1,
    };
    push({ type: "widget_progress", toolCallId: "call-one", progress });
    push({
      type: "widget_progress",
      toolCallId: "call-one",
      progress: { ...progress, sequence: 1, completedNodes: 0 },
    });
    await vi.waitFor(() =>
      expect(
        Object.values(controller.getState().widgetBuilds)[0]?.progress.sequence,
      ).toBe(2),
    );
    controller.bind({
      noteId: "other-note-123456",
      name: "b.excalidraw",
      documentSession: 2,
    });
    push({ type: "delta", delta: "不可丢失的回答" });
    const ref = { artifactId: "artifact-one", version: 1, title: "作品一" };
    push({ type: "widget_ready", toolCallId: "call-one", artifact: ref });
    push({
      type: "widget_progress",
      toolCallId: "call-one",
      progress: { ...progress, sequence: 3 },
    });
    push({
      type: "widget_ready",
      toolCallId: "call-two",
      artifact: { ...ref, artifactId: "artifact-two", title: "作品二" },
    });
    await vi.waitFor(() =>
      expect(
        controller
          .getState()
          .sessions[`${noteId}/${session.id}`].messages.at(-1)?.artifacts,
      ).toHaveLength(2),
    );
    expect(Object.values(controller.getState().widgetBuilds)).toHaveLength(0);
    push({
      type: "done",
      message: { ...assistant, content: "不可丢失的回答", status: "complete" },
      saved: false,
    });
    streamController.close();
    await running;
    expect(controller.getState().context.name).toBe("b.excalidraw");
    expect(
      controller.getState().sessions[`${noteId}/${session.id}`].messages.at(-1)
        ?.content,
    ).toBe("不可丢失的回答");
    expect(controller.hasUnsaved()).toBe(true);
    expect(controller.getState().errors[noteId]).toBeFalsy();
    expect(controller.getState().errors[`${noteId}/${session.id}`]).toContain(
      "未保存",
    );
    expect(controller.getState().ui[noteId].unread?.[session.id]).toBe(true);
    await controller.refresh(noteId);
    expect(
      controller.getState().sessions[`${noteId}/${session.id}`].messages.at(-1)
        ?.content,
    ).toBe("不可丢失的回答");
    controller.dispose();
  });
});

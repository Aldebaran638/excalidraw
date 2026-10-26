import { describe, expect, it, vi } from "vitest";

import { NoteChatController } from "../data/noteChats";
import { CHAT_HEADERS } from "../data/clientProtocol";

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
it("preserves a new input draft typed before the previous send is accepted", async () => {
  const fetch = vi.fn(async (url, init) => {
    if (String(url).endsWith("/turns")) {
      const body = JSON.parse(String(init?.body));
      expect(body.content).toBe("第一条问题");
      controller.setDraft(noteId, session.id, "发送等待期间输入的下一条");
      return new Response(
        [
          {
            type: "start",
            noteId,
            sessionId: session.id,
            turnId: body.turnId,
            session,
          },
          {
            type: "done",
            noteId,
            sessionId: session.id,
            turnId: body.turnId,
            session: { ...session, revision: 1 },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return String(url).endsWith(`/chats/${session.id}`)
      ? json(session)
      : json({ sessions: [session] });
  }) as typeof globalThis.fetch;
  const controller = new NoteChatController(
    browser(fetch),
    async () => ({ noteId, name: "a.excalidraw" }),
    () => ({ capturedAt: 1, elements: [] }),
  );
  controller.bind({ noteId, name: "a.excalidraw", documentSession: 1 });
  await controller.select(noteId, session.id);
  controller.setDraft(noteId, session.id, "第一条问题");
  await controller.send(noteId, session.id);
  expect(controller.getState().ui[noteId].drafts[session.id]).toBe(
    "发送等待期间输入的下一条",
  );
  controller.dispose();
});
it("does not replace a newer session with a late workspace PATCH response", () => {
  const controller = new NoteChatController(
    browser(vi.fn() as typeof fetch),
    async () => ({ noteId, name: "test" }),
    () => ({ capturedAt: 0, elements: [] }),
  );
  // Access the state ingress directly to deterministically reproduce late PATCH delivery.
  // eslint-disable-next-line dot-notation
  controller["accept"]({ ...session, revision: 9, title: "较新版本" });
  // eslint-disable-next-line dot-notation
  controller["accept"]({ ...session, revision: 8, title: "迟到的旧响应" });
  expect(controller.getState().sessions[`${noteId}/${session.id}`].title).toBe(
    "较新版本",
  );
});
const json = (data: unknown) => new Response(JSON.stringify(data));
describe("application-owned chat controller", () => {
  it.each([true, false])(
    "clears streamed source on repair (live update=%s)",
    async (liveUpdate) => {
      const fetch = vi.fn(async (url, init) => {
        if (String(url).endsWith("/turns")) {
          const { turnId } = JSON.parse(String(init?.body));
          const block = {
            id: "same-card",
            type: "html" as const,
            ref: {
              kind: "html" as const,
              artifactId: "app-current-123456",
              version: 1,
            },
            complete: false,
          };
          const message = {
            id: "repair-answer-123456",
            turnId,
            role: "assistant" as const,
            content: "",
            createdAt: 1,
            status: "generating" as const,
            blocks: [],
          };
          const next = {
            ...block,
            ref: { ...block.ref, version: 2 },
            complete: true,
            saved: true,
          };
          const frames = [
            {
              type: "start",
              session: { ...session, messages: [message] },
              message,
            },
            {
              type: "block",
              sequence: 1,
              block,
              blockDelta: "<script>const x={3RC:1};</script>",
            },
            ...(liveUpdate
              ? [{ type: "block", sequence: 2, block: next }]
              : []),
            {
              type: "done",
              saved: true,
              session: {
                ...session,
                messages: [{ ...message, status: "complete", blocks: [next] }],
              },
              message: { ...message, status: "complete", blocks: [next] },
            },
          ];
          return new Response(
            frames
              .map(
                (frame) =>
                  `data: ${JSON.stringify({
                    ...frame,
                    noteId,
                    sessionId: session.id,
                    turnId,
                  })}\n\n`,
              )
              .join(""),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return String(url).endsWith(`/chats/${session.id}`)
          ? json(session)
          : json({ sessions: [session] });
      }) as typeof globalThis.fetch;
      const controller = new NoteChatController(
        browser(fetch),
        async () => ({ noteId, name: "a.excalidraw" }),
        () => ({ capturedAt: 1, elements: [] }),
      );
      controller.bind({ noteId, name: "a.excalidraw", documentSession: 1 });
      await controller.select(noteId, session.id);
      controller.setDraft(noteId, session.id, "创建应用");
      await controller.send(noteId, session.id);
      const blocks = controller
        .getState()
        .sessions[`${noteId}/${session.id}`].messages.at(-1)!.blocks!;
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type === "html" && blocks[0].ref.version).toBe(2);
      expect(
        (blocks[0].type === "html" && blocks[0].source) || "",
      ).not.toContain("3RC");
      controller.dispose();
    },
  );
  it("detects a mismatched entry without reloading or losing the input draft", async () => {
    const fetch = vi.fn(async () =>
      json({
        buildId: "index-new.js",
        chatProtocolVersion: 3,
        htmlRuntimeVersion: 2,
      }),
    ) as typeof globalThis.fetch;
    const ownerWindow = browser(fetch);
    Object.assign(ownerWindow, {
      document: {
        querySelector: () => ({ src: "http://test/assets/index-old.js" }),
      },
      location: { reload: vi.fn() },
    });
    const controller = new NoteChatController(
      ownerWindow,
      async () => ({ noteId, name: "a.excalidraw" }),
      () => ({ capturedAt: 1, elements: [] }),
    );
    controller.bind({ noteId, name: "a.excalidraw", documentSession: 1 });
    controller.setDraft(noteId, session.id, "未发送的输入");
    await controller.checkClientVersion();
    expect(controller.getState().updateAvailable).toBe(true);
    expect(controller.getState().ui[noteId].drafts[session.id]).toBe(
      "未发送的输入",
    );
    expect(ownerWindow.location.reload).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject(
      CHAT_HEADERS,
    );
    controller.dispose();
  });
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

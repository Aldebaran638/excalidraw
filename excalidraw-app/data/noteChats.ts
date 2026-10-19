import { randomId } from "@excalidraw/common";

import { readSSE } from "./sse";

import type {
  ChatEvent,
  ChatSession,
  ChatSummary,
  NoteSnapshot,
} from "./chatTypes";

type BrowserWindow = Window & typeof globalThis;
type Context = {
  noteId: string | null;
  name: string | null;
  documentSession: number;
};
type UI = {
  selected: string | null;
  drafts: Record<string, string>;
  scrolls: Record<string, number>;
  unread?: Record<string, boolean>;
};
type State = {
  context: Context;
  lists: Record<string, ChatSummary[]>;
  sessions: Record<string, ChatSession>;
  ui: Record<string, UI>;
  errors: Record<string, string>;
  busy: boolean;
  storageError: string;
};
const blankUI = (): UI => ({ selected: null, drafts: {}, scrolls: {} });
export class NoteChatController {
  private state: State = {
    context: { noteId: null, name: null, documentSession: 0 },
    lists: {},
    sessions: {},
    ui: {},
    errors: {},
    busy: false,
    storageError: "",
  };
  private listeners = new Set<() => void>();
  private frame: number | null = null;
  private refreshVersions = new Map<string, number>();
  private unsaved = new Set<string>();
  private deleted = new Set<string>();
  private active = new Map<
    string,
    { turnId: string; abort: AbortController }
  >();
  constructor(
    private ownerWindow: BrowserWindow,
    public ensureIdentity: (
      fork?: boolean,
    ) => Promise<{ noteId: string; name: string }>,
    public capture: () => NoteSnapshot,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  private emit = (batched = false) => {
    const notify = () => {
      this.frame = null;
      this.state = { ...this.state };
      this.listeners.forEach((listener) => listener());
    };
    if (batched) {
      if (this.frame === null) {
        this.frame = this.ownerWindow.requestAnimationFrame(notify);
      }
    } else {
      if (this.frame !== null) {
        this.ownerWindow.cancelAnimationFrame(this.frame);
      }
      notify();
    }
  };
  private url(noteId: string, sessionId?: string) {
    return `/api/notes/${encodeURIComponent(noteId)}/chats${
      sessionId ? `/${encodeURIComponent(sessionId)}` : ""
    }`;
  }
  private async request(url: string, init?: RequestInit) {
    const response = await this.ownerWindow.fetch(url, init);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "聊天服务不可用");
    }
    return data;
  }
  private error(noteId: string, error: unknown) {
    this.state.errors = {
      ...this.state.errors,
      [noteId]: (error as Error).message,
    };
    this.emit();
  }
  bind(context: Context) {
    const old = this.state.context;
    if (
      old.noteId === context.noteId &&
      old.name === context.name &&
      old.documentSession === context.documentSession
    ) {
      return;
    }
    this.state.context = context;
    if (context.noteId && !this.state.ui[context.noteId]) {
      let ui = blankUI();
      try {
        const saved = JSON.parse(
          this.ownerWindow.localStorage.getItem(
            `note-chat-ui:${context.noteId}`,
          ) || "null",
        );
        if (
          saved &&
          typeof saved.drafts === "object" &&
          typeof saved.scrolls === "object"
        ) {
          ui = saved;
        }
      } catch {
        this.state.storageError = "输入草稿仅在当前页面保留：浏览器存储不可用";
      }
      this.state.ui = { ...this.state.ui, [context.noteId]: ui };
    }
    this.emit();
    if (context.noteId) {
      void this.refresh(context.noteId);
    }
  }
  private saveUI(noteId: string, ui: UI, notify = true) {
    this.state.ui = { ...this.state.ui, [noteId]: ui };
    try {
      this.ownerWindow.localStorage.setItem(
        `note-chat-ui:${noteId}`,
        JSON.stringify(ui),
      );
    } catch {
      this.state.storageError = "输入草稿仅在当前页面保留：浏览器存储不可用";
    }
    if (notify) {
      this.emit();
    }
  }
  setDraft(noteId: string, sessionId: string, content: string) {
    const ui = this.state.ui[noteId] || blankUI();
    this.saveUI(noteId, {
      ...ui,
      drafts: { ...ui.drafts, [sessionId]: content },
    });
  }
  saveScroll(noteId: string, sessionId: string, position: number) {
    const ui = this.state.ui[noteId] || blankUI();
    this.saveUI(
      noteId,
      { ...ui, scrolls: { ...ui.scrolls, [sessionId]: position } },
      false,
    );
  }
  private accept(session: ChatSession, batched = false) {
    const key = `${session.noteId}/${session.id}`;
    this.state.sessions = { ...this.state.sessions, [key]: session };
    const { messages, ...summary } = session;
    const list = this.state.lists[session.noteId] || [];
    this.state.lists = {
      ...this.state.lists,
      [session.noteId]: [
        {
          ...summary,
          generating: messages.some(
            (message) => message.status === "generating",
          ),
        },
        ...list.filter((entry) => entry.id !== session.id),
      ].sort((a, b) => b.updatedAt - a.updatedAt),
    };
    this.emit(batched);
  }
  private acceptRemote(session: ChatSession) {
    const key = `${session.noteId}/${session.id}`;
    const local = this.state.sessions[key];
    if (
      this.deleted.has(key) ||
      this.active.has(key) ||
      (local && session.revision < local.revision)
    ) {
      return;
    }
    if (
      this.unsaved.has(key) &&
      local &&
      local.messages.some(
        (message) =>
          !session.messages
            .find((remote) => remote.id === message.id)
            ?.content.startsWith(message.content),
      )
    ) {
      this.error(
        key,
        new Error(
          "回答尚未保存：已保留当前页面内容，请先复制回答。重新加载不会覆盖这些文字。",
        ),
      );
      return;
    }
    this.unsaved.delete(key);
    this.accept(session);
  }
  async refresh(noteId = this.state.context.noteId) {
    if (!noteId) {
      return;
    }
    const version = (this.refreshVersions.get(noteId) || 0) + 1;
    this.refreshVersions.set(noteId, version);
    try {
      const { sessions } = await this.request(this.url(noteId));
      if (this.refreshVersions.get(noteId) !== version) {
        return;
      }
      if (![...this.unsaved].some((key) => key.startsWith(`${noteId}/`))) {
        this.state.errors = { ...this.state.errors, [noteId]: "" };
      }
      this.state.lists = { ...this.state.lists, [noteId]: sessions };
      const ui = this.state.ui[noteId] || blankUI();
      const selected = sessions.some(
        (entry: ChatSummary) => entry.id === ui.selected,
      )
        ? ui.selected
        : sessions[0]?.id || null;
      this.saveUI(noteId, { ...ui, selected });
      if (selected && !this.active.has(`${noteId}/${selected}`)) {
        this.acceptRemote(await this.request(this.url(noteId, selected)));
      }
    } catch (error) {
      this.error(noteId, error);
    }
  }
  async select(noteId: string, sessionId: string) {
    const ui = this.state.ui[noteId] || blankUI();
    this.saveUI(noteId, {
      ...ui,
      selected: sessionId,
      unread: { ...ui.unread, [sessionId]: false },
    });
    if (this.active.has(`${noteId}/${sessionId}`)) {
      return;
    }
    try {
      this.acceptRemote(await this.request(this.url(noteId, sessionId)));
    } catch (error) {
      this.error(`${noteId}/${sessionId}`, error);
    }
  }
  async create(fork = false) {
    if (this.state.busy) {
      return;
    }
    const context = this.state.context;
    this.state.busy = true;
    this.emit();
    try {
      const identity = await this.ensureIdentity(fork);
      const current = this.state.context;
      if (
        current.documentSession !== context.documentSession ||
        (context.noteId &&
          current.noteId &&
          context.noteId !== current.noteId &&
          !fork)
      ) {
        throw new Error("笔记已切换，请在目标笔记重新创建会话");
      }
      this.bind({ ...current, noteId: identity.noteId, name: identity.name });
      this.refreshVersions.set(
        identity.noteId,
        (this.refreshVersions.get(identity.noteId) || 0) + 1,
      );
      const session: ChatSession = await this.request(
        this.url(identity.noteId),
        { method: "POST" },
      );
      this.accept(session);
      const ui = this.state.ui[identity.noteId] || blankUI();
      this.saveUI(identity.noteId, { ...ui, selected: session.id });
      this.state.errors = { ...this.state.errors, [identity.noteId]: "" };
    } catch (error) {
      if (
        context.noteId ||
        context.documentSession === this.state.context.documentSession
      ) {
        this.error(context.noteId || "unbound", error);
      }
    } finally {
      this.state.busy = false;
      this.emit();
    }
  }
  async rename(noteId: string, id: string, title: string) {
    try {
      const current = this.state.sessions[`${noteId}/${id}`];
      this.accept(
        await this.request(this.url(noteId, id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, revision: current.revision }),
        }),
      );
    } catch (error) {
      this.error(`${noteId}/${id}`, error);
    }
  }
  async remove(noteId: string, id: string) {
    try {
      await this.request(this.url(noteId, id), { method: "DELETE" });
      this.deleted.add(`${noteId}/${id}`);
      this.refreshVersions.set(
        noteId,
        (this.refreshVersions.get(noteId) || 0) + 1,
      );
      const ui = this.state.ui[noteId] || blankUI();
      const drafts = { ...ui.drafts };
      const scrolls = { ...ui.scrolls };
      delete drafts[id];
      delete scrolls[id];
      this.saveUI(noteId, {
        ...ui,
        drafts,
        scrolls,
        selected: ui.selected === id ? null : ui.selected,
      });
      const sessions = { ...this.state.sessions };
      delete sessions[`${noteId}/${id}`];
      this.unsaved.delete(`${noteId}/${id}`);
      this.state.sessions = sessions;
      await this.refresh(noteId);
    } catch (error) {
      this.error(`${noteId}/${id}`, error);
    }
  }
  isActive(noteId: string, id: string) {
    return this.active.has(`${noteId}/${id}`);
  }
  isUnsaved(noteId: string, id: string) {
    return this.unsaved.has(`${noteId}/${id}`);
  }
  hasUnsaved() {
    return this.unsaved.size > 0;
  }
  markRead(noteId: string, id: string) {
    const ui = this.state.ui[noteId];
    if (ui?.unread?.[id]) {
      this.saveUI(noteId, { ...ui, unread: { ...ui.unread, [id]: false } });
    }
  }
  async stop(noteId: string, id: string) {
    const session = this.state.sessions[`${noteId}/${id}`];
    const turnId =
      this.active.get(`${noteId}/${id}`)?.turnId ||
      session?.messages.findLast((message) => message.status === "generating")
        ?.turnId;
    if (!turnId) {
      return;
    }
    try {
      await this.request(`${this.url(noteId, id)}/turns/${turnId}/stop`, {
        method: "POST",
      });
    } catch (error) {
      this.error(`${noteId}/${id}`, error);
    }
  }
  async send(noteId: string, id: string, retryMessageId?: string) {
    const key = `${noteId}/${id}`;
    if (this.unsaved.has(key)) {
      this.error(
        key,
        new Error("请先复制未保存的回答，再重新加载会话核对保存状态"),
      );
      return;
    }
    const session = this.state.sessions[key];
    const retry = session?.messages.find(
      (message) => message.id === retryMessageId && message.role === "user",
    );
    const content = retry?.content || this.state.ui[noteId]?.drafts[id]?.trim();
    if (
      !content ||
      !session ||
      this.active.has(key) ||
      this.state.context.noteId !== noteId
    ) {
      return;
    }
    const snapshot = this.capture();
    const turnId = randomId();
    const abort = new this.ownerWindow.AbortController();
    this.active.set(key, { turnId, abort });
    this.state.errors = { ...this.state.errors, [key]: "" };
    this.emit();
    let terminal = false;
    try {
      const response = await this.ownerWindow.fetch(
        `${this.url(noteId, id)}/turns`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abort.signal,
          body: JSON.stringify({
            turnId,
            content,
            retryMessageId,
            snapshot,
            revision: session.revision,
            noteName: this.state.context.name,
          }),
        },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "发送失败");
      }
      if (
        !response.headers.get("Content-Type")?.includes("text/event-stream")
      ) {
        const result = await response.json();
        if (result.session) {
          this.accept(result.session);
        }
        return;
      }
      if (!response.body) {
        throw new Error("当前浏览器不支持流式响应");
      }
      for await (const frame of readSSE(response.body)) {
        const event = JSON.parse(frame.data) as ChatEvent;
        if (
          event.noteId !== noteId ||
          event.sessionId !== id ||
          event.turnId !== turnId
        ) {
          continue;
        }
        if (event.session) {
          this.accept(event.session, true);
        }
        if (event.type === "start" && !retry) {
          this.setDraft(noteId, id, "");
        }
        const current = this.state.sessions[key];
        if (current && (event.delta || event.activity || event.message)) {
          const next = {
            ...current,
            messages: current.messages.map((message) => {
              if (message.role !== "assistant" || message.turnId !== turnId) {
                return message;
              }
              if (event.message) {
                return event.message;
              }
              if (event.activity) {
                return {
                  ...message,
                  activities: [
                    ...(message.activities || []).filter(
                      (activity) => activity.id !== event.activity!.id,
                    ),
                    event.activity!,
                  ],
                };
              }
              return {
                ...message,
                content: message.content + (event.delta || ""),
              };
            }),
          };
          this.accept(next, true);
        }
        if (event.type === "error") {
          this.error(key, new Error(event.error || "回答中断"));
        }
        if (event.type === "done") {
          terminal = true;
          if (!event.saved) {
            this.unsaved.add(key);
            this.error(key, new Error("回答尚未保存"));
          }
        }
      }
      if (!terminal) {
        throw new Error(
          "连接提前结束；已收到的文字保留，请重新打开会话确认保存状态",
        );
      }
    } catch (error) {
      const current = this.state.sessions[key];
      if (
        current?.messages.some(
          (message) =>
            message.turnId === turnId && message.status === "generating",
        )
      ) {
        this.unsaved.add(key);
        this.accept({
          ...current,
          messages: current.messages.map((message) =>
            message.turnId === turnId && message.role === "assistant"
              ? {
                  ...message,
                  status: "interrupted",
                  error: (error as Error).message,
                }
              : message,
          ),
        });
      }
      this.error(key, error);
    } finally {
      this.active.delete(key);
      const ui = this.state.ui[noteId] || blankUI();
      if (this.state.context.noteId !== noteId || ui.selected !== id) {
        this.saveUI(noteId, { ...ui, unread: { ...ui.unread, [id]: true } });
      }
      this.emit();
    }
  }
  dispose() {
    for (const value of this.active.values()) {
      value.abort.abort();
    }
    if (this.frame !== null) {
      this.ownerWindow.cancelAnimationFrame(this.frame);
    }
  }
}

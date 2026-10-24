import { randomId } from "@excalidraw/common";

import { WidgetRuntimeState } from "../../packages/interactive-widgets/runtimeState";

import { readSSE } from "./sse";
import { widgetRef, sameState } from "./chatWidgets";
import {
  CHAT_HEADERS,
  CHAT_PROTOCOL_VERSION,
  HTML_RUNTIME_VERSION,
} from "./clientProtocol";
import { applyAppUpdate } from "./appUpdate";

import type { HtmlArtifact, HtmlState, HtmlRef } from "./chatHtml";
import type { HtmlChatHost } from "../hooks/useCanvasHtmlApps";

import type {
  ChatWorkspace,
  ChatWidgetData,
  ChatWidgetHost,
  ChatWidgetRef,
} from "./chatWidgets";
import type { WidgetState } from "../../packages/interactive-widgets/types";
import type { WidgetGenerationProgress } from "../../packages/interactive-widgets/streamPreview";

import type {
  ChatEvent,
  ChatSession,
  ChatSummary,
  NoteSnapshot,
} from "./chatTypes";

export type ChatWidgetBuild = {
  noteId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  progress: WidgetGenerationProgress;
  error?: string;
};

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
  thinking?: boolean;
  workspaces?: Record<string, ChatWorkspace | undefined>;
  workspaceGenerations?: Record<string, string>;
  recoveries?: Record<
    string,
    { artifactId: string; version: number } | undefined
  >;
};
type State = {
  context: Context;
  lists: Record<string, ChatSummary[]>;
  sessions: Record<string, ChatSession>;
  ui: Record<string, UI>;
  errors: Record<string, string>;
  busy: boolean;
  storageError: string;
  artifacts: Record<string, ChatWidgetData>;
  artifactErrors: Record<string, string>;
  widgetPhases: Record<string, string>;
  placing: string | null;
  widgetBuilds: Record<string, ChatWidgetBuild>;
  updateAvailable?: boolean;
  clientInfo?: {
    buildId: string;
    chatProtocolVersion: number;
    htmlRuntimeVersion: number;
    loadedEntry?: string;
  };
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
    artifacts: {},
    artifactErrors: {},
    widgetPhases: {},
    placing: null,
    widgetBuilds: {},
  };
  private listeners = new Set<() => void>();
  private frame: number | null = null;
  private refreshVersions = new Map<string, number>();
  private unsaved = new Set<string>();
  private deleted = new Set<string>();
  public widgetHost?: ChatWidgetHost;
  public htmlHost?: HtmlChatHost;
  private htmlTrials = new Map<string, HtmlState>();
  private workspaceWrites = new Map<string, Promise<void>>();
  setHtmlTrial(
    noteId: string,
    sessionId: string,
    ref: HtmlRef,
    state: HtmlState,
  ) {
    this.htmlTrials.set(
      `${noteId}/${sessionId}/${ref.artifactId}/${ref.version}`,
      structuredClone(state),
    );
  }
  async placeHtml(data: HtmlArtifact, state: HtmlState) {
    if (
      !this.htmlHost ||
      this.state.context.noteId !== data.noteId ||
      this.state.ui[data.noteId]?.selected !== data.sessionId
    ) {
      throw new Error("请返回作品所属笔记和会话再导入");
    }
    await this.ensureIdentity();
    const session = this.state.context.documentSession;
    const valid = () =>
      this.state.context.noteId === data.noteId &&
      this.state.context.documentSession === session;
    await this.htmlHost.place(data, state, valid, (elementId) => {
      if (valid()) {
        this.setWorkspace(data.noteId, data.sessionId, {
          kind: "element",
          elementId,
        });
      }
    });
  }
  async applyHtml(data: HtmlArtifact, state: HtmlState, trial: boolean) {
    if (
      !this.htmlHost ||
      this.state.context.noteId !== data.noteId ||
      this.state.ui[data.noteId]?.selected !== data.sessionId
    ) {
      throw new Error("请返回作品所属笔记和会话再应用");
    }
    await this.ensureIdentity();
    await this.htmlHost.apply(data, state, trial);
    this.setWorkspace(data.noteId, data.sessionId, {
      kind: "element",
      elementId: data.target!.elementId,
    });
  }
  private widgetRuntimes = new Map<string, WidgetRuntimeState>();
  private trialTimers = new Map<string, number>();
  private trialSaves = new Map<string, Promise<void>>();
  private trialDirty = new Set<string>();
  private artifactLoads = new Map<
    string,
    Promise<ChatWidgetData | undefined>
  >();
  private completedBuilds = new Set<string>();
  private blockSequences = new Map<string, number>();
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
    const response = await this.ownerWindow.fetch(url, {
      ...init,
      headers: { ...CHAT_HEADERS, ...init?.headers },
    });
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
  async checkClientVersion() {
    try {
      const info = await this.request("/api/client-info");
      const entry = this.ownerWindow.document
        .querySelector<HTMLScriptElement>('script[type="module"][src]')
        ?.src.split("/")
        .at(-1);
      this.state.clientInfo = { ...info, loadedEntry: entry || "unknown" };
      this.state.updateAvailable =
        info.chatProtocolVersion !== CHAT_PROTOCOL_VERSION ||
        info.htmlRuntimeVersion > HTML_RUNTIME_VERSION ||
        (info.buildId !== "development" &&
          info.buildId !== "unknown" &&
          entry !== info.buildId);
      this.emit();
    } catch {
      /* Offline editing and existing applications remain available. */
    }
  }
  reloadForUpdate() {
    // saveUI writes drafts synchronously before it updates application state.
    void applyAppUpdate(this.ownerWindow).catch(() => {
      this.error(
        this.state.context.noteId || "unbound",
        new Error("界面更新失败，输入草稿仍保留。请手动刷新页面。"),
      );
    });
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
  setThinking(noteId: string, thinking: boolean) {
    this.saveUI(noteId, { ...(this.state.ui[noteId] || blankUI()), thinking });
  }
  artifactKey(
    noteId: string,
    sessionId: string,
    ref: Pick<ChatWidgetRef, "artifactId" | "version">,
  ) {
    return `${noteId}/${sessionId}/${ref.artifactId}/${ref.version}`;
  }
  setWorkspace(noteId: string, sessionId: string, workspace?: ChatWorkspace) {
    const ui = this.state.ui[noteId] || blankUI();
    // Normalize references: never persist/transmit the source passed with a card.
    workspace =
      workspace?.kind === "element"
        ? { kind: "element", elementId: workspace.elementId }
        : workspace
        ? {
            kind: workspace.kind,
            artifactId: workspace.artifactId,
            version: workspace.version,
          }
        : undefined;
    const generation = randomId();
    this.saveUI(noteId, {
      ...ui,
      workspaces: { ...ui.workspaces, [sessionId]: workspace },
      recoveries: { ...ui.recoveries, [sessionId]: undefined },
      workspaceGenerations: {
        ...ui.workspaceGenerations,
        [sessionId]: generation,
      },
    });
    const key = `${noteId}/${sessionId}`;
    const previous = this.workspaceWrites.get(key) || Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(async () => {
        const session = this.state.sessions[key];
        if (!session) {
          throw new Error("请先加载当前会话再选择目标");
        }
        const response = await this.ownerWindow.fetch(
          this.url(noteId, sessionId),
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...CHAT_HEADERS },
            body: JSON.stringify({
              revision: session.revision,
              expectedWorkspaceGeneration:
                session.appWorkspace?.generation || null,
              workspace: { generation, selection: workspace },
            }),
          },
        );
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || "创作目标尚未保存");
        }
        this.accept(result);
      });
    this.workspaceWrites.set(key, write);
    void write.catch((error) => {
      this.state.errors = { ...this.state.errors, [key]: error.message };
      this.emit();
    });
    void write.then(
      () => {
        if (this.workspaceWrites.get(key) === write) {
          this.workspaceWrites.delete(key);
        }
      },
      () => {},
    );
  }
  recoverHtml(noteId: string, sessionId: string, data: HtmlArtifact) {
    if (!data.recovery) {
      return;
    }
    this.setWorkspace(noteId, sessionId, data.recovery.base);
    const ui = this.state.ui[noteId] || blankUI();
    this.saveUI(noteId, {
      ...ui,
      workspaces: { ...ui.workspaces, [sessionId]: data.recovery.base },
      recoveries: {
        ...ui.recoveries,
        [sessionId]: { artifactId: data.artifactId, version: data.version },
      },
      drafts: {
        ...ui.drafts,
        [sessionId]: ui.drafts[sessionId]?.trim()
          ? ui.drafts[sessionId]
          : "请读取我选择的失败草稿，修正错误并保存候选；不要重新生成整个应用。",
      },
    });
  }
  runtimeForArtifact(key: string, data: ChatWidgetData) {
    let runtime = this.widgetRuntimes.get(key);
    if (!runtime) {
      runtime = new WidgetRuntimeState(data.document.state);
      this.widgetRuntimes.set(key, runtime);
    }
    return runtime;
  }
  loadArtifact(
    noteId: string,
    sessionId: string,
    ref: ChatWidgetRef,
  ): Promise<ChatWidgetData | undefined> {
    const key = this.artifactKey(noteId, sessionId, ref);
    if (this.state.artifacts[key]) {
      return Promise.resolve(this.state.artifacts[key]);
    }
    const pending = this.artifactLoads.get(key);
    if (pending) {
      return pending;
    }
    const promise = (async () => {
      try {
        const data: ChatWidgetData = await this.request(
          `${this.url(noteId, sessionId)}/artifacts/${encodeURIComponent(
            ref.artifactId,
          )}?version=${ref.version}`,
        );
        const versions = [
          ...new Map(
            [
              ...Object.values(this.state.artifacts)
                .filter(
                  (entry) =>
                    entry.noteId === noteId &&
                    entry.sessionId === sessionId &&
                    entry.artifactId === data.artifactId,
                )
                .flatMap((entry) => entry.versions),
              ...data.versions,
            ].map((entry) => [entry.version, entry]),
          ).values(),
        ].sort((a, b) => a.version - b.version);
        this.state.artifacts = Object.fromEntries(
          Object.entries({ ...this.state.artifacts, [key]: data }).map(
            ([entryKey, entry]) => [
              entryKey,
              entry.noteId === noteId &&
              entry.sessionId === sessionId &&
              entry.artifactId === data.artifactId
                ? { ...entry, versions }
                : entry,
            ],
          ),
        );
        this.state.artifactErrors = { ...this.state.artifactErrors, [key]: "" };
        this.emit();
        return data;
      } catch (error) {
        this.state.artifactErrors = {
          ...this.state.artifactErrors,
          [key]: (error as Error).message,
        };
        this.emit();
        return undefined;
      } finally {
        this.artifactLoads.delete(key);
      }
    })();
    this.artifactLoads.set(key, promise);
    return promise;
  }
  commitTrial(key: string, state: WidgetState) {
    const data = this.state.artifacts[key];
    if (!data || sameState(data.document.state, state)) {
      return;
    }
    this.runtimeForArtifact(key, data).set(state);
    this.state.artifacts = {
      ...this.state.artifacts,
      [key]: { ...data, document: { ...data.document, state } },
    };
    this.trialDirty.add(key);
    const timer = this.trialTimers.get(key);
    if (timer !== undefined) {
      this.ownerWindow.clearTimeout(timer);
    }
    this.trialTimers.set(
      key,
      this.ownerWindow.setTimeout(() => {
        this.trialTimers.delete(key);
        void this.saveTrial(key);
      }, 500),
    );
    this.emit();
  }
  async saveTrial(key: string): Promise<void> {
    const before = this.trialSaves.get(key) || Promise.resolve();
    const pending = before
      .catch(() => {})
      .then(async () => {
        const data = this.state.artifacts[key];
        if (!data || !this.trialDirty.has(key)) {
          return;
        }
        try {
          const state = data.document.state;
          const response: ChatWidgetData = await this.request(
            `${this.url(data.noteId, data.sessionId)}/artifacts/${
              data.artifactId
            }?version=${data.version}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ revision: data.revision, state }),
            },
          );
          const current = this.state.artifacts[key];
          const unchanged = sameState(current.document.state, state);
          this.state.artifacts = {
            ...this.state.artifacts,
            [key]: {
              ...response,
              document: { ...response.document, state: current.document.state },
            },
          };
          if (unchanged) {
            this.trialDirty.delete(key);
          }
          this.state.artifactErrors = {
            ...this.state.artifactErrors,
            [key]: "",
          };
        } catch (error) {
          this.state.artifactErrors = {
            ...this.state.artifactErrors,
            [key]: `试用输入尚未保存：${(error as Error).message}`,
          };
        }
        this.emit();
      });
    this.trialSaves.set(key, pending);
    await pending;
    if (this.trialSaves.get(key) === pending) {
      this.trialSaves.delete(key);
    }
  }
  async discardTrial(key: string) {
    const data = this.state.artifacts[key];
    if (!data) {
      return;
    }
    const timer = this.trialTimers.get(key);
    if (timer !== undefined) {
      this.ownerWindow.clearTimeout(timer);
      this.trialTimers.delete(key);
    }
    await this.trialSaves.get(key);
    this.trialDirty.delete(key);
    this.widgetRuntimes.delete(key);
    const { [key]: removed, ...rest } = this.state.artifacts;
    this.state.artifacts = rest;
    await this.loadArtifact(data.noteId, data.sessionId, widgetRef(data));
  }
  placeArtifact(data: ChatWidgetData) {
    if (
      !this.widgetHost ||
      this.state.context.noteId !== data.noteId ||
      this.state.ui[data.noteId]?.selected !== data.sessionId ||
      this.state.placing
    ) {
      return;
    }
    const documentSession = this.state.context.documentSession;
    const key = this.artifactKey(data.noteId, data.sessionId, widgetRef(data));
    const isCurrent = () =>
      this.state.context.noteId === data.noteId &&
      this.state.context.documentSession === documentSession &&
      this.state.ui[data.noteId]?.selected === data.sessionId;
    this.state.placing = key;
    this.emit();
    try {
      this.widgetHost.place(
        data,
        structuredClone({
          ...data.document,
          state: this.runtimeForArtifact(key, data).state,
        }),
        isCurrent,
        (id) => {
          this.state.placing = null;
          if (id && isCurrent()) {
            this.setWorkspace(data.noteId, data.sessionId, {
              kind: "element",
              elementId: id,
            });
          } else {
            this.emit();
          }
        },
      );
    } catch (error) {
      this.state.placing = null;
      this.error(`${data.noteId}/${data.sessionId}`, error);
    }
  }
  applyArtifact(data: ChatWidgetData, trialInputs: boolean) {
    if (
      this.state.context.noteId !== data.noteId ||
      this.state.ui[data.noteId]?.selected !== data.sessionId
    ) {
      throw new Error("请返回该作品所属的笔记和会话再应用");
    }
    if (!this.widgetHost || !data.target) {
      throw new Error("目标画布不可用");
    }
    const key = this.artifactKey(data.noteId, data.sessionId, widgetRef(data));
    this.widgetHost.apply(
      data,
      { ...data.document, state: this.runtimeForArtifact(key, data).state },
      trialInputs,
    );
    this.setWorkspace(data.noteId, data.sessionId, {
      kind: "element",
      elementId: data.target.elementId,
    });
  }
  private sceneKey = "";
  sceneChanged() {
    const key = JSON.stringify([
      this.htmlHost?.elements(),
      this.widgetHost?.elements(),
      ...Object.values(this.state.artifacts)
        .filter((data) => data.noteId === this.state.context.noteId)
        .map((data) =>
          this.widgetHost?.placements({
            noteId: data.noteId,
            sessionId: data.sessionId,
            artifactId: data.artifactId,
            version: data.version,
          }),
        ),
    ]);
    if (key !== this.sceneKey) {
      this.sceneKey = key;
      this.emit(true);
    }
  }
  async referenceElement(elementId: string) {
    if (!this.htmlHost?.read(elementId)) {
      return;
    }
    if (
      !this.state.context.noteId ||
      !this.state.ui[this.state.context.noteId]?.selected
    ) {
      await this.create();
    }
    const noteId = this.state.context.noteId;
    const id = noteId ? this.state.ui[noteId]?.selected : null;
    if (noteId && id && this.htmlHost?.read(elementId)) {
      this.setWorkspace(noteId, id, { kind: "element", elementId });
    }
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
    const previous = this.state.sessions[key];
    if (previous && session.revision < previous.revision) {
      return;
    }
    const workspace = session.appWorkspace;
    const ui = this.state.ui[session.noteId] || blankUI();
    if (
      workspace &&
      (!previous || session.revision >= previous.revision) &&
      (!this.workspaceWrites.has(key) ||
        ui.workspaceGenerations?.[session.id] === workspace.generation)
    ) {
      this.saveUI(
        session.noteId,
        {
          ...ui,
          workspaces: { ...ui.workspaces, [session.id]: workspace.selection },
          workspaceGenerations: {
            ...ui.workspaceGenerations,
            [session.id]: workspace.generation,
          },
        },
        false,
      );
    }
    session = {
      ...session,
      messages: session.messages.map((message) => {
        const old = previous?.messages.find((entry) => entry.id === message.id);
        return !message.blocks
          ? message
          : {
              ...message,
              blocks: message.blocks.map((block) => {
                const prior = old?.blocks?.find(
                  (entry) => entry.id === block.id,
                );
                return block.type === "html" &&
                  prior?.type === "html" &&
                  prior.ref.artifactId === block.ref.artifactId &&
                  prior.ref.version === block.ref.version &&
                  block.source === undefined
                  ? { ...block, source: prior.source }
                  : block;
              }),
            };
      }),
    };
    this.state.sessions = { ...this.state.sessions, [key]: session };
    const { messages, previousVersions, ...summary } = session;
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
          headers: { "Content-Type": "application/json", ...CHAT_HEADERS },
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
  async send(
    noteId: string,
    id: string,
    retryMessageId?: string,
    replacement?: { messageId: string; content: string },
  ) {
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
    const content =
      replacement?.content ??
      retry?.content ??
      this.state.ui[noteId]?.drafts[id]?.trim();
    if (
      !content?.trim() ||
      !session ||
      this.active.has(key) ||
      this.state.context.noteId !== noteId
    ) {
      return;
    }
    const snapshot = this.capture();
    const documentSession = this.state.context.documentSession;
    const legacySelection = this.state.ui[noteId]?.workspaces?.[id];
    if (
      legacySelection &&
      !session.appWorkspace &&
      !this.workspaceWrites.has(key)
    ) {
      this.setWorkspace(noteId, id, legacySelection);
    }
    try {
      await this.workspaceWrites.get(key);
    } catch {
      return;
    }
    if (
      this.active.has(key) ||
      this.state.context.noteId !== noteId ||
      this.state.context.documentSession !== documentSession
    ) {
      return;
    }
    const currentSession = this.state.sessions[key] || session;
    const workspace = this.state.ui[noteId]?.workspaces?.[id];
    const artifact =
      workspace?.kind === "artifact"
        ? this.state.artifacts[this.artifactKey(noteId, id, workspace)]
        : undefined;
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
          headers: { "Content-Type": "application/json", ...CHAT_HEADERS },
          signal: abort.signal,
          body: JSON.stringify({
            turnId,
            content,
            retryMessageId,
            replaceMessageId: replacement?.messageId,
            thinking: this.state.ui[noteId]?.thinking === true,
            snapshot,
            workspace,
            workspaceGeneration: currentSession.appWorkspace?.generation,
            appIntent: workspace ? "edit" : "create",
            recovery: this.state.ui[noteId]?.recoveries?.[id],
            workspaceState: artifact
              ? this.runtimeForArtifact(
                  this.artifactKey(noteId, id, artifact),
                  artifact,
                ).state
              : currentSession.appWorkspace?.head
              ? this.htmlTrials.get(
                  `${noteId}/${id}/${currentSession.appWorkspace.head.artifactId}/${currentSession.appWorkspace.head.version}`,
                )
              : workspace?.kind === "html"
              ? this.htmlTrials.get(
                  `${noteId}/${id}/${workspace.artifactId}/${workspace.version}`,
                )
              : undefined,
            revision: currentSession.revision,
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
        if (
          event.type === "workspace" &&
          event.workspace &&
          event.revision !== undefined
        ) {
          const current = this.state.sessions[key];
          if (current && event.revision >= current.revision) {
            this.accept(
              {
                ...current,
                revision: event.revision,
                appWorkspace: event.workspace,
              },
              true,
            );
          }
        }
        const buildKey = `${key}/${turnId}/${event.toolCallId}`;
        if (
          event.type === "widget_progress" &&
          event.progress &&
          event.toolCallId
        ) {
          const previous = this.state.widgetBuilds[buildKey];
          if (this.completedBuilds.has(buildKey)) {
            continue;
          }
          const progress = event.progress;
          if (
            previous &&
            (previous.error ||
              previous.progress.generationId !== progress.generationId ||
              previous.progress.sequence >= progress.sequence)
          ) {
            continue;
          }
          this.state.widgetBuilds = {
            ...this.state.widgetBuilds,
            [buildKey]: {
              noteId,
              sessionId: id,
              turnId,
              toolCallId: event.toolCallId,
              progress: {
                ...progress,
                document:
                  progress.document ||
                  (previous?.progress.attempt === progress.attempt
                    ? previous.progress.document
                    : undefined),
              },
            },
          };
          this.emit(true);
        }
        if (
          ["widget_start", "widget_ready", "widget_error"].includes(event.type)
        ) {
          if (event.toolCallId && event.type === "widget_ready") {
            this.completedBuilds.add(buildKey);
            const { [buildKey]: removed, ...remaining } =
              this.state.widgetBuilds;
            this.state.widgetBuilds = remaining;
          }
          if (
            event.type === "widget_error" &&
            this.state.widgetBuilds[buildKey]
          ) {
            this.completedBuilds.add(buildKey);
            this.state.widgetBuilds = {
              ...this.state.widgetBuilds,
              [buildKey]: {
                ...this.state.widgetBuilds[buildKey],
                error: event.error || "组件生成失败",
              },
            };
          }
          this.state.widgetPhases = {
            ...this.state.widgetPhases,
            [key]:
              event.type === "widget_start"
                ? "正在生成与校验组件…"
                : event.type === "widget_error"
                ? `组件生成失败：${event.error}`
                : "",
          };
          if (event.artifact) {
            void this.loadArtifact(noteId, id, event.artifact);
            if (
              this.state.context.noteId === noteId &&
              this.state.context.documentSession === documentSession &&
              this.state.ui[noteId]?.selected === id
            ) {
              this.setWorkspace(noteId, id, {
                kind: "artifact",
                artifactId: event.artifact.artifactId,
                version: event.artifact.version,
              });
            }
            const session = this.state.sessions[key];
            if (session) {
              this.accept(
                {
                  ...session,
                  messages: session.messages.map((message) =>
                    message.turnId === turnId && message.role === "assistant"
                      ? {
                          ...message,
                          artifacts: [
                            ...(message.artifacts || []).filter(
                              (ref) =>
                                ref.artifactId !== event.artifact!.artifactId ||
                                ref.version !== event.artifact!.version,
                            ),
                            event.artifact!,
                          ],
                        }
                      : message,
                  ),
                },
                true,
              );
            }
          }
          this.emit(true);
        }
        if (event.type === "start" && !retry && !replacement) {
          this.setDraft(noteId, id, "");
        }
        const current = this.state.sessions[key];
        if (event.block && event.sequence) {
          const sequenceKey = `${key}/${turnId}`;
          if (event.sequence <= (this.blockSequences.get(sequenceKey) || 0)) {
            continue;
          }
          this.blockSequences.set(sequenceKey, event.sequence);
        }
        if (
          current &&
          (event.delta || event.activity || event.message || event.block)
        ) {
          const next = {
            ...current,
            messages: current.messages.map((message) => {
              if (message.role !== "assistant" || message.turnId !== turnId) {
                return message;
              }
              if (event.message) {
                // Terminal messages deliberately do not persist streaming source in chat JSON.
                if (event.message.blocks) {
                  return {
                    ...event.message,
                    blocks: event.message.blocks.map((block) => {
                      const old = message.blocks?.find(
                        (entry) => entry.id === block.id,
                      );
                      return block.type === "html" &&
                        old?.type === "html" &&
                        old.ref.artifactId === block.ref.artifactId &&
                        old.ref.version === block.ref.version
                        ? { ...block, source: old.source }
                        : block;
                    }),
                  };
                }
                return event.message;
              }
              if (event.block) {
                const blocks = [...(message.blocks || [])];
                const index = blocks.findIndex(
                  (block) => block.id === event.block!.id,
                );
                const old = index >= 0 ? blocks[index] : undefined;
                let block = event.block;
                if (block.type === "html") {
                  block = {
                    ...block,
                    source:
                      (old?.type === "html" &&
                      old.ref.artifactId === block.ref.artifactId &&
                      old.ref.version === block.ref.version
                        ? old.source || ""
                        : "") + (event.blockDelta || ""),
                  };
                } else if (
                  (block.type === "text" || block.type === "reasoning") &&
                  event.blockDelta
                ) {
                  block = {
                    ...block,
                    text:
                      (old && (old.type === "text" || old.type === "reasoning")
                        ? old.text
                        : "") + event.blockDelta,
                  };
                }
                if (index < 0) {
                  blocks.push(block);
                } else {
                  blocks[index] = block;
                }
                return { ...message, blocks };
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
                ...(event.type === "reasoning"
                  ? {
                      reasoning:
                        (message.reasoning || "") + (event.delta || ""),
                    }
                  : { content: message.content + (event.delta || "") }),
              };
            }),
          };
          this.accept(next, true);
        }
        if (event.type === "error") {
          this.error(
            key,
            new Error(
              event.saved &&
              (event.message?.artifacts?.length ||
                event.message?.blocks?.some(
                  (block) => block.type === "html" && block.saved,
                ))
                ? `组件已保存，文字回复未完成：${event.error || "回答中断"}`
                : event.error || "回答中断",
            ),
          );
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
      this.state.widgetBuilds = Object.fromEntries(
        Object.entries(this.state.widgetBuilds).map(([buildKey, build]) => [
          buildKey,
          build.noteId === noteId &&
          build.sessionId === id &&
          build.turnId === turnId
            ? {
                ...build,
                error:
                  build.error || "生成已结束，未通过最终校验的预览不能导入",
              }
            : build,
        ]),
      );
      if (this.state.widgetPhases[key]?.startsWith("正在")) {
        this.state.widgetPhases = { ...this.state.widgetPhases, [key]: "" };
      }
      this.active.delete(key);
      const ui = this.state.ui[noteId] || blankUI();
      if (this.state.context.noteId !== noteId || ui.selected !== id) {
        this.saveUI(noteId, { ...ui, unread: { ...ui.unread, [id]: true } });
      }
      this.emit();
    }
  }
  dispose() {
    for (const timer of this.trialTimers.values()) {
      this.ownerWindow.clearTimeout(timer);
    }
    for (const key of this.trialDirty) {
      void this.saveTrial(key);
    }
    for (const value of this.active.values()) {
      value.abort.abort();
    }
    if (this.frame !== null) {
      this.ownerWindow.cancelAnimationFrame(this.frame);
    }
  }
}

import { useCallback, useEffect, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { cacheEmbeddableSnapshot } from "@excalidraw/excalidraw/scene/embeddableSnapshots";
import {
  newElement,
  newElementWith,
  newEmbeddableElement,
} from "@excalidraw/element";
import {
  viewportCoordsToSceneCoords,
  sceneCoordsToViewportCoords,
  randomId,
} from "@excalidraw/common";

import type {
  ExcalidrawElement,
  ExcalidrawEmbeddableElement,
  NonDeleted,
} from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  readWidgetDrafts,
  removeWidgetDraft,
  saveWidgetDraft,
  widgetDraftStore,
} from "../data/widgetDrafts";

import { computeWidget } from "../../packages/interactive-widgets/compute";
import { layoutWidget } from "../../packages/interactive-widgets/layout";
import {
  readWidget,
  reconcileState,
  validateDefinition,
} from "../../packages/interactive-widgets/schema";
import { renderSnapshot } from "../../packages/interactive-widgets/snapshot";
import { WidgetView } from "../../packages/interactive-widgets/WidgetView";
import { WidgetRuntimeState } from "../../packages/interactive-widgets/runtimeState";
import { WIDGET_LINK_PREFIX } from "../../packages/interactive-widgets/types";

import type { WidgetDraft } from "../data/widgetDrafts";

import type {
  WidgetDefinition,
  WidgetDocument,
  WidgetState,
  WidgetScrollState,
} from "../../packages/interactive-widgets/types";

type Region = { x: number; y: number; width: number; height: number };
type ContextItem = { id: string; label: string; content: string };
type Session = {
  region: Region;
  note: string | null;
  target?: string;
  definition?: WidgetDefinition;
};
export const isWidgetElement = (el: ExcalidrawElement) =>
  el.type === "embeddable" && Boolean(el.customData?.aiWidget);
export const widgetMetadata = (
  doc: WidgetDocument,
  width: number,
  height: number,
  scroll = 0,
) => ({
  aiWidget: doc,
  embeddable: {
    contentLocked: true,
    interaction: "controls",
    snapshot: renderSnapshot(doc, width, height, scroll),
    snapshotWidth: width,
    snapshotHeight: height,
  },
});

export const useAIWidgets = ({
  api,
  ownerWindow,
  noteName,
  documentSession,
}: {
  api: ExcalidrawImperativeAPI | null;
  ownerWindow: Window | null;
  noteName: string | null;
  documentSession: number;
}) => {
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [prompt, setPrompt] = useState("");
  const [context, setContext] = useState<ContextItem[]>([]);
  const [preview, setPreview] = useState<WidgetDocument | null>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const [candidates, setCandidates] = useState<WidgetDocument[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(-1);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const candidateIndexRef = useRef(candidateIndex);
  candidateIndexRef.current = candidateIndex;
  const [collapsed, setCollapsed] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [applyTrialInputs, setApplyTrialInputs] = useState(false);
  const [viewport, setViewport] = useState(0);
  const viewportKey = useRef("");
  const [recovery, setRecovery] = useState<WidgetDraft[]>([]);
  const [storageError, setStorageError] = useState("");
  const draftStorage = useRef<ReturnType<typeof widgetDraftStore> | null>(null);
  const draftKey = useRef<string | null>(null);
  const tabId = useRef("");
  const pendingDraft = useRef<WidgetDraft | null>(null);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [explanation, setExplanation] = useState("");
  const [model, setModel] = useState<{
    available: boolean;
    model: string;
  } | null>(null);
  const [selected, setSelected] =
    useState<NonDeleted<ExcalidrawEmbeddableElement> | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const dirty = useRef(new Set<string>());
  const scrolls = useRef(new Map<string, number>());
  const tableScrolls = useRef(new Map<string, WidgetScrollState>());
  const currentNote = useRef(noteName);
  currentNote.current = noteName;
  const shapeHeight = useRef(new Map<string, number>());
  const cachedGeometry = useRef(new Map<string, string>());
  const currentElements = useRef<readonly ExcalidrawElement[]>([]);
  const commitDrafts = useRef(new Map<string, () => void>());
  const snapshotTimers = useRef(new Map<string, number>());
  const runtimes = useRef(
    new Map<
      string,
      { document: WidgetDocument; runtime: WidgetRuntimeState }
    >(),
  );
  const runtimeFor = useCallback((id: string, document: WidgetDocument) => {
    let entry = runtimes.current.get(id);
    if (!entry) {
      entry = { document, runtime: new WidgetRuntimeState(document.state) };
      runtimes.current.set(id, entry);
    }
    return entry.runtime;
  }, []);
  const hasTransientEdits = useCallback(
    () => Boolean(dirty.current.size || sessionRef.current),
    [],
  );
  const exit = useCallback(() => {
    api?.updateScene({
      appState: { activeEmbeddable: null },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [api]);
  useEffect(() => {
    if (!ownerWindow) {
      return;
    }
    try {
      tabId.current =
        ownerWindow.sessionStorage.getItem("ai-widget-draft-tab") || randomId();
      ownerWindow.sessionStorage.setItem("ai-widget-draft-tab", tabId.current);
      draftStorage.current = widgetDraftStore(ownerWindow);
    } catch {
      setStorageError("仅当前会话保留：本地草稿存储不可用");
    }
  }, [ownerWindow]);
  useEffect(() => {
    if (!draftStorage.current) {
      return;
    }
    let alive = true;
    void readWidgetDrafts(draftStorage.current, tabId.current, noteName)
      .then((drafts) => {
        if (alive) {
          setRecovery(drafts);
        }
      })
      .catch(() => setStorageError("仅当前会话保留：本地草稿存储不可用"));
    return () => {
      alive = false;
    };
  }, [ownerWindow, noteName, documentSession]);
  useEffect(() => {
    if (!session || !ownerWindow || !draftStorage.current) {
      pendingDraft.current = null;
      return;
    }
    const key = (draftKey.current ||= `${tabId.current}:${
      noteName || "untitled"
    }:${session.target || randomId()}`);
    const savedCandidates = candidates.map((candidate, index) =>
      index === candidateIndex && preview ? preview : candidate,
    );
    const draft: WidgetDraft = {
      key,
      updated: Date.now(),
      note: noteName,
      session,
      prompt,
      context,
      candidates: savedCandidates,
      candidateIndex,
    };
    pendingDraft.current = draft;
    const store = draftStorage.current;
    const save = () => {
      void saveWidgetDraft(store, draft).catch(() =>
        setStorageError("仅当前会话保留：本地草稿保存失败"),
      );
    };
    const timer = ownerWindow.setTimeout(save, 500);
    return () => ownerWindow.clearTimeout(timer);
  }, [
    session,
    prompt,
    context,
    candidates,
    candidateIndex,
    preview,
    ownerWindow,
    noteName,
  ]);
  useEffect(() => {
    const flush = () => {
      if (pendingDraft.current && draftStorage.current) {
        void saveWidgetDraft(draftStorage.current, pendingDraft.current).catch(
          () => {},
        );
      }
    };
    ownerWindow?.addEventListener("pagehide", flush);
    return () => {
      ownerWindow?.removeEventListener("pagehide", flush);
      flush();
    };
  }, [ownerWindow]);
  const rememberCandidate = (document: WidgetDocument) => {
    const next = [
      ...candidatesRef.current.slice(0, candidateIndexRef.current + 1),
      document,
    ].slice(-10);
    candidatesRef.current = next;
    candidateIndexRef.current = next.length - 1;
    setCandidates(next);
    setCandidateIndex(next.length - 1);
    setPreview(document);
    setShowOriginal(false);
  };
  useEffect(() => {
    if (preview && candidateIndex >= 0) {
      setCandidates((previous) =>
        previous[candidateIndex] === preview
          ? previous
          : previous.map((candidate, index) =>
              index === candidateIndex ? preview : candidate,
            ),
      );
    }
  }, [preview, candidateIndex]);
  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setPhase("");
  }, []);
  const close = useCallback(() => {
    pendingDraft.current = null;
    cancel();
    setSession(null);
    setPreview(null);
    setError("");
    setContext([]);
    setCandidates([]);
    setCandidateIndex(-1);
    setCollapsed(false);
    if (draftStorage.current && draftKey.current) {
      void removeWidgetDraft(draftStorage.current, draftKey.current).catch(
        () => {},
      );
    }
    draftKey.current = null;
  }, [cancel]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(
    () =>
      api?.onEvent("document:replace", () => {
        if (pendingDraft.current && draftStorage.current) {
          void saveWidgetDraft(
            draftStorage.current,
            pendingDraft.current,
          ).catch(() => {});
        }
        cancel();
        setSession(null);
        setPreview(null);
        setExpanded(null);
        draftKey.current = null;
      }),
    [api, cancel],
  );
  const previousDocument = useRef(documentSession);
  useEffect(() => {
    const active = sessionRef.current;
    if (active && previousDocument.current !== documentSession) {
      if (pendingDraft.current && draftStorage.current) {
        void saveWidgetDraft(draftStorage.current, pendingDraft.current).catch(
          () => {},
        );
      }
      cancel();
      setError("笔记已切换，旧生成结果不会应用到这篇笔记。");
      setPreview(null);
      setSession(null);
      setExpanded(null);
    } else if (active && active.note !== noteName) {
      setSession({ ...active, note: noteName });
    }
    previousDocument.current = documentSession;
  }, [noteName, documentSession, cancel]);
  useEffect(
    () =>
      api?.onScrollChange(() => {
        if (
          !sessionRef.current &&
          !api
            .getSceneElements()
            .some(
              (element) =>
                isWidgetElement(element) &&
                api.getAppState().selectedElementIds[element.id],
            )
        ) {
          return;
        }
        const state = api.getAppState();
        const key = [
          state.scrollX,
          state.scrollY,
          state.zoom.value,
          state.width,
          state.height,
          state.offsetLeft,
          state.offsetTop,
        ].join(":");
        if (viewportKey.current !== key) {
          viewportKey.current = key;
          setViewport((value) => value + 1);
        }
      }),
    [api],
  );
  useEffect(() => {
    if (!api || !ownerWindow) {
      return;
    }
    const unsubscribe = api.onChange((elements, appState) => {
      currentElements.current = elements;
      const camera = [
        appState.scrollX,
        appState.scrollY,
        appState.zoom.value,
        appState.width,
        appState.height,
        appState.offsetLeft,
        appState.offsetTop,
      ].join(":");
      if (
        viewportKey.current !== camera &&
        (sessionRef.current ||
          elements.some(
            (element) =>
              isWidgetElement(element) &&
              appState.selectedElementIds[element.id],
          ))
      ) {
        viewportKey.current = camera;
        setViewport((value) => value + 1);
      }
      const target = elements.find(
        (el) =>
          !el.isDeleted &&
          appState.selectedElementIds[el.id] &&
          isWidgetElement(el),
      );
      const active = sessionRef.current;
      if (
        active?.target &&
        !elements.some(
          (element) => element.id === active.target && !element.isDeleted,
        )
      ) {
        controller.current?.abort();
        controller.current = null;
        setPhase("");
        setError(
          "目标组件已删除。草稿仍保留，请恢复目标后应用，或重新创建组件。",
        );
      }
      setSelected((previous) =>
        target
          ? previous === target
            ? previous
            : (target as NonDeleted<ExcalidrawEmbeddableElement>)
          : null,
      );
      for (const el of elements) {
        if (!isWidgetElement(el) || el.isDeleted) {
          continue;
        }
        const doc = readWidget(el.customData?.aiWidget);
        if (!doc) {
          continue;
        }
        runtimeFor(el.id, doc);
        const key = [el.width, el.height, JSON.stringify(doc)].join(":");
        if (cachedGeometry.current.get(el.id) === key) {
          continue;
        }
        cachedGeometry.current.set(el.id, key);
        const width = el.width;
        const height = el.height;
        ownerWindow.clearTimeout(snapshotTimers.current.get(el.id));
        // Resizing updates the export cache once after the pointer settles.
        const timer = ownerWindow.setTimeout(() => {
          snapshotTimers.current.delete(el.id);
          const live = api.getSceneElements().find((e) => e.id === el.id);
          if (
            !live ||
            live.width !== width ||
            live.height !== height ||
            JSON.stringify(live.customData?.aiWidget) !== JSON.stringify(doc)
          ) {
            return;
          }
          try {
            const snapshot = renderSnapshot(
              doc,
              Math.max(120, live.width),
              Math.max(80, live.height),
              scrolls.current.get(el.id) || 0,
              tableScrolls.current.get(el.id),
            );
            cacheEmbeddableSnapshot(live, snapshot);
          } catch {
            /* Corrupt/invalid values remain visible for repair. */
          }
        }, 200);
        snapshotTimers.current.set(el.id, timer);
      }
    });
    const timers = snapshotTimers.current;
    return () => {
      unsubscribe();
      for (const timer of timers.values()) {
        ownerWindow.clearTimeout(timer);
      }
      timers.clear();
    };
  }, [api, ownerWindow, runtimeFor]);
  useEffect(() => {
    if (!api || !ownerWindow) {
      return;
    }
    let cleanRegion: (() => void) | null = null;
    const unsubscribe = api.onPointerDown((tool, pointer, event) => {
      if (tool.type !== "custom" || tool.customType !== "ai-widget") {
        return;
      }
      cleanRegion?.();
      const origin = viewportCoordsToSceneCoords(event, api.getAppState());
      let end = origin;
      const selection = newElement({
        type: "selection",
        x: origin.x,
        y: origin.y,
        width: 0,
        height: 0,
      });
      const move = (ev: PointerEvent) => {
        end = viewportCoordsToSceneCoords(ev, api.getAppState());
        api.updateScene({
          appState: {
            selectionElement: {
              ...selection,
              x: Math.min(origin.x, end.x),
              y: Math.min(origin.y, end.y),
              width: Math.abs(origin.x - end.x),
              height: Math.abs(origin.y - end.y),
            },
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      };
      const cleanup = () => {
        ownerWindow.removeEventListener("pointermove", move);
        ownerWindow.removeEventListener("pointerup", up);
        ownerWindow.removeEventListener("pointercancel", abort);
        ownerWindow.removeEventListener("keydown", key);
        cleanRegion = null;
      };
      const abort = () => {
        cleanup();
        api.updateScene({
          appState: { selectionElement: null },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        api.setActiveTool({ type: "selection" });
      };
      const key = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          abort();
        }
      };
      const up = (ev: PointerEvent) => {
        move(ev);
        cleanup();
        api.updateScene({
          appState: { selectionElement: null },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        api.setActiveTool({ type: "selection" });
        const width = Math.abs(end.x - origin.x);
        const height = Math.abs(end.y - origin.y);
        if (width < 20 || height < 20) {
          return;
        }
        cancel();
        setSession({
          region: {
            x: Math.min(origin.x, end.x),
            y: Math.min(origin.y, end.y),
            width,
            height,
          },
          note: currentNote.current,
        });
        setPrompt("");
        setContext([]);
        setPreview(null);
        setError("");
        setExplanation("");
        setCandidates([]);
        setCandidateIndex(-1);
        setCollapsed(false);
        setShowOriginal(false);
        draftKey.current = null;
      };
      cleanRegion = cleanup;
      ownerWindow.addEventListener("pointermove", move);
      ownerWindow.addEventListener("pointerup", up);
      ownerWindow.addEventListener("pointercancel", abort);
      ownerWindow.addEventListener("keydown", key);
    });
    return () => {
      cleanRegion?.();
      unsubscribe();
    };
  }, [api, ownerWindow, cancel]);

  const commitState = useCallback(
    (id: string, state: WidgetState) => {
      if (!api) {
        return;
      }
      const elements = api.getSceneElementsIncludingDeleted();
      const el = elements.find((e) => e.id === id && !e.isDeleted);
      const old = readWidget(el?.customData?.aiWidget);
      if (!el || !old || JSON.stringify(state) === JSON.stringify(old.state)) {
        dirty.current.delete(id);
        return;
      }
      const document: WidgetDocument = {
        ...old,
        state: structuredClone(state),
      };
      const metadata = widgetMetadata(
        document,
        Math.max(120, el.width),
        Math.max(80, el.height),
        scrolls.current.get(id) || 0,
      );
      dirty.current.delete(id);
      api.updateScene({
        elements: elements.map((e) =>
          e.id === id
            ? newElementWith(e, {
                customData: { ...e.customData, ...metadata },
              })
            : e,
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
    [api],
  );

  const applyPreview = useCallback(
    (document: WidgetDocument) => {
      const active = sessionRef.current;
      if (!api || !active || active.note !== currentNote.current) {
        setError("目标笔记已变化，请重新生成。");
        return;
      }
      const elements = api.getSceneElementsIncludingDeleted();
      const old = active.target
        ? elements.find((e) => e.id === active.target && !e.isDeleted)
        : null;
      const oldDocument = readWidget(old?.customData?.aiWidget);
      if (
        active.target &&
        (!old ||
          JSON.stringify(oldDocument?.definition) !==
            JSON.stringify(active.definition))
      ) {
        setError("组件定义已变化，请重新生成后应用。");
        return;
      }
      const reconciled = reconcileState(
        oldDocument && active.target
          ? {
              ...oldDocument,
              state:
                runtimes.current.get(active.target)?.runtime.state ||
                oldDocument.state,
            }
          : oldDocument,
        document.definition,
      );
      const next: WidgetDocument = {
        ...document,
        version: 2,
        catalogVersion: 2,
        definition: { ...document.definition, version: 2 },
        state:
          oldDocument && !applyTrialInputs ? reconciled.state : document.state,
      };
      const region = active.region;
      let metadata: ReturnType<typeof widgetMetadata>;
      try {
        metadata = widgetMetadata(next, region.width, region.height);
      } catch (error) {
        setError(`候选无法应用：${(error as Error).message}`);
        return;
      }
      if (old) {
        api.updateScene({
          elements: elements.map((e) =>
            e.id === old.id
              ? newElementWith(e, {
                  width: region.width,
                  height: region.height,
                  customData: { ...e.customData, ...metadata },
                })
              : e,
          ),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      } else {
        const element = newEmbeddableElement({
          type: "embeddable",
          ...active.region,
          strokeColor: "#6366f1",
          backgroundColor: "#f8f8fc",
          strokeWidth: 1,
          roughness: 0,
          customData: metadata,
        });
        const withLink = newElementWith(element, {
          link: WIDGET_LINK_PREFIX + element.id,
        });
        api.updateScene({
          elements: [...elements, withLink],
          appState: { selectedElementIds: { [element.id]: true } },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      }
      if (reconciled.reset.length) {
        api.setToast({
          message: `已重置不兼容输入: ${reconciled.reset.join("、")}`,
        });
      }
      setSession(null);
      setPreview(null);
      setContext([]);
      setError("");
      pendingDraft.current = null;
      if (draftStorage.current && draftKey.current) {
        void removeWidgetDraft(draftStorage.current, draftKey.current).catch(
          () => {},
        );
      }
      draftKey.current = null;
    },
    [api, applyTrialInputs],
  );
  const generate = async () => {
    const active = sessionRef.current;
    if (!active || !ownerWindow || !prompt.trim()) {
      return;
    }
    cancel();
    const abort = new (
      ownerWindow as Window & typeof globalThis
    ).AbortController();
    controller.current = abort;
    setError("");
    setPhase("正在检查连接…");
    try {
      const check = await ownerWindow.fetch("/api/ai/status", {
        signal: abort.signal,
      });
      const status = await check.json();
      setModel(status);
      if (!status.available) {
        throw new Error(
          "Qwen 暂时无法连接，请检查私网或转发配置。已有组件仍可使用。",
        );
      }
      setPhase("Qwen 正在生成组件…");
      const live = active.target
        ? api?.getSceneElements().find((e) => e.id === active.target)
        : null;
      const old = preview || readWidget(live?.customData?.aiWidget);
      const response = await ownerWindow.fetch("/api/ai/widgets/generate", {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          context: context.map((c) => ({ label: c.label, content: c.content })),
          currentDefinition: old?.definition,
          currentState: old?.state,
          region: { width: active.region.width, height: active.region.height },
          initialIntent: candidates[0]?.prompt || prompt,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "生成失败");
      }
      if (
        controller.current !== abort ||
        !sessionRef.current ||
        sessionRef.current.target !== active.target
      ) {
        return;
      }
      setPhase("正在校验与准备预览…");
      const returnedDefinition = validateDefinition(result.definition);
      const definition: WidgetDefinition =
        returnedDefinition.version === 1
          ? { ...returnedDefinition, version: 2 }
          : returnedDefinition;
      const latest =
        previewRef.current ||
        readWidget(
          api
            ?.getSceneElements()
            .find((element) => element.id === active.target)?.customData
            ?.aiWidget,
        );
      const latestState = runtimes.current.get(
        previewRef.current ? "creative-preview" : active.target || "",
      )?.runtime.state;
      const reconciled = reconcileState(
        latest && latestState ? { ...latest, state: latestState } : latest,
        definition,
      );
      const doc: WidgetDocument = {
        version: definition.version,
        catalogVersion: definition.version,
        definition,
        state: reconciled.state,
        prompt,
      };
      rememberCandidate(doc);
      setExplanation(
        result.explanation +
          (reconciled.reset.length
            ? ` 将重置: ${reconciled.reset.join("、")}`
            : ""),
      );
    } catch (e) {
      if (!abort.signal.aborted) {
        setError((e as Error).message);
      }
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setPhase("");
      }
    }
  };
  const edit = (element = selected) => {
    if (!element) {
      return;
    }
    cancel();
    const doc = readWidget(element.customData?.aiWidget);
    setSession({
      target: element.id,
      definition: doc?.definition,
      region: {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      },
      note: noteName,
    });
    setPrompt("");
    setContext([]);
    setPreview(null);
    setError("");
    setExplanation("");
    setCandidates([]);
    setCandidateIndex(-1);
    setCollapsed(false);
    setShowOriginal(false);
    setApplyTrialInputs(false);
    draftKey.current = null;
  };
  const addContext = () => {
    if (!api) {
      return;
    }
    const ids = api.getAppState().selectedElementIds;
    const selectedElements = api
      .getSceneElements()
      .filter((el) => ids[el.id] && !isWidgetElement(el));
    const texts = selectedElements.filter((el) => el.type === "text");
    const added = texts.map((el) => ({
      id: el.id,
      label: el.type === "text" ? el.text.slice(0, 32) : el.id,
      content: el.type === "text" ? el.text : "",
    }));
    setContext((old) =>
      [...old, ...added.filter((a) => !old.some((c) => c.id === a.id))].slice(
        0,
        50,
      ),
    );
    if (!added.length) {
      setError("请在画布上选择文字、矩阵或包含文字的元素组，再添加上下文。");
    }
  };
  const expandHeight = () => {
    if (!selected || !api) {
      return;
    }
    const doc = readWidget(selected.customData?.aiWidget);
    if (!doc) {
      return;
    }
    const { tree } = computeWidget(doc.definition, doc.state);
    const height = Math.min(20000, layoutWidget(tree, selected.width).height);
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((e) =>
        e.id === selected.id
          ? newElementWith(e, {
              height,
              customData: widgetMetadata(doc, selected.width, height),
            })
          : e,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };
  const renderEmbeddable = useCallback(
    (element: NonDeleted<ExcalidrawEmbeddableElement>) => {
      if (!isWidgetElement(element)) {
        return null;
      }
      return (
        <WidgetEmbed
          element={element}
          api={api}
          onCommit={commitState}
          runtimeFor={runtimeFor}
          onDraft={(id, value) => {
            if (value) {
              dirty.current.add(id);
            } else {
              dirty.current.delete(id);
            }
          }}
          onHeight={(id, height) => {
            shapeHeight.current.set(id, height);
            const live = api
              ?.getSceneElements()
              .find((element) => element.id === id);
            const document = readWidget(live?.customData?.aiWidget);
            if (live && document) {
              try {
                cacheEmbeddableSnapshot(
                  live,
                  renderSnapshot(
                    document,
                    Math.max(120, live.width),
                    Math.max(80, live.height),
                    scrolls.current.get(id) || 0,
                    tableScrolls.current.get(id),
                  ),
                );
              } catch {
                /* Keep the last valid snapshot. */
              }
            }
          }}
          onScroll={(id, value, regions) => {
            scrolls.current.set(id, value);
            tableScrolls.current.set(id, regions);
            const live = api?.getSceneElements().find((el) => el.id === id);
            const doc = readWidget(live?.customData?.aiWidget);
            if (live && doc) {
              try {
                cacheEmbeddableSnapshot(
                  live,
                  renderSnapshot(
                    doc,
                    Math.max(120, live.width),
                    Math.max(80, live.height),
                    value,
                    regions,
                  ),
                );
              } catch {
                /* Keep the last valid static view. */
              }
            }
          }}
          onExit={exit}
          registerDraft={(flush) => {
            commitDrafts.current.set(element.id, flush);
            return () => {
              commitDrafts.current.delete(element.id);
            };
          }}
        />
      );
    },
    [api, commitState, exit, runtimeFor],
  );
  const expandedElement = expanded
    ? api?.getSceneElements().find((e) => e.id === expanded)
    : null;
  const expandedDocument = readWidget(expandedElement?.customData?.aiWidget);
  // Coordinates are relative to the Excalidraw root, never a guessed zoom scale.
  void viewport;
  const bounds = (region: Region) => {
    const state = api?.getAppState();
    if (!state) {
      return null;
    }
    const point = sceneCoordsToViewportCoords(
      { sceneX: region.x, sceneY: region.y },
      state,
    );
    return {
      left: point.x - state.offsetLeft,
      top: point.y - state.offsetTop,
      width: region.width * state.zoom.value,
      height: region.height * state.zoom.value,
      zoom: state.zoom.value,
    };
  };
  const original = session?.target
    ? readWidget(
        api?.getSceneElements().find((element) => element.id === session.target)
          ?.customData?.aiWidget,
      )
    : null;
  return {
    captureChatSnapshot: () => ({
      capturedAt: Date.now(),
      elements: (api?.getSceneElements() || []).map((element) => {
        const copy = structuredClone(element);
        const runtime = runtimes.current.get(element.id);
        if (runtime && copy.customData?.aiWidget) {
          copy.customData.aiWidget = {
            ...copy.customData.aiWidget,
            state: structuredClone(runtime.runtime.state),
          };
        }
        // Files and preview candidates are deliberately not part of this snapshot.
        const value = copy as unknown as Record<string, unknown>;
        return {
          ...Object.fromEntries(
            [
              "id",
              "type",
              "x",
              "y",
              "width",
              "height",
              "text",
              "originalText",
              "groupIds",
              "matrix",
            ]
              .filter((key) => Object.hasOwn(value, key))
              .map((key) => [key, value[key]]),
          ),
          customData: copy.customData?.aiWidget
            ? { aiWidget: copy.customData.aiWidget }
            : undefined,
        };
      }),
    }),
    session,
    prompt,
    setPrompt,
    context,
    removeContext: (id: string) =>
      setContext((c) => c.filter((item) => item.id !== id)),
    addContext,
    preview,
    setPreview,
    phase,
    error,
    explanation,
    model,
    collapsed,
    setCollapsed,
    showOriginal,
    setShowOriginal,
    applyTrialInputs,
    setApplyTrialInputs,
    candidates,
    candidateIndex,
    previousCandidate: () => {
      const index = candidateIndex - 1;
      if (index >= 0) {
        setCandidateIndex(index);
        setPreview(candidates[index]);
        setShowOriginal(false);
      }
    },
    resetList:
      original && preview
        ? reconcileState(original, preview.definition).reset
        : [],
    original,
    regionBounds: session ? bounds(session.region) : null,
    selectedBounds: selected ? bounds(selected) : null,
    viewportSize: {
      width: api?.getAppState().width || 1000,
      height: api?.getAppState().height || 800,
    },
    storageError,
    recovery,
    recover: (draft: WidgetDraft) => {
      cancel();
      draftKey.current = draft.key;
      setSession(draft.session);
      setPrompt(draft.prompt);
      setContext(draft.context);
      setCandidates(draft.candidates);
      setCandidateIndex(draft.candidateIndex);
      setPreview(draft.candidates[draft.candidateIndex] || null);
      setCollapsed(false);
      setRecovery([]);
    },
    expandPreview: (height: number) => {
      if (session) {
        setSession({
          ...session,
          region: {
            ...session.region,
            height: Math.min(20000, Math.max(session.region.height, height)),
          },
        });
      }
    },
    generate,
    applyPreview,
    close,
    cancel,
    selected,
    edit,
    hasTransientEdits,
    renderEmbeddable,
    expandHeight,
    exit,
    setExpanded,
    expanded,
    expandedDocument,
    expandedRuntime:
      expanded && expandedDocument
        ? runtimeFor(expanded, expandedDocument)
        : undefined,
    previewRuntime: preview
      ? runtimeFor("creative-preview", preview)
      : undefined,
    expandedDraft: (value: boolean) => {
      if (expanded) {
        if (value) {
          dirty.current.add(expanded);
        } else {
          dirty.current.delete(expanded);
        }
      }
    },
    registerExpandedDraft: (flush: () => void) => {
      const key = `expanded:${expanded}`;
      commitDrafts.current.set(key, flush);
      return () => {
        commitDrafts.current.delete(key);
      };
    },
    expandedCommit: (state: WidgetState) => {
      if (expanded) {
        commitState(expanded, state);
      }
    },
    startRegion: () =>
      api?.setActiveTool({ type: "custom", customType: "ai-widget" }),
    enter: () => {
      if (selected) {
        api?.updateScene({
          appState: {
            activeEmbeddable: { element: selected, state: "active" },
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    },
    resetSelected: () => {
      if (!selected) {
        return;
      }
      const doc = readWidget(selected.customData?.aiWidget);
      if (doc) {
        commitState(selected.id, structuredClone(doc.definition.initialState));
      }
    },
    loadExample: (definition: WidgetDefinition) => {
      cancel();
      validateDefinition(definition);
      rememberCandidate({
        version: 2,
        catalogVersion: 2,
        definition: { ...definition, version: 2 },
        state: structuredClone(definition.initialState),
        prompt: `本地示例: ${definition.title}`,
      });
      setExplanation("本地示例可离线试用，生成自定义组件时使用 Qwen。");
    },
    flushDrafts: () => {
      for (const flush of commitDrafts.current.values()) {
        flush();
      }
    },
    discardDrafts: () => {
      dirty.current.clear();
      setExpanded(null);
      close();
      exit();
      api?.refresh();
    },
  };
};

const WidgetEmbed = ({
  element,
  onCommit,
  onDraft,
  onHeight,
  onScroll,
  onExit,
  registerDraft,
  runtimeFor,
}: {
  element: ExcalidrawEmbeddableElement;
  api: ExcalidrawImperativeAPI | null;
  onCommit: (id: string, state: WidgetState) => void;
  onDraft: (id: string, value: boolean) => void;
  onHeight: (id: string, height: number) => void;
  onScroll: (id: string, scroll: number, regions: WidgetScrollState) => void;
  onExit: () => void;
  registerDraft: (flush: () => void) => () => void;
  runtimeFor: (id: string, document: WidgetDocument) => WidgetRuntimeState;
}) => {
  const doc = readWidget(element.customData?.aiWidget);
  if (!doc) {
    return (
      <div className="iw-view" role="alert">
        组件版本暂不支持或定义损坏。原始内容已保留，可通过 AI 重新生成。
      </div>
    );
  }
  return (
    <WidgetView
      document={doc}
      runtime={runtimeFor(element.id, doc)}
      width={Math.max(120, element.width)}
      onCommit={(state) => onCommit(element.id, state)}
      onDraft={(value) => onDraft(element.id, value)}
      onLayout={(height) => onHeight(element.id, height)}
      onScroll={(scroll, regions) => onScroll(element.id, scroll, regions)}
      onExit={onExit}
      registerDraft={registerDraft}
    />
  );
};

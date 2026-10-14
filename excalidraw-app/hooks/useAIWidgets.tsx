import { useCallback, useEffect, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { cacheEmbeddableSnapshot } from "@excalidraw/excalidraw/scene/embeddableSnapshots";
import {
  newElement,
  newElementWith,
  newEmbeddableElement,
} from "@excalidraw/element";
import { viewportCoordsToSceneCoords } from "@excalidraw/common";

import type {
  ExcalidrawElement,
  ExcalidrawEmbeddableElement,
  NonDeleted,
} from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { computeWidget } from "../../packages/interactive-widgets/compute";
import { layoutWidget } from "../../packages/interactive-widgets/layout";
import {
  readWidget,
  reconcileState,
  validateDefinition,
} from "../../packages/interactive-widgets/schema";
import { renderSnapshot } from "../../packages/interactive-widgets/snapshot";
import { WidgetView } from "../../packages/interactive-widgets/WidgetView";
import { WIDGET_LINK_PREFIX } from "../../packages/interactive-widgets/types";

import type {
  WidgetDefinition,
  WidgetDocument,
  WidgetState,
} from "../../packages/interactive-widgets/types";

type Region = { x: number; y: number; width: number; height: number };
type ContextItem = { id: string; label: string; content: string };
type Session = {
  region: Region;
  note: string | null;
  target?: string;
  definition?: WidgetDefinition;
};
const SETTINGS_KEY = "aldebaran.ai-widgets.confirm";
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
    interaction: "doubleClick",
    snapshot: renderSnapshot(doc, width, height, scroll),
    snapshotWidth: width,
    snapshotHeight: height,
  },
});

export const useAIWidgets = ({
  api,
  ownerWindow,
  noteName,
}: {
  api: ExcalidrawImperativeAPI | null;
  ownerWindow: Window | null;
  noteName: string | null;
}) => {
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [prompt, setPrompt] = useState("");
  const [context, setContext] = useState<ContextItem[]>([]);
  const [preview, setPreview] = useState<WidgetDocument | null>(null);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [explanation, setExplanation] = useState("");
  const [model, setModel] = useState<{
    available: boolean;
    model: string;
  } | null>(null);
  const [confirmChanges, setConfirmChanges] = useState(true);
  const [selected, setSelected] =
    useState<NonDeleted<ExcalidrawEmbeddableElement> | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const dirty = useRef(new Set<string>());
  const scrolls = useRef(new Map<string, number>());
  const currentNote = useRef(noteName);
  currentNote.current = noteName;
  const shapeHeight = useRef(new Map<string, number>());
  const cachedGeometry = useRef(new Map<string, string>());
  const currentElements = useRef<readonly ExcalidrawElement[]>([]);
  const commitDrafts = useRef(new Map<string, () => void>());
  const snapshotTimers = useRef(new Map<string, number>());
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
    try {
      setConfirmChanges(
        ownerWindow?.localStorage.getItem(SETTINGS_KEY) !== "false",
      );
    } catch {
      /* In-memory setting works without storage. */
    }
  }, [ownerWindow]);
  const changeConfirmation = (value: boolean) => {
    setConfirmChanges(value);
    try {
      ownerWindow?.localStorage.setItem(SETTINGS_KEY, String(value));
    } catch {
      /* optional persistence */
    }
  };
  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setPhase("");
  }, []);
  const close = useCallback(() => {
    cancel();
    setSession(null);
    setPreview(null);
    setError("");
    setContext([]);
  }, [cancel]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const active = sessionRef.current;
    if (active && active.note !== noteName) {
      cancel();
      setError("笔记已切换，旧生成结果不会应用到这篇笔记。");
      setPreview(null);
    }
  }, [noteName, cancel]);
  useEffect(() => {
    if (!api || !ownerWindow) {
      return;
    }
    const unsubscribe = api.onChange((elements, appState) => {
      currentElements.current = elements;
      const target = elements.find(
        (el) =>
          !el.isDeleted &&
          appState.selectedElementIds[el.id] &&
          isWidgetElement(el),
      );
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
  }, [api, ownerWindow]);
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
        setSession({
          region: {
            x: Math.min(origin.x, end.x),
            y: Math.min(origin.y, end.y),
            width: Math.max(240, width),
            height: Math.max(160, height),
          },
          note: currentNote.current,
        });
        setPrompt("");
        setContext([]);
        setPreview(null);
        setError("");
        setExplanation("");
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
  }, [api, ownerWindow]);

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
      const reconciled = reconcileState(oldDocument, document.definition);
      const next: WidgetDocument = {
        ...document,
        state: oldDocument ? reconciled.state : document.state,
      };
      const region = old || active.region;
      const metadata = widgetMetadata(next, region.width, region.height);
      if (old) {
        api.updateScene({
          elements: elements.map((e) =>
            e.id === old.id
              ? newElementWith(e, {
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
    },
    [api],
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
      const old = readWidget(live?.customData?.aiWidget);
      const response = await ownerWindow.fetch("/api/ai/widgets/generate", {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          context: context.map((c) => ({ label: c.label, content: c.content })),
          currentDefinition: old?.definition,
          currentState: old?.state,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "生成失败");
      }
      if (
        controller.current !== abort ||
        sessionRef.current !== active ||
        active.note !== currentNote.current
      ) {
        return;
      }
      setPhase("正在校验与准备预览…");
      const definition = validateDefinition(result.definition);
      const reconciled = reconcileState(old, definition);
      const doc: WidgetDocument = {
        version: 1,
        catalogVersion: 1,
        definition,
        state: reconciled.state,
        prompt,
      };
      setPreview(doc);
      setExplanation(
        result.explanation +
          (reconciled.reset.length
            ? ` 将重置: ${reconciled.reset.join("、")}`
            : ""),
      );
      if (active.target && !confirmChanges) {
        applyPreview(doc);
      }
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
    const doc = readWidget(element.customData?.aiWidget);
    setSession({
      target: element.id,
      definition: doc?.definition,
      region: element,
      note: noteName,
    });
    setPrompt("");
    setContext([]);
    setPreview(null);
    setError("");
    setExplanation("");
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
          onDraft={(id, value) => {
            if (value) {
              dirty.current.add(id);
            } else {
              dirty.current.delete(id);
            }
          }}
          onHeight={(id, height) => shapeHeight.current.set(id, height)}
          onScroll={(id, value) => {
            scrolls.current.set(id, value);
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
    [api, commitState, exit],
  );
  const expandedElement = expanded
    ? api?.getSceneElements().find((e) => e.id === expanded)
    : null;
  const expandedDocument = readWidget(expandedElement?.customData?.aiWidget);
  return {
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
    confirmChanges,
    changeConfirmation,
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
      validateDefinition(definition);
      setPreview({
        version: 1,
        catalogVersion: 1,
        definition,
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
}: {
  element: ExcalidrawEmbeddableElement;
  api: ExcalidrawImperativeAPI | null;
  onCommit: (id: string, state: WidgetState) => void;
  onDraft: (id: string, value: boolean) => void;
  onHeight: (id: string, height: number) => void;
  onScroll: (id: string, scroll: number) => void;
  onExit: () => void;
  registerDraft: (flush: () => void) => () => void;
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
      width={Math.max(120, element.width)}
      onCommit={(state) => onCommit(element.id, state)}
      onDraft={(value) => onDraft(element.id, value)}
      onLayout={(height) => onHeight(element.id, height)}
      onScroll={(scroll) => onScroll(element.id, scroll)}
      onExit={onExit}
      registerDraft={registerDraft}
    />
  );
};

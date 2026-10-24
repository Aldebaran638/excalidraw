import { useCallback, useEffect, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import {
  newElement,
  newElementWith,
  newEmbeddableElement,
} from "@excalidraw/element";
import {
  viewportCoordsToSceneCoords,
  sceneCoordsToViewportCoords,
} from "@excalidraw/common";
import {
  cacheEmbeddableSnapshot,
  registerEmbeddableCapture,
} from "@excalidraw/excalidraw/scene/embeddableSnapshots";

import type {
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";

import type { ExcalidrawEmbeddableElement } from "@excalidraw/element/types";

import { readCanvasHtmlApp } from "../data/chatHtml";
import { forkHtmlApps } from "../data/htmlApps";
import { HtmlAppView } from "../components/HtmlAppView";

import type { HtmlAppRuntime } from "../components/HtmlAppView";
import type { CanvasHtmlApp, HtmlArtifact, HtmlState } from "../data/chatHtml";

export const HTML_APP_LINK = "https://apps.excalidraw.local/";
export type HtmlRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type HtmlChatHost = {
  elements: () => { id: string; title: string }[];
  read: (id: string) => CanvasHtmlApp | null;
  place: (
    data: HtmlArtifact,
    state: HtmlState,
    isCurrent: () => boolean,
    done: (id: string) => void,
  ) => Promise<void>;
  apply: (
    data: HtmlArtifact,
    state: HtmlState,
    trial: boolean,
  ) => Promise<void>;
};
export const useCanvasHtmlApps = ({
  api,
  ownerWindow,
  noteId,
  documentSession,
  onCreate,
  onEdit,
  flush,
}: {
  api: ExcalidrawImperativeAPI | null;
  ownerWindow: Window | null;
  noteId: string | null;
  documentSession: number;
  onCreate: () => void;
  onEdit: (id: string) => void;
  flush: () => Promise<unknown>;
}) => {
  const context = useRef({ noteId, documentSession });
  context.current = { noteId, documentSession };
  const callbacks = useRef({ onCreate, onEdit });
  callbacks.current = { onCreate, onEdit };
  const runtimes = useRef(new Map<string, HtmlAppRuntime>());
  const [selection, setSelection] =
    useState<ExcalidrawEmbeddableElement | null>(null);
  const [region, setRegion] = useState<HtmlRegion | null>(null);
  const [, refreshViewport] = useState(0);
  const regionRef = useRef(region);
  regionRef.current = region;
  useEffect(
    () =>
      api?.onScrollChange(() => {
        if (regionRef.current) {
          refreshViewport((value) => value + 1);
        }
      }),
    [api],
  );
  const [placing, setPlacing] = useState(false);
  const pending = useRef<{
    app: CanvasHtmlApp;
    valid: () => boolean;
    done: (id: string) => void;
  } | null>(null);
  const task = useRef(0);
  useEffect(() => {
    task.current++;
    pending.current = null;
    setPlacing(false);
    setRegion(null);
  }, [documentSession]);
  useEffect(
    () =>
      api?.onChange((elements, state) => {
        const element = elements.find(
          (e) =>
            !e.isDeleted &&
            state.selectedElementIds[e.id] &&
            readCanvasHtmlApp(e.customData?.htmlApp),
        );
        setSelection(element ? (element as ExcalidrawEmbeddableElement) : null);
      }),
    [api],
  );
  const json = useCallback(
    async (url: string, body?: unknown) => {
      if (!ownerWindow) {
        throw new Error("应用尚未就绪");
      }
      const response = await ownerWindow.fetch(
        url,
        body
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : undefined,
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "源码操作失败");
      }
      return data as HtmlArtifact;
    },
    [ownerWindow],
  );
  const metadata = (app: CanvasHtmlApp) => ({
    htmlApp: app,
    embeddable: {
      snapshotRequired: true,
      keepAlive: true,
      contentLocked: true,
      interaction: "controls",
      snapshot:
        '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="480"><text x="20" y="40">HTML application</text></svg>',
    },
  });
  const commit = useCallback(
    (app: CanvasHtmlApp, bounds: HtmlRegion, target?: string) => {
      if (!api) {
        throw new Error("画布未就绪");
      }
      const elements = api.getSceneElementsIncludingDeleted();
      const old = target
        ? elements.find((e) => !e.isDeleted && e.id === target)
        : undefined;
      if (target && !old) {
        throw new Error("目标已删除");
      }
      const element = old
        ? newElementWith(old, {
            customData: { ...old.customData, ...metadata(app) },
          })
        : newEmbeddableElement({
            type: "embeddable",
            ...bounds,
            strokeColor: "#6965db",
            backgroundColor: "transparent",
            customData: metadata(app),
          });
      const next = newElementWith(element, {
        link: HTML_APP_LINK + element.id,
      });
      api.updateScene({
        elements: old
          ? elements.map((e) => (e.id === old.id ? next : e))
          : [...elements, next],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return next.id;
    },
    [api],
  );
  const packageFor = (data: HtmlArtifact, state: HtmlState): CanvasHtmlApp => ({
    formatVersion: 1,
    appId: data.artifactId,
    version: data.version,
    sourceHash: data.sourceHash!,
    sourceSnapshot: data.source,
    title: data.title,
    runtimeVersion: data.runtimeVersion || 2,
    state: structuredClone(state),
  });
  const host: HtmlChatHost = {
    elements: () =>
      (api?.getSceneElements() || []).flatMap((e) => {
        const app = readCanvasHtmlApp(e.customData?.htmlApp);
        return app
          ? [
              {
                id: e.id,
                title: app.title,
                appId: app.appId,
                version: app.version,
                sourceHash: app.sourceHash,
              },
            ]
          : [];
      }),
    read: (id) => {
      const app = readCanvasHtmlApp(
        api?.getSceneElements().find((e) => e.id === id)?.customData?.htmlApp,
      );
      return app
        ? { ...app, state: runtimes.current.get(id)?.state() || app.state }
        : null;
    },
    place: async (data, state, valid, done) => {
      const own = context.current;
      const sequence = ++task.current;
      if (!own.noteId || !api) {
        throw new Error("请先保存当前笔记");
      }
      const value = await json(`/api/notes/${own.noteId}/apps`, {
        source: data.source,
        title: data.title,
        state,
      });
      if (
        !valid() ||
        own.documentSession !== context.current.documentSession ||
        sequence !== task.current
      ) {
        throw new Error("笔记或导入操作已切换，未放置组件");
      }
      const app = packageFor(value, state);
      if (regionRef.current) {
        done(commit(app, regionRef.current));
        setRegion(null);
      } else {
        pending.current = { app, valid, done };
        setPlacing(true);
        api.setActiveTool({ type: "custom", customType: "html-app-place" });
        api.setToast({ message: "拖框放置 HTML 应用，Esc 取消" });
      }
    },
    apply: async (data, state, trial) => {
      const own = context.current;
      const target = data.target;
      if (!own.noteId || !api || !target) {
        throw new Error("没有修改目标");
      }
      const readTarget = () => {
        const element = api
          .getSceneElements()
          .find((e) => e.id === target.elementId);
        const app = readCanvasHtmlApp(element?.customData?.htmlApp);
        if (
          !element ||
          !app ||
          app.appId !== target.appId ||
          app.version !== target.version ||
          app.sourceHash !== target.sourceHash
        ) {
          throw new Error("目标已删除或源码已改变，请重新引用后修改");
        }
        return { element, app };
      };
      readTarget();
      await flush();
      readTarget();
      if (own.documentSession !== context.current.documentSession) {
        throw new Error("笔记已切换");
      }
      const value = await json(`/api/notes/${own.noteId}/apps`, {
        source: data.source,
        title: data.title,
        state,
        target,
      });
      if (
        own.noteId !== context.current.noteId ||
        own.documentSession !== context.current.documentSession
      ) {
        throw new Error("笔记已切换，未应用修改");
      }
      const { element, app } = readTarget();
      commit(
        packageFor(
          value,
          trial
            ? state
            : runtimes.current.get(element.id)?.state() || app.state,
        ),
        element,
        element.id,
      );
    },
  };
  useEffect(() => {
    if (!api || !ownerWindow) {
      return;
    }
    let cleanup: (() => void) | undefined;
    const cancel = () => {
      pending.current = null;
      setPlacing(false);
      setRegion(null);
      task.current++;
      cleanup?.();
      api.updateScene({
        appState: { selectionElement: null },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      api.setActiveTool({ type: "selection" });
    };
    const unsub = api.onPointerDown((tool, _pointer, event) => {
      if (
        tool.type !== "custom" ||
        !["ai-widget", "html-app-place"].includes(tool.customType)
      ) {
        return;
      }
      cleanup?.();
      const own = context.current;
      const importing = pending.current;
      const start = viewportCoordsToSceneCoords(event, api.getAppState());
      let end = start;
      const ghost = newElement({
        type: "selection",
        x: start.x,
        y: start.y,
        width: 0,
        height: 0,
      });
      const move = (ev: PointerEvent) => {
        end = viewportCoordsToSceneCoords(ev, api.getAppState());
        api.updateScene({
          appState: {
            selectionElement: {
              ...ghost,
              x: Math.min(start.x, end.x),
              y: Math.min(start.y, end.y),
              width: Math.abs(end.x - start.x),
              height: Math.abs(end.y - start.y),
            },
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      };
      const key = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          cancel();
        }
      };
      const up = (ev: PointerEvent) => {
        move(ev);
        cleanup?.();
        api.updateScene({
          appState: { selectionElement: null },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        api.setActiveTool({ type: "selection" });
        if (own.documentSession !== context.current.documentSession) {
          return;
        }
        const bounds = {
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        };
        if (bounds.width < 20 || bounds.height < 20) {
          return;
        }
        if (importing) {
          pending.current = null;
          setPlacing(false);
          if (importing.valid()) {
            importing.done(commit(importing.app, bounds));
          }
        } else {
          setRegion(bounds);
          callbacks.current.onCreate();
        }
      };
      cleanup = () => {
        ownerWindow.removeEventListener("pointermove", move);
        ownerWindow.removeEventListener("pointerup", up);
        ownerWindow.removeEventListener("pointercancel", cancel);
        ownerWindow.removeEventListener("keydown", key);
        cleanup = undefined;
      };
      ownerWindow.addEventListener("pointermove", move);
      ownerWindow.addEventListener("pointerup", up);
      ownerWindow.addEventListener("pointercancel", cancel);
      ownerWindow.addEventListener("keydown", key);
    });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (pending.current || regionRef.current)) {
        cancel();
      }
    };
    ownerWindow.addEventListener("keydown", escape);
    return () => {
      ownerWindow.removeEventListener("keydown", escape);
      cleanup?.();
      unsub();
    };
  }, [api, ownerWindow, commit]);
  const captureAll = useCallback(async () => {
    if (!api) {
      return;
    }
    for (const element of api.getSceneElements()) {
      if (readCanvasHtmlApp(element.customData?.htmlApp)) {
        const runtime = runtimes.current.get(element.id);
        if (!runtime) {
          throw new Error("应用未启动，无法导出当前画面；请等待应用就绪");
        }
        cacheEmbeddableSnapshot(element, await runtime.capture());
      }
    }
  }, [api]);
  const renderEmbeddable: ExcalidrawProps["renderEmbeddable"] = (element) => {
    const app = readCanvasHtmlApp(element.customData?.htmlApp);
    if (!api) {
      return null;
    }
    if (!app) {
      return element.customData?.htmlApp ? (
        <div className="canvas-html-app" role="alert">
          应用引用格式或版本不受支持。原始数据已保留，请更新程序或恢复源码。
        </div>
      ) : null;
    }
    return (
      <CanvasApp
        element={element}
        app={app}
        api={api}
        noteId={noteId}
        json={json}
        onEdit={() => callbacks.current.onEdit(element.id)}
        register={(runtime) => {
          registerEmbeddableCapture(
            element.id,
            runtime ? () => runtime.capture() : null,
          );
          if (runtime) {
            runtimes.current.set(element.id, runtime);
          } else {
            runtimes.current.delete(element.id);
          }
        }}
      />
    );
  };
  const onDuplicate: ExcalidrawProps["onDuplicate"] = (next, previous) => {
    return forkHtmlApps(next, new Set(previous.map((e) => e.id)));
  };
  return {
    regionBounds:
      region && api
        ? (() => {
            const state = api.getAppState();
            const point = sceneCoordsToViewportCoords(
              { sceneX: region.x, sceneY: region.y },
              state,
            );
            return {
              left: point.x - state.offsetLeft,
              top: point.y - state.offsetTop,
              width: region.width * state.zoom.value,
              height: region.height * state.zoom.value,
            };
          })()
        : null,
    htmlHost: host,
    renderEmbeddable,
    onDuplicate,
    captureAll,
    region,
    placing,
    cancelRegion: () => {
      task.current++;
      pending.current = null;
      setPlacing(false);
      setRegion(null);
      api?.setActiveTool({ type: "selection" });
    },
    selection,
    hasTransientEdits: () =>
      (api?.getSceneElements() || []).some((element) => {
        const app = readCanvasHtmlApp(element.customData?.htmlApp);
        const runtime = runtimes.current.get(element.id);
        return (
          app &&
          runtime &&
          JSON.stringify(app.state) !== JSON.stringify(runtime.state())
        );
      }),
    captureChatSnapshot: () => ({
      capturedAt: Date.now(),
      elements: (api?.getSceneElements() || []).map((e) => {
        const value = structuredClone(e);
        const app = readCanvasHtmlApp(value.customData?.htmlApp);
        return {
          ...value,
          ...(app
            ? {
                customData: {
                  htmlApp: {
                    ...app,
                    state: runtimes.current.get(e.id)?.state() || app.state,
                  },
                },
              }
            : {}),
        } as unknown as Record<string, unknown>;
      }),
    }),
  };
};

const CanvasApp = ({
  element,
  app,
  api,
  noteId,
  json,
  register,
  onEdit,
}: {
  element: ExcalidrawEmbeddableElement;
  app: CanvasHtmlApp;
  api: ExcalidrawImperativeAPI;
  noteId: string | null;
  json: (url: string, body?: unknown) => Promise<HtmlArtifact>;
  register: (runtime: HtmlAppRuntime | null) => void;
  onEdit: () => void;
}) => {
  const [missing, setMissing] = useState("");
  const [resolved, setResolved] = useState<{
    key: string;
    source: string;
  } | null>(null);
  const sourceKey = `${app.appId}/${app.version}/${app.sourceHash}/${noteId}`;
  const [run, setRun] = useState(0);
  const node = useRef<HTMLDivElement>(null);
  const runtime = useRef<HtmlAppRuntime | null>(null);
  useEffect(() => {
    if (
      runtime.current &&
      JSON.stringify(runtime.current.state()) !== JSON.stringify(app.state)
    ) {
      setRun((value) => value + 1);
    }
  }, [app.state]);
  useEffect(() => {
    const win = node.current!.ownerDocument.defaultView as Window &
      typeof globalThis;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const fallback = async () => {
      const digest = await win.crypto.subtle.digest(
        "SHA-256",
        new win.TextEncoder().encode(app.sourceSnapshot),
      );
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (hash !== app.sourceHash) {
        throw new Error("笔记源码快照校验失败，请恢复权威源码文件");
      }
      if (!cancelled) {
        setResolved({ key: sourceKey, source: app.sourceSnapshot });
      }
    };
    const check = () => {
      void json(`/api/notes/${noteId}/apps/${app.appId}?version=${app.version}`)
        .catch(async (error) => {
          if (!app.pendingSource) {
            throw error;
          }
          return json(`/api/notes/${noteId}/apps/${app.appId}/restore`, {
            source: app.sourceSnapshot,
            state: app.state,
            title: app.title,
          });
        })
        .then((value) => {
          if (cancelled) {
            return;
          }
          if (value.sourceHash !== app.sourceHash) {
            throw new Error("源码与笔记版本不一致");
          }
          setResolved({ key: sourceKey, source: value.source });
          setMissing("");
          if (app.pendingSource) {
            const live = api
              .getSceneElements()
              .find((item) => item.id === element.id);
            const current = readCanvasHtmlApp(live?.customData?.htmlApp);
            if (live && current?.appId === app.appId && current.pendingSource) {
              const { pendingSource: _pending, ...stored } = current;
              api.updateScene({
                elements: api.getSceneElementsIncludingDeleted().map((item) =>
                  item.id === live.id
                    ? newElementWith(item, {
                        customData: { ...item.customData, htmlApp: stored },
                      })
                    : item,
                ),
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            }
          }
        })
        .catch(async (e) => {
          if (cancelled) {
            return;
          }
          if (app.pendingSource && attempt++ < 5) {
            timer = win.setTimeout(check, 1000);
          } else {
            setMissing(e.message);
            try {
              await fallback();
            } catch (error) {
              if (!cancelled) {
                setMissing((error as Error).message);
              }
            }
          }
        });
    };
    if (noteId) {
      check();
    } else {
      void fallback().catch((error) => {
        if (!cancelled) {
          setMissing(error.message);
        }
      });
    }
    return () => {
      cancelled = true;
      win.clearTimeout(timer);
    };
    // Source/state are frozen for this immutable version. Input changes don't re-read files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.appId, app.version, app.sourceHash, noteId, json]);
  return (
    <div
      ref={node}
      className="canvas-html-app"
      style={{ width: element.width, height: element.height }}
    >
      <div className="canvas-html-app-title">
        <span>{app.title}</span>
        <button
          data-embeddable-control
          onClick={onEdit}
          disabled={resolved?.key !== sourceKey || Boolean(missing)}
        >
          在聊天中修改
        </button>
      </div>
      {missing && (
        <div role="alert" data-embeddable-control>
          {missing}
          <button
            onClick={() => {
              if (noteId) {
                void json(`/api/notes/${noteId}/apps/${app.appId}/restore`, {
                  source: app.sourceSnapshot,
                  state: app.state,
                  title: app.title,
                })
                  .then(() => setMissing(""))
                  .catch((e) => setMissing(e.message));
              }
            }}
          >
            恢复源码文件
          </button>
        </div>
      )}
      <div data-embeddable-control className="canvas-html-app-content">
        <HtmlAppView
          source={resolved?.key === sourceKey ? resolved.source : ""}
          active={resolved?.key === sourceKey}
          complete
          initialState={app.state}
          identity={`${app.appId}/${app.version}/${run}`}
          runtimeVersion={app.runtimeVersion}
          onRuntime={(value) => {
            runtime.current = value;
            register(
              value
                ? {
                    state: value.state,
                    capture: async () => {
                      const root = node.current;
                      const frame = root?.querySelector("iframe");
                      const live = api
                        .getSceneElements()
                        .find((item) => item.id === element.id);
                      if (!root || !frame || !live) {
                        throw new Error("应用已关闭，无法捕获当前画面");
                      }
                      if (frame.closest(".is-expanded")) {
                        throw new Error(
                          "请先关闭放大视图，再导出画布尺寸的当前画面",
                        );
                      }
                      const rect = root.getBoundingClientRect();
                      const inner = frame.getBoundingClientRect();
                      if (!rect.width || !rect.height) {
                        throw new Error("应用尺寸尚未就绪，请重试导出");
                      }
                      const x =
                        ((inner.left - rect.left) * live.width) / rect.width;
                      const y =
                        ((inner.top - rect.top) * live.height) / rect.height;
                      const svg = await value.capture();
                      // Keep source viewport pixels at their native size. The host's
                      // drag bar and controls are not stretched into app content.
                      return `<svg xmlns="http://www.w3.org/2000/svg" width="${live.width}" height="${live.height}" viewBox="0 0 ${live.width} ${live.height}"><g transform="translate(${x},${y})">${svg}</g></svg>`;
                    },
                  }
                : null,
            );
          }}
          onHistory={(redo) => {
            if (!api.getAppState().viewModeEnabled) {
              api.history[redo ? "redo" : "undo"]();
            }
          }}
          title={app.title}
          onState={(state) => {
            const live = api
              .getSceneElements()
              .find((e) => e.id === element.id);
            const current = readCanvasHtmlApp(live?.customData?.htmlApp);
            if (
              !live ||
              !current ||
              current.sourceHash !== app.sourceHash ||
              current.appId !== app.appId ||
              JSON.stringify(current.state) === JSON.stringify(state)
            ) {
              return;
            }
            api.updateScene({
              elements: api.getSceneElementsIncludingDeleted().map((e) =>
                e.id === live.id
                  ? newElementWith(e, {
                      customData: {
                        ...e.customData,
                        htmlApp: { ...current, state },
                      },
                    })
                  : e,
              ),
              captureUpdate: CaptureUpdateAction.IMMEDIATELY,
            });
          }}
        />
        <button
          className="canvas-html-app-restart"
          onClick={() => setRun(run + 1)}
        >
          重新运行
        </button>
      </div>
    </div>
  );
};

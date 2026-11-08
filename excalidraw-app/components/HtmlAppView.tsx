import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import captureURL from "html-to-image/dist/html-to-image.js?url";
import {
  CloseIcon,
  fullscreenIcon,
} from "@excalidraw/excalidraw/components/icons";

import { htmlBootstrap } from "../data/htmlRuntime";
import { isHtmlState } from "../data/chatHtml";
import { HTML_RUNTIME_VERSION } from "../data/clientProtocol";
import { APP_LIBRARIES, isAppLibrary } from "../data/appLibraries";
import { isPreviewReport } from "../data/appPreview";
import { HtmlLibraryStream } from "../data/htmlLibraryStream";

import { ChatIconButton } from "./ChatIconButton";

import type { AppPreviewReport } from "../data/appPreview";

import type { HtmlState } from "../data/chatHtml";
import type { ReactNode } from "react";

export type HtmlAppRuntime = {
  state: () => HtmlState;
  capture: () => Promise<string>;
  preview?: () => AppPreviewReport | null;
};
const captureLibraries = new WeakMap<Window, Promise<string>>();
const appLibraries = new WeakMap<Window, Map<string, Promise<string>>>();
export const HtmlAppView = ({
  source,
  complete,
  initialState,
  runtimeVersion = HTML_RUNTIME_VERSION,
  identity,
  onState,
  onRuntime,
  title = "HTML 应用",
  active = true,
  onError,
  onHistory,
  onDraft,
  onPreview,
  actions,
  verifyInteractions = false,
  transparentCanvas = false,
  actionsContainer,
}: {
  source: string;
  complete: boolean;
  initialState: HtmlState;
  runtimeVersion?: number;
  identity: string;
  onState?: (state: HtmlState) => void;
  onRuntime?: (runtime: HtmlAppRuntime | null) => void;
  onError?: (error: string) => void;
  onHistory?: (redo: boolean) => void;
  onDraft?: (state: HtmlState) => void;
  onPreview?: (report: AppPreviewReport) => void;
  title?: string;
  active?: boolean;
  actions?: ReactNode;
  verifyInteractions?: boolean;
  transparentCanvas?: boolean;
  actionsContainer?: HTMLElement | null;
}) => {
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const current = useRef({
    identity,
    source,
    complete,
    onState,
    onRuntime,
    onError,
    onHistory,
    onDraft,
    onPreview,
  });
  current.current = {
    identity,
    source,
    complete,
    onState,
    onRuntime,
    onError,
    onHistory,
    onDraft,
    onPreview,
  };
  const initial = useRef(initialState);
  initial.current = initialState;
  const pumpRef = useRef<() => void>(() => {});
  const presentationRef = useRef<(transparent: boolean) => void>(() => {});
  const expandButton = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState("starting");
  useEffect(() => {
    if (!active) {
      return;
    }
    setError("");
    setPhase("starting");
    const node = root.current!;
    const doc = node.ownerDocument;
    const win = doc.defaultView!;
    if (runtimeVersion > HTML_RUNTIME_VERSION || runtimeVersion < 1) {
      setError("运行时版本不受支持，源码已保留");
      return;
    }
    let state = structuredClone(initial.current);
    let offset = 0;
    let ready = false;
    let finished = false;
    let disposed = false;
    let observedPreview: AppPreviewReport | null = null;
    const isCurrent = () => !disposed && current.current.identity === identity;
    const projector = new HtmlLibraryStream();
    let sourceQueue = Promise.resolve();
    const prepared = new Map<
      string,
      { resolve: () => void; reject: (error: Error) => void; timer: number }
    >();
    const pending = new Map<
      string,
      {
        resolve: (svg: string) => void;
        reject: (e: Error) => void;
        timer: number;
      }
    >();
    const frame = doc.createElement("iframe");
    frame.title = title;
    frame.className = "note-chat-html-frame html-app-frame";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.referrerPolicy = "no-referrer";
    const token = win.crypto.randomUUID();
    const inputToken = win.crypto.randomUUID();
    const send = (type: string, data?: unknown, requestId?: string) =>
      frame.contentWindow?.postMessage(
        { token: inputToken, type, data, requestId },
        "*",
      );
    presentationRef.current = (transparent) =>
      send("presentation", { transparent });
    const pump = () => {
      if (!ready || finished || !isCurrent()) {
        return;
      }
      const latest = current.current;
      if (latest.source.length > offset || (latest.complete && !finished)) {
        const final = latest.complete && !finished;
        const pieces = projector.push(latest.source.slice(offset), final);
        offset = latest.source.length;
        if (final) {
          finished = true;
        }
        sourceQueue = sourceQueue
          .then(async () => {
            for (const piece of pieces) {
              if (!isCurrent()) {
                return;
              }
              if ("html" in piece) {
                send("append", piece.html);
              } else {
                await new Promise<void>((resolve, reject) => {
                  const timer = win.setTimeout(() => {
                    prepared.delete(piece.library);
                    reject(new Error("本地依赖准备超时"));
                  }, 30000);
                  prepared.set(piece.library, { resolve, reject, timer });
                  send("library_prepare", { name: piece.library });
                });
              }
            }
            if (final && isCurrent()) {
              send("finish");
            }
          })
          .catch((error) => {
            if (isCurrent()) {
              fail(String(error));
            }
          });
      }
    };
    pumpRef.current = pump;
    const fail = (message: string) => {
      if (!isCurrent()) {
        return;
      }
      setError(message);
      setPhase("error");
      current.current.onError?.(message);
    };
    const runtime: HtmlAppRuntime = {
      preview: () =>
        isCurrent() ? win.structuredClone(observedPreview) : null,
      state: () => structuredClone(state),
      capture: async () => {
        let library = captureLibraries.get(win);
        if (!library) {
          library = win.fetch(captureURL).then(async (response) => {
            if (!response.ok) {
              throw new Error("快照模块加载失败");
            }
            return response.text();
          });
          captureLibraries.set(win, library);
          void library.catch(() => captureLibraries.delete(win));
        }
        const script = await library;
        return new Promise((resolve, reject) => {
          const id = win.crypto.randomUUID();
          const timer = win.setTimeout(() => {
            pending.delete(id);
            reject(new Error("应用快照超时，请重试导出"));
          }, 10000);
          pending.set(id, { resolve, reject, timer });
          send("capture", { library: script }, id);
        });
      },
    };
    const theme = () =>
      send(
        "theme",
        node.closest(".excalidraw")?.classList.contains("theme--dark")
          ? "dark"
          : "light",
      );
    const receive = (event: MessageEvent) => {
      if (
        !isCurrent() ||
        event.source !== frame.contentWindow ||
        event.data?.token !== token
      ) {
        return;
      }
      const { type, data } = event.data;
      if (type === "ready") {
        ready = true;
        setPhase("building");
        if (current.current.onHistory) {
          send("history_support", true);
        }
        theme();
        pump();
      } else if (type === "complete") {
        setPhase("complete");
      } else if (type === "preview" && isPreviewReport(data)) {
        observedPreview = win.structuredClone(data);
        current.current.onPreview?.(data);
      } else if (type === "preview_dirty") {
        observedPreview = null;
      } else if (type === "library_prepared") {
        const pending = prepared.get(data?.name);
        if (pending) {
          prepared.delete(data.name);
          win.clearTimeout(pending.timer);
          if (data.error) {
            pending.reject(new Error(String(data.error)));
          } else {
            pending.resolve();
          }
        }
      } else if (type === "history") {
        if (data === "undo" || data === "redo") {
          current.current.onHistory?.(data === "redo");
        }
      } else if (type === "error") {
        fail(`运行出错：${String(data).slice(0, 500)}`);
      } else if (type === "library_request" && isAppLibrary(data?.name)) {
        const name = data.name as keyof typeof APP_LIBRARIES;
        let cache = appLibraries.get(win);
        if (!cache) {
          cache = new Map();
          appLibraries.set(win, cache);
        }
        let request = cache.get(name);
        if (!request) {
          request = win
            .fetch(`/app-libraries/${APP_LIBRARIES[name].file}`)
            .then(async (response) => {
              if (
                !response.ok ||
                !response.headers.get("content-type")?.includes("javascript")
              ) {
                throw new Error("本地库读取失败，请刷新到最新版本");
              }
              const source = await response.text();
              if (source.length > 6000000) {
                throw new Error("本地库超过大小限制");
              }
              return source;
            });
          cache.set(name, request);
          void request.catch(() => cache!.delete(name));
        }
        void request.then(
          (source) => {
            if (!disposed) {
              send("library_result", { name, source });
            }
          },
          (error) => {
            if (!disposed) {
              send("library_result", { name, error: String(error) });
            }
          },
        );
      } else if (type === "patch_rejected") {
        fail(
          `部分更新未应用，已保留你的操作：${String(data?.reason).slice(
            0,
            300,
          )}`,
        );
      } else if (type === "escape" && dialog.current?.matches(":modal")) {
        dialog.current.close();
      } else if (
        (type === "state" || type === "state_preview") &&
        isHtmlState(data)
      ) {
        state = data;
        if (!disposed) {
          (type === "state"
            ? current.current.onState
            : current.current.onDraft)?.(structuredClone(state));
        }
      } else if (type === "capture_result") {
        const request = pending.get(data?.requestId);
        if (!request) {
          return;
        }
        pending.delete(data.requestId);
        win.clearTimeout(request.timer);
        if (
          data.error ||
          typeof data.png !== "string" ||
          !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(
            data.png,
          ) ||
          data.png.length > 1800000 ||
          !Number.isFinite(data.width) ||
          !Number.isFinite(data.height) ||
          data.width < 1 ||
          data.height < 1 ||
          data.width * data.height > 4000000
        ) {
          request.reject(new Error(data.error || "快照格式或尺寸无效"));
        } else {
          request.resolve(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${data.width}" height="${data.height}" viewBox="0 0 ${data.width} ${data.height}"><image width="${data.width}" height="${data.height}" href="${data.png}"/></svg>`,
          );
        }
      }
    };
    const observer = new win.MutationObserver(theme);
    const app = node.closest(".excalidraw");
    if (app) {
      observer.observe(app, { attributes: true, attributeFilter: ["class"] });
    }
    win.addEventListener("message", receive);
    node.appendChild(frame);
    frame.srcdoc = htmlBootstrap(
      token,
      state,
      runtimeVersion,
      "",
      inputToken,
      verifyInteractions,
      transparentCanvas,
    );
    const registerRuntime = current.current.onRuntime;
    registerRuntime?.(runtime);
    const boot = win.setTimeout(() => {
      if (!ready) {
        fail("应用启动超时，源码仍保留，可重新运行");
      }
    }, 10000);
    return () => {
      disposed = true;
      for (const request of prepared.values()) {
        win.clearTimeout(request.timer);
        request.reject(new Error("应用已关闭"));
      }
      prepared.clear();
      win.clearTimeout(boot);
      for (const request of pending.values()) {
        win.clearTimeout(request.timer);
        request.reject(new Error("应用已关闭"));
      }
      registerRuntime?.(null);
      observer.disconnect();
      win.removeEventListener("message", receive);
      send("dispose");
      frame.remove();
    };
    // Stable parser per source version; streaming updates are appended, never remounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, active, runtimeVersion, verifyInteractions, transparentCanvas]);
  useEffect(() => pumpRef.current());
  useEffect(() => {
    if (transparentCanvas) {
      const frame = root.current?.querySelector("iframe");
      // Update presentation through the existing authenticated bridge, retaining
      // the same document, listeners, inputs and timers when opening the dialog.
      presentationRef.current(!expanded);
      if (frame) {
        frame.style.background = "transparent";
      }
    }
  }, [expanded, transparentCanvas, phase]);
  const actionBar = (
    <div className="html-app-actions" role="group" aria-label="应用操作">
      <ChatIconButton
        buttonRef={expandButton}
        label="放大试用"
        icon={fullscreenIcon}
        onClick={() => {
          dialog.current?.close();
          dialog.current?.showModal();
          setExpanded(true);
        }}
      />
      {actions}
    </div>
  );
  return (
    <div
      className={`html-app-view ${
        transparentCanvas ? "is-canvas-surface" : ""
      }`}
      data-app-status={phase}
    >
      <dialog
        open
        ref={dialog}
        className={`note-chat-html-dialog ${expanded ? "is-expanded" : ""}`}
        onClose={() => {
          const node = dialog.current;
          // Inline -> modal calls close() then showModal(). Its queued close
          // event belongs to the old presentation, not the reopened modal.
          if (!node || node.open || !node.isConnected) {
            return;
          }
          setExpanded(false);
          node.show();
          expandButton.current?.focus({ preventScroll: true });
        }}
      >
        {expanded && (
          <ChatIconButton
            label="关闭放大"
            icon={CloseIcon}
            onClick={() => dialog.current?.close()}
          />
        )}
        <div className="html-app-runtime" ref={root}>
          {!active && (
            <p className="note-chat-muted">
              源码草稿未运行，可查看代码或继续修正。
            </p>
          )}
        </div>
      </dialog>
      {error && (
        <p role="alert" className="note-chat-inline-error">
          {error}
        </p>
      )}
      {actionsContainer
        ? createPortal(actionBar, actionsContainer)
        : !transparentCanvas
        ? actionBar
        : null}
    </div>
  );
};

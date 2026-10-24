import { useEffect, useRef, useState } from "react";
import captureURL from "html-to-image/dist/html-to-image.js?url";
import {
  CloseIcon,
  fullscreenIcon,
} from "@excalidraw/excalidraw/components/icons";

import { htmlBootstrap } from "../data/htmlRuntime";
import { isHtmlState } from "../data/chatHtml";
import { HTML_RUNTIME_VERSION } from "../data/clientProtocol";

import { ChatIconButton } from "./ChatIconButton";

import type { HtmlState } from "../data/chatHtml";
import type { ReactNode } from "react";

export type HtmlAppRuntime = {
  state: () => HtmlState;
  capture: () => Promise<string>;
};
const captureLibraries = new WeakMap<Window, Promise<string>>();
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
  actions,
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
  title?: string;
  active?: boolean;
  actions?: ReactNode;
}) => {
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const current = useRef({
    source,
    complete,
    onState,
    onRuntime,
    onError,
    onHistory,
    onDraft,
  });
  current.current = {
    source,
    complete,
    onState,
    onRuntime,
    onError,
    onHistory,
    onDraft,
  };
  const initial = useRef(initialState);
  initial.current = initialState;
  const pumpRef = useRef<() => void>(() => {});
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) {
      return;
    }
    setError("");
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
    const send = (type: string, data?: unknown, requestId?: string) =>
      frame.contentWindow?.postMessage({ token, type, data, requestId }, "*");
    const pump = () => {
      if (!ready) {
        return;
      }
      const latest = current.current;
      if (latest.source.length > offset) {
        send("append", latest.source.slice(offset));
        offset = latest.source.length;
      }
      if (latest.complete && !finished) {
        send("finish");
        finished = true;
      }
    };
    pumpRef.current = pump;
    const fail = (message: string) => {
      setError(message);
      current.current.onError?.(message);
    };
    const runtime: HtmlAppRuntime = {
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
      if (event.source !== frame.contentWindow || event.data?.token !== token) {
        return;
      }
      const { type, data } = event.data;
      if (type === "ready") {
        ready = true;
        if (current.current.onHistory) {
          send("history_support", true);
        }
        theme();
        pump();
      } else if (type === "history") {
        if (data === "undo" || data === "redo") {
          current.current.onHistory?.(data === "redo");
        }
      } else if (type === "error") {
        fail(`运行出错：${String(data).slice(0, 500)}`);
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
    frame.srcdoc = htmlBootstrap(token, state, runtimeVersion);
    current.current.onRuntime?.(runtime);
    const boot = win.setTimeout(() => {
      if (!ready) {
        fail("应用启动超时，源码仍保留，可重新运行");
      }
    }, 10000);
    return () => {
      disposed = true;
      win.clearTimeout(boot);
      for (const request of pending.values()) {
        win.clearTimeout(request.timer);
        request.reject(new Error("应用已关闭"));
      }
      current.current.onRuntime?.(null);
      observer.disconnect();
      win.removeEventListener("message", receive);
      send("dispose");
      frame.remove();
    };
    // Stable parser per source version; streaming updates are appended, never remounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, active, runtimeVersion]);
  useEffect(() => pumpRef.current());
  return (
    <div className="html-app-view">
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
          node.parentElement
            ?.querySelector<HTMLButtonElement>(".html-app-actions > button")
            ?.focus({ preventScroll: true });
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
      <div className="html-app-actions" role="group" aria-label="应用操作">
        <ChatIconButton
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
    </div>
  );
};

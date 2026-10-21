import { useEffect, useRef, useState } from "react";
import { Button } from "@excalidraw/excalidraw/components/Button";

import { htmlBootstrap } from "../data/htmlRuntime";
import { isHtmlState } from "../data/chatHtml";
import { HTML_RUNTIME_VERSION } from "../data/clientProtocol";

import type { ChatBlock, HtmlArtifact, HtmlState } from "../data/chatHtml";
import type { NoteChatController } from "../data/noteChats";

export const ChatHtmlCard = ({
  block,
  noteId,
  sessionId,
  generating,
  controller,
}: {
  block: Extract<ChatBlock, { type: "html" }>;
  noteId: string;
  sessionId: string;
  generating: boolean;
  controller: NoteChatController;
}) => {
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const source = useRef("");
  const completed = useRef(false);
  const offset = useRef(0);
  const ready = useRef(false);
  const token = useRef("");
  const [data, setData] = useState<HtmlArtifact>();
  const [error, setError] = useState("");
  const [code, setCode] = useState(false);
  const [running, setRunning] = useState(false);
  const [restart, setRestart] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [saved, setSaved] = useState(false);
  const state = useRef<HtmlState>(
    block.initialState || { forms: {}, custom: {} },
  );
  const revision = useRef(0);
  const saving = useRef(Promise.resolve());
  const endpoint = `/api/notes/${encodeURIComponent(
    noteId,
  )}/chats/${encodeURIComponent(sessionId)}/html-artifacts/${
    block.ref.artifactId
  }?version=${block.ref.version}`;
  source.current = block.source || data?.source || "";
  completed.current = block.complete || Boolean(data?.complete);
  const pump = () => {
    if (!ready.current || !frame.current?.contentWindow) {
      return;
    }
    const target = frame.current.contentWindow;
    const text = source.current.slice(offset.current);
    if (text) {
      target.postMessage(
        { token: token.current, type: "append", data: text },
        "*",
      );
      offset.current = source.current.length;
    }
    if (completed.current) {
      target.postMessage({ token: token.current, type: "finish" }, "*");
      ready.current = false;
    }
  };
  useEffect(() => {
    if (!block.saved && generating) {
      return;
    }
    const ownerWindow = root.current!.ownerDocument.defaultView!;
    let cancelled = false;
    void ownerWindow
      .fetch(endpoint)
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) {
          throw new Error(value.error);
        }
        if ((value.runtimeVersion || 1) > HTML_RUNTIME_VERSION) {
          throw new Error(
            "此应用需要较新的运行时，请更新界面；原始源码已保留。",
          );
        }
        if (value.complete && !value.source.trim()) {
          throw new Error(
            "作品引用存在，但源码为空；请重新读取或查看原始记录。",
          );
        }
        if (!cancelled) {
          setData(value);
          revision.current = Math.max(revision.current, value.revision);
          if (!frame.current) {
            state.current = value.state;
          }
          setSaved(true);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setError(error.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, block.saved, generating, restart]);
  const shouldRun = Boolean(
    generating || running || data?.complete || frame.current,
  );
  useEffect(() => {
    if (!shouldRun) {
      return;
    }
    const node = root.current!;
    const doc = node.ownerDocument;
    const win = doc.defaultView!;
    const app = node.closest(".excalidraw");
    const iframe = doc.createElement("iframe");
    iframe.title = data?.title || "HTML 交互应用";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.referrerPolicy = "no-referrer";
    iframe.className = "note-chat-html-frame";
    token.current = win.crypto.randomUUID();
    offset.current = 0;
    ready.current = false;
    let timer: number | undefined;
    let changed = false;
    let disposed = false;
    const bootTimer = win.setTimeout(() => {
      if (!disposed && !ready.current && offset.current === 0) {
        setError(
          "预览初始化未完成。源码已保留，请重新运行；可展开版本信息核对界面版本。",
        );
      }
    }, 10000);
    const syncTheme = () => {
      const theme = app?.classList.contains("theme--dark") ? "dark" : "light";
      iframe.style.colorScheme = theme;
      iframe.contentWindow?.postMessage(
        { token: token.current, type: "theme", data: theme },
        "*",
      );
    };
    const observer = new win.MutationObserver(syncTheme);
    if (app) {
      observer.observe(app, { attributes: true, attributeFilter: ["class"] });
    }
    const save = () => {
      if (!changed) {
        return;
      }
      changed = false;
      const snapshot = JSON.parse(JSON.stringify(state.current));
      saving.current = saving.current
        .then(async () => {
          const response = await win.fetch(endpoint, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              revision: revision.current,
              state: snapshot,
            }),
          });
          const value = await response.json();
          if (!response.ok) {
            throw new Error(value.error || "应用输入尚未保存");
          }
          revision.current = value.revision;
          if (!disposed) {
            setSaved(true);
          }
        })
        .catch((error) => {
          if (!disposed) {
            setError(`输入尚未保存：${error.message}`);
          }
        });
    };
    const receive = (event: MessageEvent) => {
      if (
        event.source !== iframe.contentWindow ||
        event.data?.token !== token.current
      ) {
        return;
      }
      if (event.data.type === "ready") {
        win.clearTimeout(bootTimer);
        ready.current = true;
        syncTheme();
        pump();
      } else if (event.data.type === "escape") {
        if (dialog.current?.matches(":modal")) {
          dialog.current.close();
        }
      } else if (event.data.type === "error") {
        setError(`运行出错：${String(event.data.data).slice(0, 500)}`);
      } else if (event.data.type === "state") {
        const value = event.data.data;
        if (!isHtmlState(value)) {
          return;
        }
        state.current = value;
        changed = true;
        setSaved(false);
        win.clearTimeout(timer);
        timer = win.setTimeout(save, 500);
      }
    };
    win.addEventListener("message", receive);
    frame.current = iframe;
    node.appendChild(iframe);
    iframe.srcdoc = htmlBootstrap(token.current, state.current);
    return () => {
      disposed = true;
      win.clearTimeout(bootTimer);
      win.clearTimeout(timer);
      save();
      win.removeEventListener("message", receive);
      observer.disconnect();
      iframe.remove();
      frame.current = null;
    };
    // One parser instance per version/run. Source updates go through pump, not srcdoc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, shouldRun, restart]);
  useEffect(() => {
    pump();
  });
  return (
    <section className="note-chat-html-card" aria-label="HTML 应用">
      <header>
        <strong>{data?.title || "HTML 应用"}</strong>
        <span>
          v{block.ref.version} ·{" "}
          {generating && !block.complete
            ? "生成中"
            : !completed.current
            ? "生成未完成"
            : saved
            ? "源码已保存"
            : "保存中"}
        </span>
      </header>
      <dialog
        open
        ref={dialog}
        className={`note-chat-html-dialog${expanded ? " is-expanded" : ""}`}
        onClose={() => {
          const node = dialog.current;
          if (node?.matches(":modal")) {
            return;
          }
          setExpanded(false);
          if (node && !node.open) {
            node.show();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && expanded) {
            event.stopPropagation();
            dialog.current?.close();
          }
        }}
      >
        {expanded && (
          <Button onSelect={() => dialog.current?.close()}>关闭放大</Button>
        )}
        <div ref={root} />
      </dialog>
      {!generating && !completed.current && !running && (
        <p>未完成的源码已保留，恢复后不会自动运行。</p>
      )}
      {error && (
        <p role="alert" className="note-chat-inline-error">
          {error}
        </p>
      )}
      <footer>
        <Button
          onSelect={() => {
            dialog.current?.close();
            dialog.current?.showModal();
            setExpanded(true);
          }}
        >
          放大
        </Button>
        <Button onSelect={() => setCode(!code)}>
          {code ? "收起代码" : "查看代码"}
        </Button>
        <Button
          onSelect={() => {
            setError("");
            setRunning(true);
            setRestart(restart + 1);
          }}
        >
          重新运行
        </Button>
        <Button
          onSelect={() => {
            controller.setWorkspace(noteId, sessionId, {
              ...block.ref,
            });
            controller.setDraft(
              noteId,
              sessionId,
              completed.current
                ? "请基于这个应用修改："
                : "请继续完成这个应用，返回完整 HTML：",
            );
          }}
        >
          {" "}
          {completed.current ? "继续修改" : "继续生成"}
        </Button>
      </footer>
      {code && (
        <pre className="note-chat-html-source">
          <code>{source.current}</code>
        </pre>
      )}
      <details className="note-chat-html-diagnostics">
        <summary>版本信息</summary>
        <small>
          应用 {block.ref.artifactId} · v{block.ref.version} · 运行时{" "}
          {data?.runtimeVersion || 1}
          <br />
          当前界面 {controller.getState().clientInfo?.loadedEntry || "待核对"}
          <br />
          服务端 {controller.getState().clientInfo?.buildId || "待核对"}
        </small>
      </details>
    </section>
  );
};

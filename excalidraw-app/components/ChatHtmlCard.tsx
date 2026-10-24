import { useEffect, useRef, useState } from "react";
import {
  codeIcon,
  RetryIcon,
  pencilIcon,
  stackPushIcon,
  checkIcon,
} from "@excalidraw/excalidraw/components/icons";

import { HtmlAppView } from "./HtmlAppView";
import { ChatIconButton } from "./ChatIconButton";

import type { HtmlAppRuntime } from "./HtmlAppView";

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
  const root = useRef<HTMLElement>(null);
  const runtime = useRef<HtmlAppRuntime | null>(null);
  const [data, setData] = useState<HtmlArtifact>();
  const [error, setError] = useState("");
  const [code, setCode] = useState(false);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState(0);
  const [saved, setSaved] = useState(false);
  const [trial, setTrial] = useState(false);
  const [original, setOriginal] = useState(false);
  const [baseline, setBaseline] = useState<HtmlArtifact>();
  const [working, setWorking] = useState(false);
  const state = useRef<HtmlState>(
    block.initialState || { forms: {}, custom: {} },
  );
  const revision = useRef(0);
  const saving = useRef(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);
  const endpoint = `/api/notes/${noteId}/chats/${sessionId}/html-artifacts/${block.ref.artifactId}?version=${block.ref.version}`;
  useEffect(() => {
    if (!data?.target && !data?.editBase) {
      return;
    }
    let cancelled = false;
    const target = data.target || {
      appId: data.editBase!.artifactId,
      version: data.editBase!.version,
    };
    const win = root.current!.ownerDocument.defaultView!;
    void win
      .fetch(
        data.target
          ? `/api/notes/${noteId}/apps/${target.appId}?version=${target.version}`
          : `/api/notes/${noteId}/chats/${sessionId}/html-artifacts/${target.appId}?version=${target.version}`,
      )
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) {
          throw new Error(value.error || "读取原版失败");
        }
        if (!cancelled) {
          setBaseline(value);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [data?.target, data?.editBase, noteId, sessionId]);
  useEffect(() => {
    if (!block.saved && generating) {
      return;
    }
    const win = root.current!.ownerDocument.defaultView!;
    let cancelled = false;
    void win
      .fetch(endpoint)
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) {
          throw new Error(value.error || "读取源码失败");
        }
        if (cancelled) {
          return;
        }
        setData(value);
        revision.current = value.revision;
        if (!generating) {
          state.current = value.state;
        }
        setSaved(value.complete === true);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, block.saved, generating, run]);
  const persist = (next: HtmlState) => {
    state.current = next;
    controller.setHtmlTrial(noteId, sessionId, block.ref, next);
    setSaved(false);
    const win = root.current!.ownerDocument.defaultView!;
    win.clearTimeout(timer.current);
    timer.current = win.setTimeout(() => {
      saving.current = saving.current
        .then(async () => {
          const response = await win.fetch(endpoint, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ revision: revision.current, state: next }),
          });
          const value = await response.json();
          if (!response.ok) {
            throw new Error(value.error || "输入未保存");
          }
          revision.current = value.revision;
          setSaved(true);
        })
        .catch((e) => setError(`输入尚未保存：${e.message}`));
    }, 500);
  };
  const failure = block.error || data?.recovery?.error;
  const complete = Boolean(!failure && (block.complete || data?.complete));
  const targetNow = data?.target
    ? controller.htmlHost?.read(data.target.elementId)
    : null;
  const applied = Boolean(
    data?.target &&
      targetNow?.appId === data.target.appId &&
      targetNow?.sourceHash === data.sourceHash,
  );
  const action = (work: () => Promise<unknown>) => {
    if (working) {
      return;
    }
    setWorking(true);
    setError("");
    void work()
      .catch((e) => setError(e.message))
      .finally(() => setWorking(false));
  };
  return (
    <section ref={root} className="note-chat-html-card" aria-label="HTML 应用">
      <header>
        <strong>{data?.title || "HTML 应用"}</strong>
        <span>
          {failure
            ? "未应用草稿"
            : data?.target || data?.editBase
            ? "修改候选"
            : "新作品"}{" "}
          · v{block.ref.version} ·{" "}
          {failure
            ? block.draftSaved || data?.recovery
              ? "草稿已保存"
              : "草稿待保存"
            : generating && !complete
            ? "生成中"
            : !complete
            ? "生成未完成"
            : saved
            ? "源码已保存"
            : data?.complete
            ? "输入待保存"
            : "校验及保存中"}
        </span>
      </header>
      {(data?.target || data?.editBase) && (
        <div className="note-chat-widget-compare">
          <button
            disabled={!baseline}
            aria-pressed={original}
            onClick={() => setOriginal(true)}
          >
            原版（只读）
          </button>
          <button aria-pressed={!original} onClick={() => setOriginal(false)}>
            修改候选
          </button>
        </div>
      )}
      <div inert={original}>
        <HtmlAppView
          source={
            original
              ? baseline?.source || ""
              : block.source || data?.source || ""
          }
          complete={original ? Boolean(baseline?.complete) : complete}
          initialState={
            original ? baseline?.state || state.current : state.current
          }
          identity={`${endpoint}/${run}/${original}`}
          runtimeVersion={block.runtimeVersion || data?.runtimeVersion || 1}
          active={Boolean(
            original
              ? baseline?.complete
              : !failure && (generating || running || data?.complete),
          )}
          onState={original ? undefined : persist}
          onDraft={original ? undefined : persist}
          onRuntime={(value) => {
            runtime.current = value;
          }}
          actions={
            <>
              <ChatIconButton
                label={code ? "收起代码" : "查看代码"}
                icon={codeIcon}
                active={code}
                aria-expanded={code}
                onClick={() => setCode(!code)}
              />
              <ChatIconButton
                label="重新运行"
                icon={RetryIcon}
                disabled={Boolean(failure)}
                onClick={() => {
                  setRunning(true);
                  setRun(run + 1);
                }}
              />
              {data?.recovery && !generating && (
                <ChatIconButton
                  label="继续修正"
                  icon={pencilIcon}
                  onClick={() =>
                    controller.recoverHtml(noteId, sessionId, data)
                  }
                />
              )}
              {complete && (
                <>
                  <ChatIconButton
                    label="继续修改"
                    icon={pencilIcon}
                    onClick={() => {
                      controller.setWorkspace(noteId, sessionId, block.ref);
                      controller.setDraft(
                        noteId,
                        sessionId,
                        "请读取源码并局部修改：",
                      );
                    }}
                  />
                  <ChatIconButton
                    label="导入笔记"
                    icon={stackPushIcon}
                    disabled={!data || working}
                    onClick={() =>
                      action(() =>
                        controller.placeHtml(
                          data!,
                          runtime.current?.state() || state.current,
                        ),
                      )
                    }
                  />
                </>
              )}
            </>
          }
        />
      </div>
      {!generating && !complete && <p>未完成源码已保留，不会自动运行。</p>}
      {error && (
        <p role="alert" className="note-chat-inline-error">
          {error}
        </p>
      )}
      {failure && (
        <details className="note-chat-inline-error">
          <summary>未应用修改，原组件未改变</summary>
          <pre>{failure}</pre>
        </details>
      )}
      {data?.target && complete && (
        <div className="html-app-candidate">
          <p>修改候选 · 正式实例在确认前不会改变</p>
          <label>
            <input
              type="checkbox"
              checked={trial}
              onChange={(e) => setTrial(e.target.checked)}
            />
            采用试用输入（默认保留正式实例的最新输入）
          </label>
          <ChatIconButton
            label={applied ? "已应用到画布" : "确认应用修改"}
            icon={checkIcon}
            disabled={working || original || applied}
            onClick={() =>
              action(() =>
                controller.applyHtml(
                  data,
                  runtime.current?.state() || state.current,
                  trial,
                ),
              )
            }
          />
        </div>
      )}
      {data?.changes && (
        <details>
          <summary>查看源码差异（{data.changes.length} 处）</summary>
          {data.changes.map((change, index) => (
            <div key={index}>
              <pre className="note-chat-html-source">− {change.before}</pre>
              <pre className="note-chat-html-source">+ {change.after}</pre>
            </div>
          ))}
        </details>
      )}
      {code && (
        <pre className="note-chat-html-source">
          <code>{block.source || data?.source}</code>
        </pre>
      )}
    </section>
  );
};

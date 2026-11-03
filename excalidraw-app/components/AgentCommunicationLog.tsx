import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import {
  copyIcon,
  checkIcon,
  downloadIcon,
  RetryIcon,
  CloseIcon,
} from "@excalidraw/excalidraw/components/icons";

import { agentLogLabels } from "../data/agentLog";

import { ChatIconButton } from "./ChatIconButton";
import "./AgentCommunicationLog.scss";

import type {
  AgentLogEntry,
  AgentLogPage,
  AgentLogTurn,
} from "../data/agentLog";
import type { ChatMessage } from "../data/chatTypes";
import type { ReactNode } from "react";

/** Local vertical overlay scrollbar: never reserves a gutter or changes wrapping. */
const LogScrollArea = ({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) => {
  const node = useRef<HTMLDivElement>(null);
  const scrollId = useId();
  const [scroll, setScroll] = useState({ top: 0, height: 0, total: 0 });
  const drag = useRef<{ y: number; top: number } | null>(null);
  const measure = () => {
    const el = node.current;
    if (el) {
      setScroll({
        top: el.scrollTop,
        height: el.clientHeight,
        total: el.scrollHeight,
      });
    }
  };
  useEffect(() => {
    const el = node.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win) {
      return;
    }
    const observer = new win.ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild);
    }
    measure();
    return () => observer.disconnect();
  }, []);
  const max = Math.max(0, scroll.total - scroll.height);
  const thumb = Math.min(
    scroll.height,
    Math.max(32, (scroll.height * scroll.height) / Math.max(1, scroll.total)),
  );
  return (
    <div className="agent-log-scroll-wrap">
      <div
        className="agent-log-scroll"
        id={scrollId}
        ref={node}
        tabIndex={0}
        aria-label={label}
        onScroll={measure}
      >
        <div>{children}</div>
      </div>
      {max > 0 && (
        <div
          className="agent-log-scroll-track"
          role="scrollbar"
          aria-controls={scrollId}
          aria-label={`${label}滚动条`}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={Math.round(scroll.top)}
          tabIndex={0}
          onKeyDown={(event) => {
            const el = node.current;
            if (!el) {
              return;
            }
            const values: Record<string, number> = {
              ArrowDown: el.scrollTop + 40,
              ArrowUp: el.scrollTop - 40,
              PageDown: el.scrollTop + el.clientHeight * 0.9,
              PageUp: el.scrollTop - el.clientHeight * 0.9,
              Home: 0,
              End: max,
            };
            if (event.key in values) {
              event.preventDefault();
              el.scrollTop = values[event.key];
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !node.current) {
              return;
            }
            const y =
              event.clientY - event.currentTarget.getBoundingClientRect().top;
            const start = (scroll.top / max) * (scroll.height - thumb);
            if (y < start || y > start + thumb) {
              node.current.scrollTop =
                ((y - thumb / 2) / Math.max(1, scroll.height - thumb)) * max;
            }
            drag.current = { y: event.clientY, top: node.current.scrollTop };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.focus({ preventScroll: true });
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (drag.current && node.current) {
              node.current.scrollTop =
                drag.current.top +
                ((event.clientY - drag.current.y) /
                  Math.max(1, scroll.height - thumb)) *
                  max;
            }
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
        >
          <span
            style={{
              height: thumb,
              transform: `translateY(${
                (scroll.top / max) * (scroll.height - thumb)
              }px)`,
            }}
          />
        </div>
      )}
    </div>
  );
};

const LogEntry = ({ entry }: { entry: AgentLogEntry }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLElement>(null);
  const data = entry.data as Record<string, unknown> | null;
  const result = data?.result as Record<string, unknown> | undefined;
  const failed = Boolean(
    data?.error ||
      result?.error ||
      (typeof data?.status === "number" && data.status >= 400) ||
      ["failed", "interrupted", "stopped"].includes(String(data?.status)),
  );
  const hint = String(
    data?.name ||
      data?.error ||
      result?.error ||
      data?.model ||
      data?.finish_reason ||
      data?.status ||
      "",
  );
  return (
    <article
      className={`agent-log-entry ${failed ? "has-error" : ""}`}
      ref={ref}
    >
      <details
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <span className="agent-log-sequence">{entry.sequence}</span>
          <span className="agent-log-entry-heading">
            <strong>{agentLogLabels[entry.kind] || entry.kind}</strong>
            {hint && <small>{hint}</small>}
          </span>
          <time dateTime={new Date(entry.at).toISOString()}>
            {new Date(entry.at).toLocaleTimeString()}
          </time>
        </summary>
        {open && (
          <div className="agent-log-entry-body">
            <div className="agent-log-entry-meta">
              <span>
                {entry.requestId
                  ? `请求 ${entry.requestId}`
                  : `轮次 ${entry.turnId}`}
              </span>
              <ChatIconButton
                label={copied ? "已复制日志" : "复制这条日志"}
                icon={copied ? checkIcon : copyIcon}
                onClick={async () => {
                  try {
                    const clipboard =
                      ref.current?.ownerDocument.defaultView?.navigator
                        .clipboard;
                    if (!clipboard) {
                      throw new Error("剪贴板不可用");
                    }
                    await clipboard.writeText(JSON.stringify(entry, null, 2));
                    setCopied(true);
                    setError("");
                  } catch {
                    setError("复制失败，可直接选取下面的内容");
                  }
                }}
              />
            </div>
            {error && <p role="status">{error}</p>}
            {entry.kind === "model_response" && data ? (
              <>
                {typeof data.reasoning_content === "string" &&
                  data.reasoning_content && (
                    <section>
                      <h4>思考输出</h4>
                      <pre>{data.reasoning_content}</pre>
                    </section>
                  )}
                {typeof data.content === "string" && data.content && (
                  <section>
                    <h4>正文输出（含原始源码）</h4>
                    <pre>{data.content}</pre>
                  </section>
                )}
                <section>
                  <h4>工具调用与结束信息</h4>
                  <pre>
                    {JSON.stringify(
                      Object.fromEntries(
                        Object.entries(data).filter(
                          ([key]) =>
                            !["content", "reasoning_content"].includes(key),
                        ),
                      ),
                      null,
                      2,
                    )}
                  </pre>
                </section>
              </>
            ) : (
              <pre>{JSON.stringify(entry.data, null, 2)}</pre>
            )}
          </div>
        )}
      </details>
    </article>
  );
};

export const AgentCommunicationLog = ({
  noteId,
  sessionId,
  messages,
  onClose,
}: {
  noteId: string;
  sessionId: string;
  messages: ChatMessage[];
  onClose: () => void;
}) => {
  // Dialog mounts its portal after the parent's first effect. Use a mounted
  // node dependency so the first load starts when that portal actually exists.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [turns, setTurns] = useState<AgentLogTurn[]>([]);
  const [selected, setSelected] = useState("");
  const [entries, setEntries] = useState<AgentLogEntry[]>([]);
  const [showStream, setShowStream] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [caughtUp, setCaughtUp] = useState(false);
  const base = `/api/notes/${encodeURIComponent(
    noteId,
  )}/chats/${encodeURIComponent(sessionId)}/agent-logs`;

  useEffect(() => {
    const win = root?.ownerDocument.defaultView;
    if (!win) {
      return;
    }
    const abort = new win.AbortController();
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const response = await win.fetch(base, { signal: abort.signal });
        const value = await response.json();
        if (!response.ok) {
          throw new Error(value.error || "无法读取通信日志");
        }
        if (abort.signal.aborted) {
          return;
        }
        setTurns(value.turns);
        setSelected((current) => current || value.turns[0]?.turnId || "");
        setLoading(false);
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError((cause as Error).message);
          setLoading(false);
        }
      }
      if (!abort.signal.aborted) {
        timer = win.setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => {
      abort.abort();
      win.clearTimeout(timer);
    };
  }, [base, retry, root]);

  useEffect(() => {
    const win = root?.ownerDocument.defaultView;
    if (!win || !selected) {
      return;
    }
    const abort = new win.AbortController();
    let timer: number | undefined;
    let cursor = 0;
    setEntries([]);
    setError("");
    setWarning("");
    setLoading(true);
    setCaughtUp(false);
    const refresh = async () => {
      let more = false;
      try {
        const response = await win.fetch(
          `${base}/${selected}?after=${cursor}`,
          { signal: abort.signal },
        );
        const value = (await response.json()) as AgentLogPage & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(value.error || "无法读取本轮通信日志");
        }
        if (abort.signal.aborted) {
          return;
        }
        if (value.entries.length) {
          setEntries((current) => [...current, ...value.entries]);
        }
        cursor = value.next;
        more = value.hasMore;
        setCaughtUp(!more);
        setWarning(
          value.recordingError ||
            (value.incomplete
              ? "日志有不完整记录，已保留能够读取的部分。"
              : ""),
        );
        setError("");
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError((cause as Error).message);
        }
      }
      if (!abort.signal.aborted) {
        setLoading(false);
        timer = win.setTimeout(refresh, more ? 0 : 1000);
      }
    };
    void refresh();
    return () => {
      abort.abort();
      win.clearTimeout(timer);
    };
  }, [base, selected, retry, root]);

  const current = turns.find((turn) => turn.turnId === selected);
  const question = (id: string) =>
    messages.find((message) => message.turnId === id && message.role === "user")
      ?.content || "历史轮次";
  const missingEnd =
    selected &&
    caughtUp &&
    !current?.running &&
    entries.length > 0 &&
    !entries.some((entry) => entry.kind === "turn_end");
  return (
    <Dialog
      title="Agent 通信日志"
      size="wide"
      onCloseRequest={onClose}
      className="agent-log-dialog"
      closeOnClickOutside={false}
    >
      <div
        className="agent-log"
        ref={setRoot}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
          }
          event.stopPropagation();
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <p className="agent-log-description">
          按实际通信顺序记录。请求包含提示、上下文和工具目录；输出包含思考、正文和工具参数。密钥与鉴权头不记录。
        </p>
        <div className="agent-log-toolbar">
          <select
            aria-label="通信轮次"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            disabled={!turns.length}
          >
            {!turns.length && <option value="">暂无通信轮次</option>}
            {turns.map((turn) => (
              <option key={turn.turnId} value={turn.turnId}>
                {new Date(turn.createdAt).toLocaleString()} ·{" "}
                {question(turn.turnId).slice(0, 50)}
                {turn.running ? " · 进行中" : ""}
              </option>
            ))}
          </select>
          <ChatIconButton
            label="重新加载通信日志"
            icon={RetryIcon}
            onClick={() => setRetry((value) => value + 1)}
          />
          {selected && (
            <a
              className="chat-icon-button"
              href={`${base}/${selected}?download=1`}
              download
              aria-label="下载本轮完整日志"
              data-tooltip="下载本轮完整日志"
            >
              {downloadIcon}
            </a>
          )}
          <ChatIconButton
            className="agent-log-close"
            label="关闭通信日志"
            icon={CloseIcon}
            onClick={onClose}
          />
        </div>
        <div className="agent-log-options">
          <label>
            <input
              type="checkbox"
              checked={showStream}
              onChange={(event) => setShowStream(event.target.checked)}
            />
            原始 SSE 分片
          </label>
          <span role="status">
            {loading
              ? "正在读取…"
              : current?.running
              ? "正在记录 · 每秒更新"
              : `${entries.length} 条记录`}
          </span>
        </div>
        {(error || warning || missingEnd) && (
          <div className="agent-log-error" role="status">
            {error ||
              warning ||
              "没有找到本轮结束记录，可能是服务或记录中断；已保留收到的通信。"}
          </div>
        )}
        <LogScrollArea key={selected} label="通信日志内容">
          {!turns.length && !loading && !error && (
            <div className="agent-log-empty">
              从更新后的下一轮对话开始记录。历史对话没有原始通信日志，不会补造。
            </div>
          )}
          {selected && !loading && !entries.length && !error && (
            <div className="agent-log-empty">
              暂无可读取的记录；若本轮已结束，请查看消息中的日志保存提示。
            </div>
          )}
          {entries
            .filter((entry) => showStream || entry.kind !== "model_stream")
            .map((entry) => (
              <LogEntry key={entry.sequence} entry={entry} />
            ))}
        </LogScrollArea>
        <p className="agent-log-location">
          保存在笔记目录的
          .chats/&lt;noteId&gt;/agent-logs/&lt;sessionId&gt;/&lt;turnId&gt;.jsonl。日志可能包含笔记正文和源码，下载后按会话资料保管。
        </p>
      </div>
    </Dialog>
  );
};

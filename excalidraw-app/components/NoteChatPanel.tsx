import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@excalidraw/excalidraw/components/Button";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";

import { NoteChatMarkdown } from "./NoteChatMarkdown";
import "./NoteChatPanel.scss";

import type { NoteChatController } from "../data/noteChats";

export const NoteChatPanel = ({
  controller,
}: {
  controller: NoteChatController;
}) => {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const { noteId, name } = state.context;
  const ui = noteId ? state.ui[noteId] : null;
  const selected = ui?.selected || null;
  const session =
    noteId && selected ? state.sessions[`${noteId}/${selected}`] : null;
  const list = noteId ? state.lists[noteId] || [] : [];
  const generating = Boolean(
    session?.messages.some((message) => message.status === "generating"),
  );
  const running = Boolean(
    noteId && selected && controller.isActive(noteId, selected),
  );
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [below, setBelow] = useState(false);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [title, setTitle] = useState("");
  const [copied, setCopied] = useState("");
  const error =
    (noteId && selected && state.errors[`${noteId}/${selected}`]) ||
    state.errors[noteId || "unbound"];
  const draft = selected ? ui?.drafts[selected] || "" : "";
  useEffect(() => {
    void controller.refresh();
  }, [controller]);
  useEffect(() => {
    if (noteId && selected) {
      controller.markRead(noteId, selected);
    }
  }, [controller, noteId, selected]);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) {
      return;
    }
    const top =
      noteId && selected ? state.ui[noteId]?.scrolls[selected] : undefined;
    node.scrollTop = top ?? node.scrollHeight;
    follow.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < 60;
    setBelow(!follow.current);
    setMenu(false);
    // Restore only on session change, not for every streaming state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, selected]);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && follow.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [session?.messages]);
  useEffect(() => {
    const ownerWindow = scroller.current?.ownerDocument.defaultView;
    if (!ownerWindow || !noteId) {
      return;
    }
    const refresh = () => {
      void controller.refresh(noteId);
    };
    ownerWindow.addEventListener("focus", refresh);
    const timer =
      generating && !running
        ? ownerWindow.setInterval(refresh, 2000)
        : undefined;
    return () => {
      ownerWindow.removeEventListener("focus", refresh);
      if (timer) {
        ownerWindow.clearInterval(timer);
      }
    };
  }, [controller, noteId, generating, running]);
  const lastUser = session?.messages
    .filter((message) => message.role === "user")
    .at(-1);
  const lastAnswer = session?.messages
    .filter((message) => message.role === "assistant")
    .at(-1);
  return (
    <section
      className="note-chat"
      aria-label="笔记聊天"
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="note-chat-header">
        <div>
          <h3>笔记聊天</h3>
          <p title={name || undefined}>
            {name || "保存笔记后，为它开启专属对话"}
          </p>
        </div>
        <Button
          onSelect={() => void controller.create()}
          disabled={state.busy}
          title="新建会话"
          aria-label="新建聊天会话"
        >
          ＋
        </Button>
      </header>
      {noteId && list.length > 0 && (
        <div className="note-chat-session-row">
          <select
            aria-label="聊天会话"
            value={selected || ""}
            onChange={(event) =>
              void controller.select(noteId, event.target.value)
            }
          >
            {list.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.generating ? "◌ " : ""}
                {entry.title}
                {ui?.unread?.[entry.id] ? " · 新回复" : ""}
              </option>
            ))}
          </select>
          <Button
            onSelect={() => setMenu(!menu)}
            aria-label="会话更多操作"
            aria-expanded={menu}
          >
            ···
          </Button>
          {menu && (
            <div className="note-chat-menu">
              <Button
                disabled={generating}
                onSelect={() => {
                  setTitle(session?.title || "");
                  setDialog("rename");
                  setMenu(false);
                }}
              >
                重命名
              </Button>
              <Button
                onSelect={() => {
                  setDialog("delete");
                  setMenu(false);
                }}
                disabled={generating}
              >
                删除会话
              </Button>
            </div>
          )}
        </div>
      )}
      <div
        className="note-chat-messages"
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          follow.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 60;
          setBelow(!follow.current);
          if (noteId && selected) {
            controller.saveScroll(noteId, selected, node.scrollTop);
          }
        }}
      >
        {!session?.messages.length && (
          <div className="note-chat-empty">
            <div className="note-chat-empty-mark" aria-hidden="true">
              ✦
            </div>
            <h4>围绕这篇笔记，慢慢展开</h4>
            <p>提问、梳理思路，或让 AI 解释画布中的某个部分。</p>
            <small>需要时 AI 才会阅读当前画布，不会修改笔记。</small>
            {!session && (
              <Button
                onSelect={() => void controller.create()}
                disabled={state.busy}
              >
                {state.busy ? "正在准备笔记…" : "开启第一个会话"}
              </Button>
            )}
          </div>
        )}
        {session?.messages.map((message) => (
          <article
            key={message.id}
            className={`note-chat-message note-chat-message--${message.role}`}
          >
            <div className="note-chat-author">
              {message.role === "user" ? "你" : "AI"}
              <span>
                {message.role === "assistant" &&
                  {
                    generating: "回答中",
                    stopped: "已停止",
                    interrupted: "已中断",
                    failed: "未完成",
                    complete: "",
                  }[message.status]}
              </span>
            </div>
            {!!message.activities?.length && (
              <details className="note-chat-reading">
                <summary>
                  {message.activities.some(
                    (activity) => activity.status === "reading",
                  )
                    ? "正在阅读当前笔记…"
                    : `阅读活动 ${message.activities.length} 次`}{" "}
                  · 发送时画布 ·{" "}
                  {new Date(
                    message.activities[0].snapshotAt,
                  ).toLocaleTimeString()}
                </summary>
                <p>基于发送时的画布快照，后续编辑不会改变本次阅读内容。</p>
                {message.activities.map((activity) => (
                  <div key={activity.id}>
                    <span>
                      {activity.summary ||
                        (
                          {
                            get_note_outline: "查看笔记目录",
                            search_note: "搜索笔记内容",
                            read_note_elements: "读取元素详情",
                          } as Record<string, string>
                        )[activity.name] ||
                        "阅读笔记"}
                    </span>
                    {activity.elementIds.map((id) => (
                      <code key={id} title={id}>
                        {id.slice(0, 8)}
                      </code>
                    ))}
                  </div>
                ))}
              </details>
            )}
            <NoteChatMarkdown
              content={
                message.content ||
                (message.status === "generating" ? "正在思考…" : "")
              }
            />
            {message.role === "assistant" && message.content && (
              <Button
                onSelect={async () => {
                  const ownerWindow =
                    scroller.current?.ownerDocument.defaultView;
                  try {
                    if (!ownerWindow?.navigator.clipboard) {
                      throw new Error();
                    }
                    await ownerWindow.navigator.clipboard.writeText(
                      message.content,
                    );
                    setCopied(message.id);
                  } catch {
                    setCopied(`failed:${message.id}`);
                  }
                }}
              >
                {copied === message.id
                  ? "已复制"
                  : copied === `failed:${message.id}`
                  ? "请选中文字复制"
                  : "复制回答"}
              </Button>
            )}
            {message.error && (
              <p className="note-chat-inline-error">{message.error}</p>
            )}
          </article>
        ))}
      </div>
      {below && (
        <Button
          className="note-chat-latest"
          onSelect={() => {
            const node = scroller.current;
            if (node) {
              follow.current = true;
              node.scrollTop = node.scrollHeight;
              setBelow(false);
            }
          }}
        >
          回到最新 ↓
        </Button>
      )}
      {(error || state.storageError) && (
        <div className="note-chat-error" role="status">
          {error || state.storageError}
          {error?.includes("复制笔记") && (
            <Button onSelect={() => void controller.create(true)}>
              为副本建立独立聊天身份
            </Button>
          )}
          {noteId && (
            <Button onSelect={() => void controller.refresh(noteId)}>
              重新加载会话
            </Button>
          )}
        </div>
      )}
      {session && noteId && selected && (
        <form
          className="note-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            follow.current = true;
            void controller.send(noteId, selected);
          }}
        >
          <textarea
            aria-label="聊天消息"
            placeholder="问问这篇笔记…"
            rows={3}
            maxLength={12000}
            value={draft}
            onChange={(event) =>
              controller.setDraft(noteId, selected, event.target.value)
            }
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                if (!running && !generating) {
                  follow.current = true;
                  void controller.send(noteId, selected);
                }
              }
            }}
          />
          <div className="note-chat-compose-actions">
            <small>Shift+Enter 换行</small>
            {running || generating ? (
              <Button onSelect={() => void controller.stop(noteId, selected)}>
                停止回答
              </Button>
            ) : (
              <Button
                className="note-chat-send"
                type="submit"
                onSelect={() => {}}
                disabled={
                  !draft.trim() || controller.isUnsaved(noteId, selected)
                }
              >
                发送 ↑
              </Button>
            )}
          </div>
          {lastAnswer &&
            lastAnswer.status !== "complete" &&
            lastAnswer.status !== "generating" &&
            lastUser &&
            !running && (
              <Button
                onSelect={() =>
                  void controller.send(noteId, selected, lastUser.id)
                }
              >
                重试最后一个问题
              </Button>
            )}
          <p className="note-chat-context-hint">
            按需阅读当前画布 · 最多使用最近 20 轮及上下文预算内的记录
          </p>
        </form>
      )}
      {dialog && session && noteId && (
        <Dialog
          title={dialog === "rename" ? "重命名会话" : "删除这个会话？"}
          size="small"
          onCloseRequest={() => setDialog(null)}
        >
          <div className="note-chat-dialog">
            {dialog === "rename" ? (
              <input
                aria-label="会话名称"
                value={title}
                maxLength={100}
                onChange={(event) => setTitle(event.target.value)}
              />
            ) : (
              <p>
                会话与消息将从本地删除，笔记画布不会受影响。此操作不可撤销。
              </p>
            )}
            <div>
              <Button onSelect={() => setDialog(null)}>取消</Button>
              <Button
                disabled={dialog === "rename" && !title.trim()}
                onSelect={() => {
                  if (dialog === "rename") {
                    void controller.rename(noteId, session.id, title);
                  } else {
                    void controller.remove(noteId, session.id);
                  }
                  setDialog(null);
                }}
              >
                {dialog === "rename" ? "保存名称" : "确认删除"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
};

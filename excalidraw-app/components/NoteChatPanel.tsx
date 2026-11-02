import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@excalidraw/excalidraw/components/Button";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import {
  checkIcon,
  copyIcon,
  pencilIcon,
  RetryIcon,
  brainIcon,
  BringForwardIcon,
  collapseDownIcon,
  playerStopFilledIcon,
  CloseIcon,
} from "@excalidraw/excalidraw/components/icons";

import { NoteChatMarkdown } from "./NoteChatMarkdown";
import { NoteChatReasoning } from "./NoteChatReasoning";
import { ChatWidgetCard } from "./ChatWidgetCard";
import { ChatWidgetBuildCard } from "./ChatWidgetBuildCard";
import { ChatHtmlCard } from "./ChatHtmlCard";
import { ChatIconButton } from "./ChatIconButton";
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
  const copyMessage = async (id: string, content: string) => {
    try {
      const clipboard =
        scroller.current?.ownerDocument.defaultView?.navigator.clipboard;
      if (!clipboard) {
        throw new Error("Clipboard unavailable");
      }
      await clipboard.writeText(content);
      setCopied(id);
    } catch {
      setCopied(`failed:${id}`);
    }
  };
  const [choosingWidget, setChoosingWidget] = useState(false);
  const [editing, setEditing] = useState<{
    id: string;
    content: string;
  } | null>(null);
  const [historyId, setHistoryId] = useState("");
  const visibleMessages = historyId
    ? session?.previousVersions?.find((version) => version.id === historyId)
        ?.messages || []
    : session?.messages || [];
  useEffect(() => {
    if (
      editing &&
      !session?.messages.some((message) => message.id === editing.id)
    ) {
      setEditing(null);
    }
  }, [session?.messages, editing]);
  const error =
    (noteId && selected && state.errors[`${noteId}/${selected}`]) ||
    state.errors[noteId || "unbound"];
  const draft = selected ? ui?.drafts[selected] || "" : "";
  const workspace = selected ? ui?.workspaces?.[selected] : undefined;
  const canvasWidgets = controller.htmlHost?.elements() || [];
  const latestVersions = new Map<string, number>();
  for (const message of session?.messages || []) {
    for (const ref of message.artifacts || []) {
      latestVersions.set(
        ref.artifactId,
        Math.max(latestVersions.get(ref.artifactId) || 0, ref.version),
      );
    }
  }
  useEffect(() => {
    void controller.refresh();
    void controller.checkClientVersion();
    const win = scroller.current?.ownerDocument.defaultView;
    const check = () => {
      void controller.checkClientVersion();
    };
    win?.addEventListener("focus", check);
    const timer = win?.setInterval(check, 60000);
    return () => {
      win?.removeEventListener("focus", check);
      win?.clearInterval(timer);
    };
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
    setEditing(null);
    setHistoryId("");
    // Restore only on session change, not for every streaming state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, selected]);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && follow.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [session?.messages, state.widgetBuilds]);
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
        {state.updateAvailable && (
          <div className="note-chat-inline-error" role="status">
            新版已就绪。输入草稿已保留；
            {generating ? (
              "请在回答结束后刷新。"
            ) : (
              <Button onSelect={() => controller.reloadForUpdate()}>
                刷新界面
              </Button>
            )}
          </div>
        )}
        {!session?.messages.length && (
          <div className="note-chat-empty">
            <div className="note-chat-empty-mark" aria-hidden="true">
              ✦
            </div>
            <h4>围绕这篇笔记，慢慢展开</h4>
            <p>讨论笔记，或描述一个可以直接操作的小应用。</p>
            <small>按需阅读画布；HTML 应用保存在聊天中。</small>
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
        {!!session?.previousVersions?.length && (
          <label className="note-chat-history">
            <span>对话版本</span>
            <select
              aria-label="对话版本"
              value={historyId}
              onChange={(event) => {
                setHistoryId(event.target.value);
                setEditing(null);
              }}
            >
              <option value="">当前版本</option>
              {session.previousVersions.map((version, index) => (
                <option key={version.id} value={version.id}>
                  历史版本 {index + 1} ·{" "}
                  {new Date(version.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
            {historyId && (
              <p>
                正在查看历史版本；原消息和应用均已保留。返回当前版本后可继续对话。
              </p>
            )}
          </label>
        )}
        {visibleMessages.map((message, messageIndex) => (
          <article
            key={message.id}
            className={`note-chat-message note-chat-message--${message.role}${
              editing?.id === message.id ? " note-chat-message--editing" : ""
            }`}
          >
            <div className="note-chat-message-content">
              <div className="note-chat-author">
                {message.role === "user" ? "你" : "AI"}
                <span>
                  {message.role === "assistant" &&
                    (message.artifacts?.length &&
                    message.status !== "generating" &&
                    message.status !== "complete"
                      ? "组件已保存"
                      : {
                          generating: "回答中",
                          stopped: "已停止",
                          interrupted: "已中断",
                          failed: "未完成",
                          complete: "",
                        }[message.status])}
                </span>
              </div>
              {editing?.id === message.id && (
                <div>
                  <textarea
                    className="note-chat-edit"
                    aria-label="编辑历史消息"
                    wrap="soft"
                    maxLength={12000}
                    value={editing.content}
                    onChange={(event) =>
                      setEditing({
                        id: message.id,
                        content: event.target.value,
                      })
                    }
                  />
                  <p className="note-chat-muted">
                    发送后从这里重新回答，原对话保留在历史版本中。
                  </p>
                  <div className="note-chat-message-actions">
                    <ChatIconButton
                      label="取消编辑"
                      icon={CloseIcon}
                      onClick={() => setEditing(null)}
                    />
                    <ChatIconButton
                      label="发送修改"
                      icon={checkIcon}
                      disabled={
                        !editing.content.trim() || generating || running
                      }
                      onClick={() => {
                        if (noteId && selected) {
                          void controller.send(noteId, selected, undefined, {
                            messageId: message.id,
                            content: editing.content,
                          });
                        }
                      }}
                    />
                  </div>
                </div>
              )}
              {message.blocks?.length === 0 &&
                message.status === "generating" && (
                  <p className="note-chat-muted">
                    {message.thinking ? "等待模型思考…" : "等待模型输出…"}
                  </p>
                )}
              {message.blocks?.map((block) => {
                if (block.type === "text") {
                  return (
                    <NoteChatMarkdown
                      key={block.id}
                      content={block.text.replace(
                        /\[HTML作品引用 ([\w-]+) v(\d+)\]/g,
                        (reference, id, version) =>
                          message.blocks?.some(
                            (entry) =>
                              entry.type === "html" &&
                              entry.ref.artifactId === id &&
                              entry.ref.version === Number(version),
                          )
                            ? reference
                            : `【此引用没有对应的应用卡片；模型尚未实际生成该作品：${id} v${version}】`,
                      )}
                    />
                  );
                }
                if (block.type === "reasoning") {
                  return <NoteChatReasoning key={block.id} text={block.text} />;
                }
                if (block.type === "tool") {
                  const activity = message.activities?.find(
                    (entry) => entry.id === block.activityId,
                  );
                  return (
                    <details key={block.id} className="note-chat-reading">
                      <summary>
                        {activity?.status === "reading"
                          ? "正在调用工具…"
                          : activity?.summary || "工具活动"}
                      </summary>
                      <p>{activity?.name}</p>
                      {activity?.details && <pre>{activity.details}</pre>}
                    </details>
                  );
                }
                if (block.type === "protocol") {
                  return (
                    <details key={block.id} className="note-chat-reading">
                      <summary>
                        {block.status === "correcting"
                          ? "调用未执行，正在纠正工具协议…"
                          : block.status === "resolved"
                          ? "未执行的调用已通过真实工具补正"
                          : "模型输出了未执行的工具调用"}
                      </summary>
                      <p>以下内容只是模型正文，不是实际操作记录。</p>
                      <pre className="note-chat-html-source">{block.text}</pre>
                    </details>
                  );
                }
                if (block.type === "edit_result") {
                  const current = block.application
                    ? controller.htmlHost?.read(block.application.elementId)
                    : null;
                  const applied =
                    current &&
                    current.appId === block.application?.appId &&
                    current.sourceHash === block.application?.sourceHash;
                  return (
                    <p
                      key={block.id}
                      className="note-chat-edit-result"
                      role="status"
                    >
                      {applied
                        ? /未完成|未执行/.test(block.text)
                          ? "该候选已应用到画布；本轮仍有未完成的后续操作"
                          : "该候选已应用到画布"
                        : block.text}
                    </p>
                  );
                }
                return noteId && selected ? (
                  <ChatHtmlCard
                    key={block.id}
                    block={block}
                    noteId={noteId}
                    sessionId={selected}
                    generating={message.status === "generating"}
                    controller={controller}
                    turnId={message.turnId}
                  />
                ) : null;
              })}
              {!message.blocks && !!message.activities?.length && (
                <details className="note-chat-reading">
                  <summary>
                    {message.activities.some(
                      (activity) => activity.status === "reading",
                    )
                      ? "正在调用工具…"
                      : `工具活动 ${message.activities.length} 次`}{" "}
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
                              create_widget_draft: "生成组件候选",
                              revise_widget_draft: "修改组件候选",
                              read_chat_widget: "读取聊天作品",
                            } as Record<string, string>
                          )[activity.name] ||
                          "阅读笔记"}
                      </span>
                      {activity.details && (
                        <details className="note-chat-tool-details">
                          <summary>查看错误详情</summary>
                          <pre>{activity.details}</pre>
                        </details>
                      )}
                      {activity.elementIds.map((id) => (
                        <code key={id} title={id}>
                          {id.slice(0, 8)}
                        </code>
                      ))}
                    </div>
                  ))}
                </details>
              )}
              {!message.blocks &&
                message.role === "assistant" &&
                message.reasoning && (
                  <NoteChatReasoning
                    label={
                      message.status === "generating" && !message.content
                        ? "正在思考…"
                        : "思考过程"
                    }
                    text={message.reasoning}
                  />
                )}
              {!message.blocks && (
                <NoteChatMarkdown
                  content={
                    message.content ||
                    (message.status === "generating" && !message.reasoning
                      ? message.thinking
                        ? "等待模型思考…"
                        : "正在生成回答…"
                      : "")
                  }
                />
              )}
              {Object.entries(state.widgetBuilds)
                .filter(
                  ([, build]) =>
                    build.noteId === noteId &&
                    build.sessionId === selected &&
                    build.turnId === message.turnId &&
                    message.role === "assistant",
                )
                .map(([key, build]) => (
                  <ChatWidgetBuildCard key={key} build={build} />
                ))}
              {noteId &&
                selected &&
                message.artifacts?.map((ref) => (
                  <ChatWidgetCard
                    key={`${ref.artifactId}:${ref.version}`}
                    controller={controller}
                    noteId={noteId}
                    sessionId={selected}
                    reference={ref}
                    latest={latestVersions.get(ref.artifactId) === ref.version}
                  />
                ))}
              {message.error && (
                <p className="note-chat-inline-error">
                  {message.artifacts?.length
                    ? `组件已保存，文字回复未完成：${message.error}`
                    : message.error}
                </p>
              )}
            </div>
            {message.role === "user" ? (
              <div className="note-chat-user-actions" aria-label="消息操作">
                <Button
                  className="note-chat-message-icon"
                  aria-label={copied === message.id ? "已复制消息" : "复制消息"}
                  title={
                    copied === message.id
                      ? "已复制"
                      : copied === `failed:${message.id}`
                      ? "复制失败，请选中文字复制"
                      : "复制消息"
                  }
                  onSelect={() => void copyMessage(message.id, message.content)}
                >
                  {copied === message.id ? checkIcon : copyIcon}
                </Button>
                {!historyId && noteId && selected && (
                  <Button
                    className="note-chat-message-icon"
                    aria-label="编辑消息"
                    title="编辑消息"
                    disabled={
                      generating || running || editing?.id === message.id
                    }
                    onSelect={() =>
                      setEditing({ id: message.id, content: message.content })
                    }
                  >
                    {pencilIcon}
                  </Button>
                )}
                {copied === `failed:${message.id}` && (
                  <span className="note-chat-copy-error" role="status">
                    复制失败，请选中文字复制
                  </span>
                )}
              </div>
            ) : (
              <div className="note-chat-message-actions">
                {!!message.content && (
                  <ChatIconButton
                    label={copied === message.id ? "已复制回答" : "复制回答"}
                    icon={copied === message.id ? checkIcon : copyIcon}
                    onClick={() =>
                      void copyMessage(message.id, message.content)
                    }
                  />
                )}
                {!historyId && noteId && selected && (
                  <ChatIconButton
                    label="重新生成"
                    icon={RetryIcon}
                    disabled={generating || running}
                    onClick={() => {
                      const question = visibleMessages
                        .slice(0, messageIndex)
                        .reverse()
                        .find((item) => item.role === "user");
                      if (question) {
                        void controller.send(noteId, selected, undefined, {
                          messageId: question.id,
                          content: question.content,
                        });
                      }
                    }}
                  />
                )}
                {copied === `failed:${message.id}` && (
                  <span role="status">复制失败，请选中文字复制</span>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
      {below && (
        <ChatIconButton
          label="回到最新"
          icon={collapseDownIcon}
          className="note-chat-latest"
          onClick={() => {
            const node = scroller.current;
            if (node) {
              follow.current = true;
              node.scrollTop = node.scrollHeight;
              setBelow(false);
            }
          }}
        />
      )}
      {(error || state.storageError) && (
        <div className="note-chat-error" role="status">
          {error || state.storageError}
          {error?.includes("复制笔记") && (
            <Button onSelect={() => void controller.create(true)}>
              为副本建立独立聊天身份
            </Button>
          )}
          {noteId &&
            (!lastAnswer?.artifacts?.length ||
              controller.isUnsaved(noteId, selected || "")) && (
              <Button onSelect={() => void controller.refresh(noteId)}>
                重新加载会话
              </Button>
            )}
        </div>
      )}
      {noteId && selected && state.widgetPhases[`${noteId}/${selected}`] && (
        <p className="note-chat-widget-phase" role="status">
          {state.widgetPhases[`${noteId}/${selected}`]}
        </p>
      )}
      {session && noteId && selected && !historyId && (
        <form
          className="note-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            follow.current = true;
            void controller.send(noteId, selected);
          }}
        >
          {workspace && (
            <div className="note-chat-workspace">
              <span>
                修改 ·{" "}
                {workspace.kind === "element"
                  ? `画布组件 · ${
                      canvasWidgets.find(
                        (item) => item.id === workspace.elementId,
                      )?.title || "目标已不存在"
                    }`
                  : `聊天作品 · v${workspace.version}`}
                {session.appWorkspace?.head &&
                  session.appWorkspace.generation ===
                    ui?.workspaceGenerations?.[selected] &&
                  session.appWorkspace.candidateNumber > 0 &&
                  ` · ${
                    session.appWorkspace.target
                      ? `正式版 v${session.appWorkspace.target.version} → `
                      : ""
                  }候选第 ${session.appWorkspace.candidateNumber} 版 · 未应用`}
              </span>
              <ChatIconButton
                label="更换目标或编辑起点"
                icon={pencilIcon}
                onClick={() => setChoosingWidget(!choosingWidget)}
              />
              <ChatIconButton
                label="移除当前创作目标"
                icon={CloseIcon}
                onClick={() => controller.setWorkspace(noteId, selected)}
              />
            </div>
          )}
          {choosingWidget && (
            <select
              aria-label="选择编辑起点"
              defaultValue=""
              onChange={(event) => {
                if (!event.target.value) {
                  return;
                }
                const ref = JSON.parse(event.target.value);
                controller.setWorkspace(noteId, selected, ref);
                setChoosingWidget(false);
              }}
            >
              <option value="">选择编辑起点（不会应用到画布）…</option>
              {session.appWorkspace?.target && (
                <option
                  value={JSON.stringify({
                    kind: "element",
                    elementId: session.appWorkspace.target.elementId,
                  })}
                >
                  从画布正式版重新开始
                </option>
              )}
              {[
                ...new Map(
                  session.messages.flatMap((m) =>
                    (m.blocks || []).flatMap((block) =>
                      block.type === "html" && block.complete && block.saved
                        ? [
                            [
                              `${block.ref.artifactId}/${block.ref.version}`,
                              block,
                            ] as const,
                          ]
                        : [],
                    ),
                  ),
                ).values(),
              ].map((block) => (
                <option
                  key={`${block.ref.artifactId}/${block.ref.version}`}
                  value={JSON.stringify(block.ref)}
                >
                  {block.candidateNumber
                    ? `候选第 ${block.candidateNumber} 版`
                    : `聊天作品 v${block.ref.version}`}{" "}
                  · {block.ref.artifactId.slice(0, 6)}
                </option>
              ))}
            </select>
          )}
          {selected && ui?.recoveries?.[selected] && (
            <div className="note-chat-workspace">
              <span>继续修正已选择的失败草稿（发送后开始）</span>
              <ChatIconButton
                label="取消草稿修正"
                icon={CloseIcon}
                onClick={() =>
                  controller.setWorkspace(noteId, selected, workspace)
                }
              />
            </div>
          )}
          {canvasWidgets.length > 0 && (!workspace || choosingWidget) && (
            <details className="note-chat-reference" open={choosingWidget}>
              <summary>引用画布组件</summary>
              <select
                aria-label="引用画布组件"
                value={workspace?.kind === "element" ? workspace.elementId : ""}
                onChange={(event) => {
                  if (event.target.value) {
                    setChoosingWidget(false);
                    controller.setWorkspace(noteId, selected, {
                      kind: "element",
                      elementId: event.target.value,
                    });
                  }
                }}
              >
                <option value="">选择要讨论或修改的组件…</option>
                {canvasWidgets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · {item.id.slice(0, 6)}
                  </option>
                ))}
              </select>
            </details>
          )}
          <textarea
            wrap="soft"
            aria-label="聊天消息"
            placeholder="讨论笔记，或描述想创建、修改的组件…"
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
            <ChatIconButton
              label={ui?.thinking ? "深度思考：已开启" : "深度思考：已关闭"}
              icon={brainIcon}
              active={ui?.thinking === true}
              aria-pressed={ui?.thinking === true}
              onClick={() =>
                controller.setThinking(noteId, ui?.thinking !== true)
              }
            />
            {running || generating ? (
              <ChatIconButton
                label="停止回答"
                icon={playerStopFilledIcon}
                primary
                onClick={() => void controller.stop(noteId, selected)}
              />
            ) : (
              <ChatIconButton
                label="发送消息"
                icon={BringForwardIcon}
                primary
                type="submit"
                disabled={
                  !draft.trim() || controller.isUnsaved(noteId, selected)
                }
              />
            )}
          </div>
          {lastAnswer &&
            lastAnswer.status !== "complete" &&
            lastAnswer.status !== "generating" &&
            lastUser &&
            !running && (
              <ChatIconButton
                label={
                  lastAnswer.artifacts?.length
                    ? "重试文字回复"
                    : "重试最后一个问题"
                }
                icon={RetryIcon}
                onClick={() =>
                  void controller.send(noteId, selected, lastUser.id)
                }
              />
            )}
          <p className="note-chat-context-hint">
            Shift+Enter 换行 · 按需阅读画布 · 最近 20 轮及上下文预算内记录
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

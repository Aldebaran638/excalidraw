import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@excalidraw/excalidraw/components/Button";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";

import { WidgetView } from "../../packages/interactive-widgets/WidgetView";
import { reconcileState } from "../../packages/interactive-widgets/schema";
import { definitionKey } from "../data/chatWidgets";

import type { ChatWidgetRef } from "../data/chatWidgets";
import type { NoteChatController } from "../data/noteChats";

export const ChatWidgetCard = ({
  controller,
  noteId,
  sessionId,
  reference,
  latest,
}: {
  controller: NoteChatController;
  noteId: string;
  sessionId: string;
  reference: ChatWidgetRef;
  latest: boolean;
}) => {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [open, setOpen] = useState(latest);
  const [version, setVersion] = useState(reference.version);
  const [expanded, setExpanded] = useState(false);
  const [original, setOriginal] = useState(false);
  const [trialInputs, setTrialInputs] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLElement>(null);
  const selected = { ...reference, version };
  const key = controller.artifactKey(noteId, sessionId, selected);
  const data = state.artifacts[key];
  const loadError = state.artifactErrors[key];
  useEffect(() => {
    if (!latest) {
      setOpen(false);
    }
  }, [latest]);
  useEffect(() => {
    if (open) {
      void controller.loadArtifact(noteId, sessionId, {
        ...reference,
        version,
      });
    }
  }, [controller, noteId, sessionId, reference, version, open]);
  const source = {
    noteId,
    sessionId,
    artifactId: reference.artifactId,
    version,
  };
  const placements = controller.widgetHost?.placements(source) || [];
  const live = data?.target
    ? controller.widgetHost?.read(data.target.elementId)
    : null;
  const applied = Boolean(
    data?.target &&
      placements.includes(data.target.elementId) &&
      live &&
      definitionKey(live.definition) ===
        definitionKey(data.document.definition),
  );
  const conflict = Boolean(
    data?.target &&
      (!live ||
        definitionKey(live.definition) !==
          definitionKey(data.target.baseDefinition)) &&
      !applied,
  );
  const reset =
    data?.target && live
      ? reconcileState(live, data.document.definition).reset
      : [];
  const originalDocument =
    data?.target?.baseDocument ||
    (data?.target
      ? {
          ...data.document,
          definition: data.target.baseDefinition,
          state: data.target.baseDefinition.initialState,
        }
      : null);
  const document = original ? originalDocument : data?.document;
  const runtime = data ? controller.runtimeForArtifact(key, data) : undefined;
  const view = (width: number) =>
    document &&
    data && (
      <div
        className="note-chat-widget-view"
        inert={original}
        style={{
          height: expanded
            ? "min(65vh, 720px)"
            : Math.min(420, data.region.height),
        }}
      >
        <WidgetView
          key={`${key}:${original}`}
          document={document}
          runtime={original ? undefined : runtime}
          width={width}
          onCommit={(value) => controller.commitTrial(key, value)}
          registerDraft={(flush) => () => {
            if (!original) {
              flush();
            }
          }}
        />
      </div>
    );
  return (
    <section
      ref={root}
      className="note-chat-widget"
      aria-label={`聊天组件：${reference.title}`}
    >
      <button
        type="button"
        className="note-chat-widget-heading"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>{data?.document.definition.title || reference.title}</span>
        <small>
          v{version} · {open ? "收起" : "展开试用"}
        </small>
      </button>
      {open && (
        <>
          {!data && (
            <p role="status">
              {loadError || "正在读取组件…"}
              {loadError && (
                <Button
                  onSelect={() =>
                    void controller.loadArtifact(noteId, sessionId, selected)
                  }
                >
                  重试读取
                </Button>
              )}
            </p>
          )}
          {data && (
            <>
              <div className="note-chat-widget-meta">
                <span>
                  {data.target ? "画布修改候选" : "聊天作品 · 未自动写入画布"}
                </span>
                <select
                  aria-label="组件版本"
                  value={version}
                  onChange={(event) => {
                    setVersion(Number(event.target.value));
                    controller.setWorkspace(noteId, sessionId, {
                      kind: "artifact",
                      artifactId: reference.artifactId,
                      version: Number(event.target.value),
                    });
                    setOriginal(false);
                    setError("");
                  }}
                >
                  {data.versions.map((entry) => (
                    <option key={entry.version} value={entry.version}>
                      v{entry.version} · {entry.title}
                    </option>
                  ))}
                </select>
              </div>
              <p className="note-chat-widget-summary">{data.summary}</p>
              {data.target && (
                <div className="note-chat-widget-compare">
                  <button
                    type="button"
                    aria-pressed={original}
                    onClick={() => setOriginal(true)}
                  >
                    原版
                  </button>
                  <button
                    type="button"
                    aria-pressed={!original}
                    onClick={() => setOriginal(false)}
                  >
                    候选
                  </button>
                </div>
              )}
              <div className="note-chat-widget-actions">
                <Button
                  onSelect={() =>
                    controller.setWorkspace(noteId, sessionId, {
                      kind: "artifact",
                      artifactId: data.artifactId,
                      version,
                    })
                  }
                >
                  继续修改
                </Button>
                <Button onSelect={() => setExpanded(true)}>放大试用</Button>
                <Button
                  disabled={Boolean(state.placing)}
                  onSelect={() => controller.placeArtifact(data)}
                >
                  {state.placing === key
                    ? "请在画布拖框…"
                    : placements.length
                    ? "再导入一份"
                    : "导入笔记"}
                </Button>
              </div>
              {!expanded && view(320)}
              {placements.length > 0 && (
                <small>此版本已在当前笔记放置 {placements.length} 处</small>
              )}
              {data.target && (
                <div className="note-chat-widget-apply">
                  <label>
                    <input
                      type="checkbox"
                      checked={trialInputs}
                      onChange={(event) => setTrialInputs(event.target.checked)}
                    />
                    同时采用试用输入
                  </label>
                  {reset.length > 0 && (
                    <p>应用时将重置不兼容输入：{reset.join("、")}</p>
                  )}
                  {conflict && (
                    <p role="status">
                      目标已删除或定义已变化。请引用当前组件重新生成，或将候选导入为新组件。
                    </p>
                  )}
                  <Button
                    disabled={conflict || applied}
                    onSelect={() => {
                      try {
                        controller.applyArtifact(data, trialInputs);
                        setError("");
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    {applied ? "已应用到目标组件" : "确认应用修改"}
                  </Button>
                </div>
              )}
              {(error || loadError) && (
                <div className="note-chat-inline-error" role="status">
                  {error || loadError}
                  {loadError && (
                    <>
                      <Button onSelect={() => void controller.saveTrial(key)}>
                        重试保存输入
                      </Button>
                      <Button
                        onSelect={() => {
                          const ownerWindow = scrollerWindow();
                          if (
                            ownerWindow?.confirm(
                              "放弃此版本未保存的试用输入，并重新读取已保存版本？",
                            )
                          ) {
                            void controller.discardTrial(key);
                          }
                        }}
                      >
                        重新读取保存版本
                      </Button>
                    </>
                  )}
                </div>
              )}
              {expanded && (
                <Dialog
                  title={`${data.document.definition.title} · v${version}`}
                  onCloseRequest={() => setExpanded(false)}
                  size={1000}
                >
                  <div className="note-chat-widget-expanded">
                    {view(900)}
                    <Button onSelect={() => setExpanded(false)}>
                      返回聊天
                    </Button>
                  </div>
                </Dialog>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
  function scrollerWindow() {
    return root.current?.ownerDocument.defaultView;
  }
};

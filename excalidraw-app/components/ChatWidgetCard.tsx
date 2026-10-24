import { useEffect, useState, useSyncExternalStore } from "react";

import { WidgetView } from "../../packages/interactive-widgets/WidgetView";

import type { ChatWidgetRef } from "../data/chatWidgets";
import type { NoteChatController } from "../data/noteChats";

/** Historic JSON artifacts are preserved as read-only records. */
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
  const key = controller.artifactKey(noteId, sessionId, reference);
  const data = state.artifacts[key];
  useEffect(() => {
    if (open) {
      void controller.loadArtifact(noteId, sessionId, reference);
    }
  }, [open, controller, noteId, sessionId, reference]);
  return (
    <section className="note-chat-widget">
      <button
        className="note-chat-widget-heading"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {reference.title} · v{reference.version} · 旧版只读
      </button>
      {open && (
        <>
          <p>旧 JSON 组件已退役，记录保留；新应用请在聊天中创建。</p>
          {data ? (
            <div
              inert
              style={{
                height: Math.min(420, data.region.height),
                overflow: "auto",
              }}
            >
              <WidgetView
                document={data.document}
                width={320}
                onCommit={() => {}}
              />
            </div>
          ) : (
            <p role="status">
              {state.artifactErrors[key] || "正在读取历史组件…"}
            </p>
          )}
        </>
      )}
    </section>
  );
};

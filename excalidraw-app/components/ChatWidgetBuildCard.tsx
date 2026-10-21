import { WidgetView } from "../../packages/interactive-widgets/WidgetView";

import type { ChatWidgetBuild } from "../data/noteChats";

export const ChatWidgetBuildCard = ({ build }: { build: ChatWidgetBuild }) => {
  const { progress, error } = build;
  const phase = error
    ? "生成未完成"
    : {
        waiting: "等待模型输出",
        generating: "生成中",
        repairing: "修复中",
        validating: "校验中",
      }[progress.phase];
  return (
    <section
      className="note-chat-widget note-chat-widget-build"
      aria-label="组件搭建预览"
    >
      <header>
        <strong>{progress.document?.definition.title || "正在搭建组件"}</strong>
        <span role="status">{phase}</span>
      </header>
      <p>临时布局预览 · 控件暂不可操作 · 完成校验并保存后才能导入</p>
      {progress.document ? (
        <div className="note-chat-widget-build-view" inert>
          <WidgetView
            document={progress.document}
            width={320}
            onCommit={() => {}}
          />
        </div>
      ) : (
        <p>
          {error
            ? "本次未收到可用的预览节点。"
            : progress.phase === "repairing"
            ? "正在修复定义，等待新的有效节点…"
            : "等待完整节点，内容将随真实生成逐步出现…"}
        </p>
      )}
      {error && (
        <p className="note-chat-inline-error">
          {error}。此预览尚未保存，刷新后不保留。
        </p>
      )}
    </section>
  );
};

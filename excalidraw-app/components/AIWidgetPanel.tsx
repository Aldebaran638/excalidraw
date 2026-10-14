import { WidgetView } from "../../packages/interactive-widgets/WidgetView";
import { EXAMPLES } from "../../packages/interactive-widgets/examples";

import "./AIWidgetPanel.scss";

import type { useAIWidgets } from "../hooks/useAIWidgets";

export const AIWidgetPanel = ({
  widgets,
  conflict,
  resolveConflict,
}: {
  widgets: ReturnType<typeof useAIWidgets>;
  conflict: string | null;
  resolveConflict: (choice: "discard" | "copy") => Promise<void>;
}) => {
  const w = widgets;
  return (
    <>
      {w.selected && !w.session && !w.expanded && (
        <div className="ai-widget-actions" data-widget-interactive="true">
          <button onClick={() => w.edit()}>AI 修改</button>
          <button onClick={w.enter}>进入交互</button>
          <button onClick={() => w.setExpanded(w.selected!.id)}>
            放大操作
          </button>
          <button onClick={w.expandHeight}>展开完整内容</button>
          <button onClick={w.resetSelected}>重置输入</button>
        </div>
      )}
      {w.session && (
        <aside
          className="ai-widget-panel"
          aria-label="AI 组件"
          data-widget-interactive="true"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <header>
            <strong>
              {w.session.target ? "AI 修改组件" : "生成 AI 组件群"}
            </strong>
            <button onClick={w.close} aria-label="关闭">
              ×
            </button>
          </header>
          <p>
            描述你想实现的内容和交互。组件布局由 AI 修改，内部控件可直接操作。
          </p>
          <textarea
            aria-label="组件要求"
            placeholder="例如：用可点击卡片解释 Kubernetes 架构，点击节点更新下方说明…"
            value={w.prompt}
            onChange={(e) => w.setPrompt(e.target.value)}
            rows={5}
          />
          <div>
            <button onClick={w.addContext}>添加画布选中的文字/矩阵</button>
          </div>
          {w.context.map((item) => (
            <div className="ai-widget-context" key={item.id}>
              <span title={item.content}>{item.label}</span>
              <button
                aria-label={`移除 ${item.label}`}
                onClick={() => w.removeContext(item.id)}
              >
                ×
              </button>
            </div>
          ))}
          <label>
            <input
              type="checkbox"
              checked={w.confirmChanges}
              onChange={(e) => w.changeConfirmation(e.target.checked)}
            />{" "}
            AI 修改应用前确认
          </label>
          {w.phase ? (
            <div role="status">
              {w.phase}
              <button onClick={w.cancel}>取消生成</button>
            </div>
          ) : (
            <button
              className="ai-widget-primary"
              disabled={!w.prompt.trim()}
              onClick={() => void w.generate()}
            >
              用 Qwen 生成
            </button>
          )}
          {w.model && (
            <small>
              {w.model.available ? "● 已连接 " : "○ 未连接 "}
              {w.model.model}
            </small>
          )}
          {w.error && (
            <p role="alert" className="ai-widget-error">
              {w.error}
            </p>
          )}
          {w.preview && (
            <section>
              <h4>可交互预览</h4>
              <p>{w.explanation}</p>
              <div className="ai-widget-preview">
                <WidgetView
                  document={w.preview}
                  width={320}
                  onCommit={(state) =>
                    w.setPreview((prev) => (prev ? { ...prev, state } : prev))
                  }
                />
              </div>
              <button
                className="ai-widget-primary"
                onClick={() => w.applyPreview(w.preview!)}
              >
                {w.session.target ? "应用修改" : "放入笔记"}
              </button>
            </section>
          )}
          <details>
            <summary>离线示例</summary>
            <p>这些示例用于试用组件库，不会调用 AI。</p>
            {Object.entries(EXAMPLES).map(([key, def]) => (
              <button key={key} onClick={() => w.loadExample(def)}>
                {def.title}
              </button>
            ))}
          </details>
        </aside>
      )}
      {w.expanded && w.expandedDocument && (
        <div
          className="ai-widget-modal"
          role="dialog"
          aria-modal="true"
          aria-label="放大操作"
          data-widget-interactive="true"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <header>
            <strong>{w.expandedDocument.definition.title}</strong>
            <button onClick={() => w.setExpanded(null)}>关闭</button>
          </header>
          <WidgetView
            document={w.expandedDocument}
            width={720}
            onCommit={w.expandedCommit}
            onDraft={w.expandedDraft}
            registerDraft={w.registerExpandedDraft}
            onExit={() => w.setExpanded(null)}
          />
        </div>
      )}
      {conflict && (
        <div
          className="ai-widget-conflict"
          role="alertdialog"
          aria-label="本地文件更新冲突"
          data-widget-interactive="true"
        >
          <p>{conflict} 在本地有更新。你的当前画布和草稿尚未覆盖。</p>
          <button
            onClick={() => {
              w.flushDrafts();
              void resolveConflict("copy");
            }}
          >
            先保留画布为副本
          </button>
          <button
            onClick={() => {
              w.discardDrafts();
              void resolveConflict("discard");
            }}
          >
            放弃草稿并加载本地版本
          </button>
        </div>
      )}
    </>
  );
};

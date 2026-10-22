import { useState } from "react";

import { Button as EditorButton } from "../../packages/excalidraw/components/Button";

import { Dialog } from "../../packages/excalidraw/components/Dialog";
import { WidgetView } from "../../packages/interactive-widgets/WidgetView";
import { EXAMPLES } from "../../packages/interactive-widgets/examples";
import {
  ARCHITECTURE,
  WORKFLOW,
  SCENARIO,
} from "../../packages/interactive-widgets/designExamples";

import "./AIWidgetPanel.scss";

import type { useAIWidgets } from "../hooks/useAIWidgets";

const Button = ({
  children,
  onSelect: _onSelect,
  ...props
}: React.ComponentProps<"button">) => (
  <EditorButton onSelect={() => {}} {...props}>
    {children}
  </EditorButton>
);

export const AIWidgetPanel = ({
  widgets: w,
  conflict,
  resolveConflict,
  onChatEdit,
  recoveryConflict,
}: {
  widgets: ReturnType<typeof useAIWidgets>;
  conflict: string | null;
  resolveConflict: (choice: "discard" | "copy") => Promise<void>;
  onChatEdit?: (elementId: string) => void;
  recoveryConflict?: boolean;
}) => {
  const [contentHeight, setContentHeight] = useState(0);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const region = w.regionBounds;
  const selected = w.selectedBounds;
  const visibleDocument = w.showOriginal ? w.original : w.preview;
  const anchor = region || selected;
  const panelLeft = anchor
    ? anchor.left + anchor.width + 332 < w.viewportSize.width
      ? anchor.left + anchor.width + 12
      : Math.max(12, anchor.left - 332)
    : 12;
  const panelTop = Math.max(
    80,
    Math.min(region?.top || 80, w.viewportSize.height - 520),
  );
  const toolbarPosition = selected
    ? {
        left: Math.max(12, Math.min(selected.left, w.viewportSize.width - 260)),
        top: Math.max(
          76,
          Math.min(selected.top - 52, w.viewportSize.height - 60),
        ),
      }
    : undefined;
  const commitPreview = (state: NonNullable<typeof w.preview>["state"]) =>
    w.setPreview((previous) => (previous ? { ...previous, state } : previous));
  return (
    <>
      {w.selected && !w.session && !w.expanded && (
        <div
          className="ai-widget-actions"
          style={toolbarPosition}
          data-widget-interactive="true"
        >
          <Button onClick={() => w.edit()}>AI 修改</Button>
          <Button onClick={() => w.setExpanded(w.selected!.id)}>放大</Button>
          <details className="ai-widget-more">
            <summary aria-label="组件更多操作">···</summary>
            <div>
              {onChatEdit && (
                <Button onClick={() => onChatEdit(w.selected!.id)}>
                  在聊天中修改
                </Button>
              )}
              <Button onClick={w.expandHeight}>展开完整内容</Button>
              <Button onClick={w.resetSelected}>重置输入</Button>
            </div>
          </details>
        </div>
      )}
      {w.session && region && (
        <>
          <div
            className="ai-widget-region"
            style={{
              left: region.left,
              top: region.top,
              width: region.width,
              height: region.height,
            }}
          >
            <span className="ai-widget-region-label">
              {w.session.target
                ? w.showOriginal
                  ? "原版 · 只读"
                  : "候选预览 · 尚未应用"
                : "创作草稿 · 尚未放入笔记"}
            </span>
            {visibleDocument ? (
              <div
                className="ai-widget-canvas-preview"
                data-embeddable-interaction="controls"
                style={{
                  width: w.session.region.width,
                  height: w.session.region.height,
                  transform: `scale(${region.zoom})`,
                }}
              >
                <div inert={w.showOriginal} style={{ height: "100%" }}>
                  <WidgetView
                    document={visibleDocument}
                    runtime={w.showOriginal ? undefined : w.previewRuntime}
                    width={w.session.region.width}
                    onCommit={commitPreview}
                    onLayout={setContentHeight}
                  />
                </div>
              </div>
            ) : (
              !w.session.target && (
                <div className="ai-widget-region-empty">
                  在旁边描述想法
                  <br />
                  <small>这里将出现可直接操作的预览</small>
                </div>
              )
            )}
          </div>
          {w.collapsed ? (
            <Button
              className="ai-widget-resume"
              style={{
                left: Math.max(12, region.left),
                top: Math.max(80, region.top - 48),
              }}
              onClick={() => w.setCollapsed(false)}
            >
              {w.phase ? "生成中 · " : ""}继续创作
            </Button>
          ) : (
            <aside
              className="ai-widget-panel"
              style={{
                left: panelLeft,
                top: panelTop,
                maxHeight: Math.max(180, w.viewportSize.height - panelTop - 16),
              }}
              aria-label="AI 组件创作"
              data-widget-interactive="true"
              onKeyDown={(event) => event.stopPropagation()}
            >
              <header>
                <strong>{w.session.target ? "修改组件" : "创建组件"}</strong>
                <Button
                  onClick={() => w.setCollapsed(true)}
                  aria-label="收起创作面板"
                >
                  —
                </Button>
              </header>
              <p className="ai-widget-hint">
                {w.preview
                  ? "直接试用画布上的候选，继续描述想改的地方。"
                  : "把想法变成可以操作的小工具。"}
              </p>
              <textarea
                aria-label="组件要求"
                placeholder={
                  w.preview
                    ? "例如：点击节点时突出显示关联路径…"
                    : "例如：画出 Kubernetes 架构，点击节点查看解释…"
                }
                value={w.prompt}
                onChange={(event) => w.setPrompt(event.target.value)}
                rows={4}
              />
              {w.phase ? (
                <div className="ai-widget-phase" role="status">
                  <span>{w.phase}</span>
                  <Button onClick={w.cancel}>取消</Button>
                </div>
              ) : (
                <Button
                  className="ai-widget-primary"
                  disabled={!w.prompt.trim()}
                  onClick={() => void w.generate()}
                >
                  {w.preview ? "生成下一候选" : "生成组件"}
                </Button>
              )}
              {w.error && (
                <p role="alert" className="ai-widget-error">
                  {w.error}
                </p>
              )}
              {w.storageError && (
                <p role="status" className="ai-widget-error">
                  {w.storageError}
                </p>
              )}
              {w.preview && (
                <section className="ai-widget-review">
                  <div className="ai-widget-compare">
                    {w.original && (
                      <>
                        <Button
                          aria-pressed={w.showOriginal}
                          onClick={() => w.setShowOriginal(true)}
                        >
                          原版
                        </Button>
                        <Button
                          aria-pressed={!w.showOriginal}
                          onClick={() => w.setShowOriginal(false)}
                        >
                          候选版
                        </Button>
                      </>
                    )}
                    <Button
                      disabled={w.candidateIndex <= 0 || !!w.phase}
                      onClick={w.previousCandidate}
                    >
                      上一候选
                    </Button>
                    <small>
                      {w.candidateIndex + 1} / {w.candidates.length}
                    </small>
                  </div>
                  {w.explanation && (
                    <p className="ai-widget-hint">{w.explanation}</p>
                  )}
                  {contentHeight > w.session.region.height + 4 && (
                    <div className="ai-widget-overflow">
                      <span>内容超出区域，可在预览内滚动</span>
                      <div>
                        <Button onClick={() => w.expandPreview(contentHeight)}>
                          展开高度
                        </Button>
                        <Button onClick={() => setPreviewExpanded(true)}>
                          放大阅读
                        </Button>
                      </div>
                    </div>
                  )}
                  {w.session.target && (
                    <label className="ai-widget-trial">
                      <input
                        type="checkbox"
                        checked={w.applyTrialInputs}
                        onChange={(event) =>
                          w.setApplyTrialInputs(event.target.checked)
                        }
                      />
                      同时采用试用输入
                    </label>
                  )}
                  {!!w.resetList.length && (
                    <p role="status">
                      将重置不兼容输入：{w.resetList.join("、")}
                    </p>
                  )}
                  <Button
                    className="ai-widget-primary"
                    disabled={!!w.phase}
                    onClick={() => w.applyPreview(w.preview!)}
                  >
                    {w.session.target ? "确认应用修改" : "放入笔记"}
                  </Button>
                </section>
              )}
              <details>
                <summary>
                  笔记上下文
                  {w.context.length ? ` · ${w.context.length}` : "（可选）"}
                </summary>
                <p className="ai-widget-hint">
                  默认不发送笔记。选中画布文字或矩阵后手动添加。
                </p>
                <Button onClick={w.addContext}>添加选中内容</Button>
                {w.context.map((item) => (
                  <div className="ai-widget-context" key={item.id}>
                    <span title={item.content}>{item.label}</span>
                    <Button
                      aria-label={`移除 ${item.label}`}
                      onClick={() => w.removeContext(item.id)}
                    >
                      ×
                    </Button>
                  </div>
                ))}
              </details>
              <details>
                <summary>从示例开始</summary>
                <p className="ai-widget-hint">
                  选择后仅填入要求，不会自动请求 AI。
                </p>
                {[
                  [
                    "架构讲解",
                    "画出 Kubernetes 控制平面、工作节点、Pod 和服务关系，点击节点解释并高亮关联路径",
                  ],
                  [
                    "流程联动",
                    "创建请求处理流程，展示排队、处理、返回与失败重试，点击步骤查看说明",
                  ],
                  [
                    "计算与数据",
                    "创建可调参数的矩阵变换工具，输入矩阵并展示变换结果",
                  ],
                ].map(([name, text]) => (
                  <Button key={name} onClick={() => w.setPrompt(text)}>
                    {name}
                  </Button>
                ))}
                <details>
                  <summary>离线试用组件库</summary>
                  {Object.values({
                    ARCHITECTURE,
                    WORKFLOW,
                    SCENARIO,
                    ...Object.fromEntries(
                      Object.entries(EXAMPLES).filter(
                        ([name]) => name !== "kubernetes",
                      ),
                    ),
                  }).map((definition) => (
                    <Button
                      key={definition.title}
                      onClick={() => w.loadExample(definition)}
                    >
                      {definition.title}
                    </Button>
                  ))}
                </details>
              </details>
              <footer>
                <small>
                  {w.storageError
                    ? "草稿仅在当前会话保留"
                    : "草稿自动保存在此浏览器"}
                </small>
                <Button onClick={w.close}>放弃草稿</Button>
              </footer>
            </aside>
          )}
        </>
      )}
      {!w.session && !!w.recovery.length && (
        <Button
          className="ai-widget-recovery"
          onClick={() => w.recover(w.recovery[0])}
        >
          恢复未完成的组件草稿
        </Button>
      )}
      {previewExpanded && w.preview && (
        <Dialog
          title={
            <span className="ai-widget-dialog-title">
              放大试用 · 尚未应用
              <Button
                aria-label="关闭放大试用"
                onClick={() => setPreviewExpanded(false)}
              >
                关闭
              </Button>
            </span>
          }
          size="wide"
          onCloseRequest={() => setPreviewExpanded(false)}
        >
          <div className="ai-widget-expanded">
            <WidgetView
              document={w.preview}
              runtime={w.previewRuntime}
              width={960}
              onCommit={commitPreview}
            />
          </div>
        </Dialog>
      )}
      {w.expanded && w.expandedDocument && (
        <Dialog
          title={
            <span className="ai-widget-dialog-title">
              {w.expandedDocument.definition.title}
              <Button
                aria-label="关闭放大操作"
                onClick={() => w.setExpanded(null)}
              >
                关闭
              </Button>
            </span>
          }
          size="wide"
          onCloseRequest={() => w.setExpanded(null)}
        >
          <div className="ai-widget-expanded">
            <WidgetView
              document={w.expandedDocument}
              runtime={w.expandedRuntime}
              width={960}
              onCommit={w.expandedCommit}
              onDraft={w.expandedDraft}
              registerDraft={w.registerExpandedDraft}
              onExit={() => w.setExpanded(null)}
            />
          </div>
        </Dialog>
      )}
      {conflict && (
        <div
          className="ai-widget-conflict"
          role="alertdialog"
          aria-label="本地文件更新冲突"
          data-widget-interactive="true"
        >
          <p>
            {recoveryConflict
              ? `${conflict} 已恢复读取，但当前画布有未保存的修改。请选择保留副本或加载文件版本。`
              : `${conflict} 在本地有更新。你的当前画布和草稿尚未覆盖。`}
          </p>
          <Button
            onClick={() => {
              w.flushDrafts();
              void resolveConflict("copy");
            }}
          >
            先保留画布为副本
          </Button>
          <Button
            onClick={() => {
              w.discardDrafts();
              void resolveConflict("discard");
            }}
          >
            放弃草稿并加载本地版本
          </Button>
        </div>
      )}
    </>
  );
};

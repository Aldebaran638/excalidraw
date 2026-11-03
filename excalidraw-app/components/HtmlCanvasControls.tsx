import { Button } from "@excalidraw/excalidraw/components/Button";

import { CanvasActionHint } from "./CanvasActionHint";

import type { useCanvasHtmlApps } from "../hooks/useCanvasHtmlApps";

/** Only temporary creation UI and repository conflicts; the chat owns creation. */
export const HtmlCanvasControls = ({
  widgets,
  conflict,
  recoveryConflict,
  resolveConflict,
}: {
  widgets: ReturnType<typeof useCanvasHtmlApps>;
  conflict: string | null;
  recoveryConflict?: boolean;
  resolveConflict: (choice: "copy" | "discard") => Promise<void>;
}) => (
  <>
    {widgets.regionBounds && (
      <div className="html-app-reserved-region" style={widgets.regionBounds}>
        <span>创作区域 · 尚未放入笔记</span>
      </div>
    )}
    {(widgets.region || widgets.placing) && (
      <CanvasActionHint
        message={
          widgets.placing ? "拖框放置应用" : "区域已预留，可在聊天中生成并导入"
        }
        cancelLabel={widgets.placing ? "取消放置" : "取消预留区域"}
        onCancel={widgets.cancelRegion}
      />
    )}
    {conflict && (
      <div
        className="repository-note-conflict ai-widget-conflict"
        role="alertdialog"
        aria-label="本地笔记冲突"
      >
        <p>
          {recoveryConflict
            ? "原笔记已恢复，但画布上有本地修改。请选择如何保留内容。"
            : "本地文件已更新，请先处理未应用的编辑，避免覆盖。"}
        </p>
        <Button onSelect={() => void resolveConflict("copy")}>
          先保留画布为副本
        </Button>
        <Button onSelect={() => void resolveConflict("discard")}>
          放弃草稿并加载本地版本
        </Button>
      </div>
    )}
  </>
);

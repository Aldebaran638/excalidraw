import { useRef, useState } from "react";
import { RIGHT_SIDEBAR_WIDTH } from "@excalidraw/excalidraw/components/App.viewport";

export const SIDEBAR_MIN_WIDTH = 328;
export const SIDEBAR_MAX_WIDTH = 800;
export const sidebarWidthLimit = (editorWidth: number) =>
  Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, editorWidth - 280));

/** A host-owned resize control; the editor still owns shell geometry. */
export const SidebarResizeHandle = ({
  width,
  onResize,
}: {
  width: number;
  onResize: (width: number) => void;
}) => {
  const drag = useRef<{ x: number; width: number; direction: number } | null>(
    null,
  );
  const [resizing, setResizing] = useState(false);
  return (
    <div
      className="app-sidebar-resize-handle"
      role="separator"
      aria-label="调整侧栏宽度"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      data-resizing={resizing || undefined}
      title="拖动调整宽度，双击恢复默认"
      onDoubleClick={() => onResize(RIGHT_SIDEBAR_WIDTH)}
      onKeyDown={(event) => {
        const rtl =
          event.currentTarget.ownerDocument.documentElement.dir === "rtl";
        const step = event.shiftKey ? 40 : 16;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          onResize(
            width + ((event.key === "ArrowLeft") !== rtl ? step : -step),
          );
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          event.stopPropagation();
          onResize(
            event.key === "Home" ? SIDEBAR_MIN_WIDTH : SIDEBAR_MAX_WIDTH,
          );
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          x: event.clientX,
          width,
          direction:
            event.currentTarget.ownerDocument.documentElement.dir === "rtl"
              ? 1
              : -1,
        };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (drag.current) {
          event.stopPropagation();
          onResize(
            drag.current.width +
              (event.clientX - drag.current.x) * drag.current.direction,
          );
        }
      }}
      onPointerUp={(event) => {
        if (drag.current) {
          event.stopPropagation();
          drag.current = null;
          setResizing(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setResizing(false);
      }}
    />
  );
};

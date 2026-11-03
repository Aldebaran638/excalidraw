import "./CanvasActionHint.scss";

import type { KeyboardEvent } from "react";

const keepActivationLocal = (event: KeyboardEvent<HTMLButtonElement>) => {
  // Keep native button activation; Space must not start the canvas pan tool.
  if (event.key === " " || event.key === "Enter") {
    event.stopPropagation();
  }
};

/** Persistent canvas-mode guidance; transient results still use native Toast. */
export const CanvasActionHint = ({
  message,
  cancelLabel,
  onCancel,
}: {
  message: string;
  cancelLabel: string;
  onCancel: () => void;
}) => (
  <div className="canvas-action-hint">
    <div className="canvas-action-hint__content">
      <span className="canvas-action-hint__message" role="status">
        {message}
      </span>
      <span className="canvas-action-hint__shortcut">
        <kbd>Esc</kbd>
      </span>
      <button
        type="button"
        className="canvas-action-hint__cancel"
        aria-label={cancelLabel}
        onClick={onCancel}
        onKeyDown={keepActivationLocal}
        onKeyUp={keepActivationLocal}
      >
        取消
      </button>
    </div>
  </div>
);

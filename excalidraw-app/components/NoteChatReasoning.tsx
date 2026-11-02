import { collapseDownIcon } from "@excalidraw/excalidraw/components/icons";

/** Native disclosure semantics, with a header bounded by this reasoning block. */
export const NoteChatReasoning = ({
  text,
  label = "思考过程",
}: {
  text: string;
  label?: string;
}) => (
  <details className="note-chat-reasoning">
    <summary
      title="展开或收起思考过程"
      onClick={(event) => {
        const summary = event.currentTarget;
        const details = summary.parentElement as HTMLDetailsElement;
        const scroller = summary.closest<HTMLElement>(".note-chat-messages");
        if (
          !details.open ||
          !scroller ||
          details.getBoundingClientRect().top >=
            scroller.getBoundingClientRect().top
        ) {
          return;
        }
        // A sticky header may be thousands of pixels below its original spot.
        // Collapse and anchor it synchronously; native clamping alone jumps to
        // an unrelated later message. Only the chat scroller is adjusted.
        event.preventDefault();
        const top =
          scroller.scrollTop +
          details.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top;
        details.open = false;
        scroller.scrollTop = Math.max(0, top - 8);
        summary.focus({ preventScroll: true });
      }}
    >
      <span>{label}</span>
      <span className="note-chat-reasoning-chevron" aria-hidden="true">
        {collapseDownIcon}
      </span>
    </summary>
    <div>{text}</div>
  </details>
);

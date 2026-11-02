import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { NoteChatReasoning } from "../components/NoteChatReasoning";

afterEach(cleanup);

it("anchors a scrolled reasoning collapse inside the chat without changing its text", () => {
  const text = "很长的思考内容\n".repeat(200);
  const view = render(
    <div className="note-chat-messages">
      <NoteChatReasoning text={text} />
    </div>,
  );
  const scroller = view.container.firstElementChild as HTMLElement;
  const details = scroller.querySelector("details")!;
  const summary = details.querySelector("summary")!;
  details.open = true;
  scroller.scrollTop = 1200;
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
    top: 100,
  } as DOMRect);
  vi.spyOn(details, "getBoundingClientRect").mockReturnValue({
    top: -800,
  } as DOMRect);
  const focus = vi.spyOn(summary, "focus");
  const ownerWindow = summary.ownerDocument.defaultView!;
  const click = new ownerWindow.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  fireEvent(summary, click);
  expect(click.defaultPrevented).toBe(true);
  expect(details.open).toBe(false);
  expect(scroller.scrollTop).toBe(292);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(details.querySelector("div")?.textContent).toBe(text);
});

it("leaves ordinary disclosure clicks to native keyboard/pointer semantics", () => {
  const view = render(
    <div className="note-chat-messages">
      <NoteChatReasoning text="内容" label="正在思考…" />
    </div>,
  );
  const summary = view.getByText("正在思考…").closest("summary")!;
  const ownerWindow = summary.ownerDocument.defaultView!;
  const click = new ownerWindow.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  fireEvent(summary, click);
  expect(click.defaultPrevented).toBe(false);
});

it("keeps the same disclosure open while streaming text updates", () => {
  const view = render(<NoteChatReasoning text="第一段" />);
  const details = view.container.querySelector("details")!;
  details.open = true;
  view.rerender(<NoteChatReasoning text={"第一段\n新增内容"} />);
  expect(view.container.querySelector("details")).toBe(details);
  expect(details.open).toBe(true);
  expect(details.querySelector("div")?.textContent).toBe("第一段\n新增内容");
});

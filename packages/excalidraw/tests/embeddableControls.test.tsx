import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  controlsAncestor,
  embeddedControlsCanScroll,
  observeEmbeddedPinch,
} from "../embeddableControls";

describe("generic embedded controls routing", () => {
  it("consumes only wheel movement that a local scroller can handle", () => {
    const { container } = render(
      <div data-embeddable-interaction="controls">
        <div style={{ overflowY: "auto" }} />
      </div>,
    );
    const root = container.firstElementChild as HTMLElement;
    const child = root.firstElementChild as HTMLElement;
    const ownerWindow = root.ownerDocument.defaultView as Window &
      typeof globalThis;
    Object.defineProperties(child, {
      scrollHeight: { value: 100 },
      clientHeight: { value: 40 },
    });
    const event = new ownerWindow.WheelEvent("wheel", { deltaY: 20 });
    Object.defineProperty(event, "target", { value: child });
    expect(controlsAncestor(child, ownerWindow)).toBe(root);
    expect(embeddedControlsCanScroll(event, root, ownerWindow)).toBe(true);
    child.scrollTop = 60;
    expect(embeddedControlsCanScroll(event, root, ownerWindow)).toBe(false);
    root.removeAttribute("data-embeddable-interaction");
    expect(controlsAncestor(child, ownerWindow)).toBeNull();
  });
  it("routes real touch events through one pinch session, suppressing accidental clicks", () => {
    const { container } = render(
      <div>
        <div data-embeddable-interaction="controls" />
      </div>,
    );
    const root = container.firstElementChild as HTMLElement;
    const child = root.firstElementChild as HTMLElement;
    const ownerWindow = root.ownerDocument.defaultView as Window &
      typeof globalThis;
    const onPinch = vi.fn();
    const dispose = observeEmbeddedPinch(root, () => true, onPinch);
    const touch = (
      type: string,
      points: { clientX: number; clientY: number }[],
    ) => {
      const event = new ownerWindow.Event(type, {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "touches", { value: points });
      child.dispatchEvent(event);
    };
    touch("touchstart", [{ clientX: 0, clientY: 0 }]);
    expect(onPinch).not.toHaveBeenCalled();
    touch("touchstart", [
      { clientX: 0, clientY: 0 },
      { clientX: 100, clientY: 0 },
    ]);
    touch("touchmove", [
      { clientX: 0, clientY: 0 },
      { clientX: 200, clientY: 0 },
    ]);
    expect(onPinch).toHaveBeenCalledWith(2, { x: 50, y: 0 }, { x: 100, y: 0 });
    touch("touchend", []);
    expect(root.hasAttribute("data-embeddable-pinch")).toBe(false);
    const click = new ownerWindow.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    child.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    dispose();
  });
});

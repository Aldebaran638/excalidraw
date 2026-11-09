import { describe, expect, it, vi } from "vitest";

import { installHtmlCanvasDrag } from "../data/htmlCanvasDrag";

describe("canvas HTML drag hit rules", () => {
  const check = (
    html: string,
    selector: string,
    expected: boolean,
    touch = false,
  ) => {
    // Use a mounted document with a real defaultView.
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.append(root);
    const drag = installHtmlCanvasDrag(document, vi.fn());
    drag.setEnabled(true);
    expect(drag.canDrag(root.querySelector(selector), 2, 2, touch)).toBe(
      expected,
    );
    drag.setEnabled(false);
    expect(drag.canDrag(root.querySelector(selector), 2, 2, touch)).toBe(false);
    drag.dispose();
    root.remove();
  };
  it("allows undecorated card padding", () =>
    check(
      '<section id="card" style="padding:20px"><button>开始</button></section>',
      "#card",
      true,
    ));
  it.each(["button", "input", "textarea", "select", "canvas"])(
    "protects %s",
    (tag) => check(`<${tag} id="target"></${tag}>`, "#target", false),
  );
  it("protects delegated ARIA and explicitly interactive descendants", () =>
    check(
      '<div data-note-drag-handle><div role="button"><span id="target"></span></div></div>',
      "#target",
      false,
    ));
  it("explicit interactive wins over drag handle", () =>
    check(
      '<div data-note-interactive><div data-note-drag-handle id="target"></div></div>',
      "#target",
      false,
    ));
  it("keeps SVG internal gestures unless explicitly a handle", () => {
    check('<svg><rect id="target"/></svg>', "#target", false);
    check(
      '<div data-note-drag-handle><svg><rect id="target"/></svg></div>',
      "#target",
      true,
    );
  });
  it("protects custom pointer affordances", () =>
    check(
      '<div style="cursor:grab"><span id="target"></span></div>',
      "#target",
      false,
    ));
  it("keeps overlay scrollbar dragging independent", () => {
    check('<note-scrollbars id="target"></note-scrollbars>', "#target", false);
    check('<div role="scrollbar" id="target"></div>', "#target", false);
  });
  it("retains text selection while allowing adjacent padding", () => {
    const root = document.createElement("div");
    root.textContent = "中文正文";
    document.body.append(root);
    const rangeValue = {
      selectNodeContents: () => {},
      getClientRects: () => [{ left: 0, right: 20, top: 0, bottom: 20 }],
    } as unknown as Range;
    const range = vi.spyOn(document, "createRange").mockReturnValue(rangeValue);
    const drag = installHtmlCanvasDrag(document, vi.fn());
    drag.setEnabled(true);
    expect(drag.canDrag(root, 2, 2, false)).toBe(false);
    expect(drag.canDrag(root, 50, 50, false)).toBe(true);
    drag.dispose();
    range.mockRestore();
    root.remove();
  });
  it("reserves a nested scroll region for touch", () => {
    const root = document.createElement("div");
    root.style.overflowY = "auto";
    document.body.append(root);
    Object.defineProperties(root, {
      scrollHeight: { value: 200 },
      clientHeight: { value: 40 },
    });
    const drag = installHtmlCanvasDrag(document, vi.fn());
    drag.setEnabled(true);
    expect(drag.canDrag(root, 2, 2, true)).toBe(false);
    expect(drag.canDrag(root, 2, 2, false)).toBe(true);
    drag.dispose();
    root.remove();
  });
  it("does not intercept untrusted synthesized input", () => {
    const send = vi.fn();
    const drag = installHtmlCanvasDrag(document, send);
    drag.setEnabled(true);
    document.documentElement.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(send).not.toHaveBeenCalled();
    drag.dispose();
  });
});

import { expect, it, vi } from "vitest";

import { inspectHeadingContrast } from "../data/appContrast";

it("detects a dark title on dark paint without rewriting valid styling", () => {
  const root = document.createElement("section");
  root.style.backgroundColor = "#232329";
  const title = document.createElement("h1");
  title.id = "app-title";
  title.textContent = "架构讲解";
  title.style.color = "#192335";
  root.appendChild(title);
  document.body.appendChild(root);
  vi.spyOn(title, "getBoundingClientRect").mockReturnValue({
    height: 30,
  } as DOMRect);
  try {
    const before = root.outerHTML;
    expect(inspectHeadingContrast(root.ownerDocument)).toEqual([
      expect.stringContaining("对比度"),
    ]);
    expect(root.outerHTML).toBe(before);
    title.style.color = "#ffffff";
    expect(inspectHeadingContrast(root.ownerDocument)).toEqual([]);
    root.style.backgroundColor = "#ffffff";
    title.style.color = "#192335";
    expect(inspectHeadingContrast(root.ownerDocument)).toEqual([]);
    root.style.backgroundColor = "#232329";
    // JSDOM's CSS parser does not accept gradients; supply the computed paint
    // that an actual browser exposes rather than silently testing `none`.
    const win = root.ownerDocument.defaultView!;
    const computedStyle = win.getComputedStyle.bind(win);
    const gradient = vi
      .spyOn(win, "getComputedStyle")
      .mockImplementation((node) => {
        const style = computedStyle(node);
        if (node === root) {
          Object.defineProperty(style, "backgroundImage", {
            value: "linear-gradient(white, black)",
            configurable: true,
          });
        }
        return style;
      });
    expect(inspectHeadingContrast(root.ownerDocument)).toEqual([]);
    gradient.mockRestore();
    root.style.opacity = "0.5";
    title.style.backgroundColor = "#232329";
    expect(inspectHeadingContrast(root.ownerDocument)).toEqual([]);
  } finally {
    root.remove();
  }
});

/** Serialized into the opaque-origin iframe; never edits the saved source. */
export const installHtmlCanvasSurface = (
  doc: Document,
  initiallyTransparent: boolean,
) => {
  const win = doc.defaultView!;
  const attribute = "data-note-canvas-surface";
  const marked = new Set<Element>();
  const style = doc.createElement("style");
  style.textContent = `html,body,[${attribute}]{background:transparent!important}`;
  let transparent = initiallyTransparent;
  let scheduled = 0;
  const refresh = () => {
    scheduled = 0;
    style.disabled = !transparent;
    if (!transparent || !doc.body) {
      return;
    }
    // Only a viewport-sized, undecorated outer wrapper is a page surface.
    // A bordered/rounded card remains a card even when it fills a small frame.
    const roots = Array.from(doc.body.children).filter(
      (node) =>
        !["SCRIPT", "STYLE", "LINK", "META"].includes(node.tagName) &&
        !node.hasAttribute("data-overlay-scrollbars"),
    );
    const surfaces = new Set<Element>();
    for (const root of roots) {
      if (
        !(root instanceof win.HTMLElement) ||
        !["DIV", "MAIN", "SECTION"].includes(root.tagName)
      ) {
        continue;
      }
      const css = win.getComputedStyle(root);
      const rect = root.getBoundingClientRect();
      if (
        root.hasAttribute("data-note-app-surface") ||
        (rect.width >= win.innerWidth - 40 &&
          rect.height >= win.innerHeight - 40 &&
          css.boxShadow === "none" &&
          [
            css.borderTopWidth,
            css.borderRightWidth,
            css.borderBottomWidth,
            css.borderLeftWidth,
            css.borderTopLeftRadius,
            css.borderTopRightRadius,
            css.borderBottomLeftRadius,
            css.borderBottomRightRadius,
          ].every((value) => parseFloat(value) === 0) &&
          !root.matches(".card,[data-note-app-card]"))
      ) {
        surfaces.add(root);
      }
    }
    for (const root of marked) {
      if (!surfaces.has(root)) {
        root.removeAttribute(attribute);
        marked.delete(root);
      }
    }
    for (const root of surfaces) {
      if (!marked.has(root)) {
        root.setAttribute(attribute, "");
        marked.add(root);
      }
    }
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = win.requestAnimationFrame(refresh);
    }
  };
  // Keep our stylesheet after generated styles; !important also wins against
  // the usual generated inline body background without removing original CSS.
  doc.documentElement.append(style);
  const observer = new win.MutationObserver(schedule);
  observer.observe(doc, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["style", "class"],
  });
  win.addEventListener("resize", schedule);
  refresh();
  return {
    setTransparent(value: boolean) {
      transparent = value;
      refresh();
    },
    dispose() {
      observer.disconnect();
      win.removeEventListener("resize", schedule);
      if (scheduled) {
        win.cancelAnimationFrame(scheduled);
      }
      for (const root of marked) {
        root.removeAttribute(attribute);
      }
      style.remove();
    },
  };
};

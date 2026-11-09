/** Serialized into the sandbox. All decisions use the mounted document. */
export const installHtmlCanvasDrag = (
  doc: Document,
  send: (type: string, data?: unknown) => void,
) => {
  const win = doc.defaultView!;
  let enabled = false;
  let hovered: Element | null = null;
  let suppressClick = false;
  let space = false;
  let gesture: {
    id: number;
    x: number;
    y: number;
    started: boolean;
    touch: boolean;
  } | null = null;
  const pointers = new Set<number>();
  const style = doc.createElement("style");
  style.textContent =
    "[data-note-drag-hover]{cursor:move!important}html[data-note-drag-active],html[data-note-drag-active] *{cursor:grabbing!important;user-select:none!important}";
  doc.documentElement.append(style);
  const clearHover = () => {
    hovered?.removeAttribute("data-note-drag-hover");
    hovered = null;
  };
  const interactive =
    'button,input,textarea,select,option,a[href],label,summary,iframe,canvas,note-scrollbars,[role="scrollbar"],[tabindex]:not([tabindex="-1"]),[contenteditable]:not([contenteditable="false"]),[data-note-interactive],[data-overlay-scrollbars],[role="button"],[role="link"],[role="slider"],[role="spinbutton"],[role="textbox"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="listbox"],[role="tree"],[role="grid"],[draggable="true"],[onclick],[onpointerdown],[onmousedown]';
  const canDrag = (
    target: EventTarget | null,
    x: number,
    y: number,
    touch: boolean,
  ) => {
    if (
      !enabled ||
      !(target instanceof win.Element) ||
      target.closest(interactive)
    ) {
      return false;
    }
    const scrolling = doc.scrollingElement;
    if (
      touch &&
      scrolling &&
      (scrolling.scrollHeight > scrolling.clientHeight + 1 ||
        scrolling.scrollWidth > scrolling.clientWidth + 1)
    ) {
      return false;
    }
    const handle = target.closest("[data-note-drag-handle]");
    if (!handle && target.closest("svg")) {
      return false;
    }
    for (let node: Element | null = target; node; node = node.parentElement) {
      const css = win.getComputedStyle(node);
      if (
        !handle &&
        ["pointer", "grab", "grabbing", "crosshair"].includes(css.cursor) &&
        !node.hasAttribute("data-note-drag-hover")
      ) {
        return false;
      }
      if (
        touch &&
        ((/(auto|scroll)/.test(css.overflowY) &&
          node.scrollHeight > node.clientHeight + 1) ||
          (/(auto|scroll)/.test(css.overflowX) &&
            node.scrollWidth > node.clientWidth + 1))
      ) {
        return false;
      }
    }
    if (!handle) {
      // Test actual text rectangles, allowing padding around a textual card to drag.
      for (const child of Array.from(target.childNodes)) {
        if (child.nodeType !== 3 || !child.textContent?.trim()) {
          continue;
        }
        const range = doc.createRange();
        range.selectNodeContents(child);
        if (
          Array.from(range.getClientRects()).some(
            (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
          )
        ) {
          return false;
        }
      }
    }
    return true;
  };
  const hover = (event: PointerEvent) => {
    if (!event.isTrusted || gesture) {
      return;
    }
    clearHover();
    if (
      canDrag(
        event.target,
        event.clientX,
        event.clientY,
        event.pointerType !== "mouse",
      )
    ) {
      hovered = event.target as Element;
      hovered.setAttribute("data-note-drag-hover", "");
    }
  };
  const payload = (event: PointerEvent) => ({
    deltaX: event.screenX - gesture!.x,
    deltaY: event.screenY - gesture!.y,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
  });
  const finish = (cancel: boolean) => {
    const previous = gesture;
    gesture = null;
    if (previous?.started) {
      send("canvas_drag", { phase: cancel ? "cancel" : "end" });
    }
    doc.documentElement.removeAttribute("data-note-drag-active");
    clearHover();
    if (previous && doc.documentElement.hasPointerCapture(previous.id)) {
      doc.documentElement.releasePointerCapture(previous.id);
    }
  };
  const down = (event: PointerEvent) => {
    if (!event.isTrusted || event.button !== 0) {
      return;
    }
    pointers.add(event.pointerId);
    if (pointers.size > 1) {
      finish(true);
      return;
    }
    suppressClick = false;
    if (
      !canDrag(
        event.target,
        event.clientX,
        event.clientY,
        event.pointerType !== "mouse",
      )
    ) {
      return;
    }
    gesture = {
      id: event.pointerId,
      x: event.screenX,
      y: event.screenY,
      started: false,
      touch: event.pointerType !== "mouse",
    };
    doc.documentElement.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!event.isTrusted) {
      return;
    }
    if (!gesture || gesture.id !== event.pointerId) {
      hover(event);
      return;
    }
    const data = payload(event);
    if (
      !gesture.started &&
      Math.hypot(data.deltaX, data.deltaY) <= (gesture.touch ? 8 : 5)
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!gesture.started) {
      gesture.started = true;
      suppressClick = true;
      doc.getSelection()?.removeAllRanges();
      doc.documentElement.setAttribute("data-note-drag-active", "");
      send("canvas_drag", { phase: "start" });
    }
    send("canvas_drag", { phase: "move", ...data });
  };
  const up = (event: PointerEvent) => {
    if (!event.isTrusted) {
      return;
    }
    pointers.delete(event.pointerId);
    if (gesture?.id !== event.pointerId) {
      return;
    }
    if (gesture.started) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "pointerup") {
        send("canvas_drag", { phase: "move", ...payload(event) });
      }
    }
    finish(event.type !== "pointerup");
  };
  const click = (event: MouseEvent) => {
    if (event.isTrusted && suppressClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = false;
    }
  };
  const key = (event: KeyboardEvent) => {
    if (
      event.isTrusted &&
      event.code === "Space" &&
      !(event.target as Element)?.closest?.(interactive)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!space) {
        space = true;
        finish(true);
        send("canvas_space", true);
      }
      return;
    }
    if (event.isTrusted && event.key === "Escape" && gesture) {
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(true);
    }
  };
  const keyUp = (event: KeyboardEvent) => {
    if (event.isTrusted && event.code === "Space" && space) {
      space = false;
      send("canvas_space", false);
    }
  };
  const cancel = () => {
    pointers.clear();
    finish(true);
  };
  let pinch: {
    x: number;
    y: number;
    sx: number;
    sy: number;
    distance: number;
  } | null = null;
  const touch = (event: TouchEvent) => {
    if (!event.isTrusted) {
      return;
    }
    if (event.touches.length !== 2) {
      pinch = null;
      // Setting touch-action during pointerover is too late in some browsers.
      // Only an eligible blank start opts out of native panning; scroll/controls
      // keep their uncancelled touchstart and all native gestures.
      const first = event.touches[0];
      if (
        event.type === "touchstart" &&
        first &&
        canDrag(
          doc.elementFromPoint(first.clientX, first.clientY),
          first.clientX,
          first.clientY,
          true,
        )
      ) {
        event.preventDefault();
      }
      return;
    }
    const [a, b] = Array.from(event.touches);
    const next = {
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2,
      sx: (a.screenX + b.screenX) / 2,
      sy: (a.screenY + b.screenY) / 2,
      distance: Math.hypot(a.screenX - b.screenX, a.screenY - b.screenY),
    };
    if (!pinch) {
      if (
        event.type !== "touchstart" ||
        !canDrag(
          doc.elementFromPoint(a.clientX, a.clientY),
          a.clientX,
          a.clientY,
          false,
        ) ||
        !canDrag(
          doc.elementFromPoint(b.clientX, b.clientY),
          b.clientX,
          b.clientY,
          false,
        )
      ) {
        return;
      }
      finish(true);
      pinch = next;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "touchmove" && pinch.distance > 0 && next.distance > 0) {
      send("canvas_pinch", {
        ratio: next.distance / pinch.distance,
        deltaX: next.sx - pinch.sx,
        deltaY: next.sy - pinch.sy,
        current: { x: next.x / win.innerWidth, y: next.y / win.innerHeight },
      });
    }
    pinch = next;
  };
  doc.addEventListener("touchstart", touch, { capture: true, passive: false });
  doc.addEventListener("touchmove", touch, { capture: true, passive: false });
  doc.addEventListener("touchend", touch, true);
  doc.addEventListener("touchcancel", touch, true);
  doc.addEventListener("pointerover", hover, true);
  doc.addEventListener("pointerdown", down, true);
  doc.addEventListener("pointermove", move, true);
  doc.addEventListener("pointerup", up, true);
  doc.addEventListener("pointercancel", up, true);
  doc.addEventListener("lostpointercapture", up, true);
  doc.addEventListener("click", click, true);
  doc.addEventListener("keydown", key, true);
  doc.addEventListener("keyup", keyUp, true);
  const blur = () => {
    cancel();
    if (space) {
      space = false;
      send("canvas_space", false);
    }
  };
  win.addEventListener("blur", blur);
  return {
    canDrag,
    setEnabled(value: boolean) {
      enabled = value;
      if (!value) {
        pinch = null;
        cancel();
      }
    },
    cancel,
    dispose() {
      cancel();
      pinch = null;
      doc.removeEventListener("touchstart", touch, true);
      doc.removeEventListener("touchmove", touch, true);
      doc.removeEventListener("touchend", touch, true);
      doc.removeEventListener("touchcancel", touch, true);
      style.remove();
      doc.removeEventListener("pointerover", hover, true);
      doc.removeEventListener("pointerdown", down, true);
      doc.removeEventListener("pointermove", move, true);
      doc.removeEventListener("pointerup", up, true);
      doc.removeEventListener("pointercancel", up, true);
      doc.removeEventListener("lostpointercapture", up, true);
      doc.removeEventListener("click", click, true);
      doc.removeEventListener("keydown", key, true);
      doc.removeEventListener("keyup", keyUp, true);
      if (space) {
        send("canvas_space", false);
      }
      win.removeEventListener("blur", blur);
    },
  };
};

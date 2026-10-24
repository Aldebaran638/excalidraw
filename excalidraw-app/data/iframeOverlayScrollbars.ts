/** Self-contained: serialized into the opaque iframe, never run on the host. */
export function installIframeOverlayScrollbars(doc: Document) {
  const win = doc.defaultView!;
  const sheet = doc.createElement("style");
  sheet.textContent = `html,body,*{scrollbar-width:none!important;scrollbar-gutter:auto!important}*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}`;
  doc.head.append(sheet);
  const host = doc.createElement("note-scrollbars");
  host.style.cssText =
    "all:initial!important;position:fixed!important;inset:0!important;display:block!important;pointer-events:none!important;color-scheme:inherit!important;z-index:2147483647!important;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  style.textContent = `
    .clip{position:absolute;overflow:hidden;pointer-events:none}
    .track{position:absolute;pointer-events:auto;touch-action:none;user-select:none;outline:none}
    .thumb{position:absolute;border-radius:99px;background:light-dark(#6668,#bbb9);pointer-events:none}
    .y{width:14px}.y .thumb{width:6px;right:3px}
    .x{height:14px}.x .thumb{height:6px;bottom:3px}
    .track:hover .thumb,.track:focus-visible .thumb,.dragging .thumb{background:light-dark(#555c,#cccd)}
    .track:focus-visible .thumb{outline:2px solid light-dark(#6965db,#b4afff);outline-offset:1px}
    @media(forced-colors:active){.thumb{background:ButtonText;forced-color-adjust:none}}
  `;
  shadow.append(style);
  doc.documentElement.append(host);
  type Entry = {
    node: HTMLElement;
    axis: "x" | "y";
    clip: HTMLElement;
    track: HTMLElement;
    thumb: HTMLElement;
    length: number;
    thumbLength: number;
    maximum: number;
    rtl: boolean;
  };
  const entries = new Map<HTMLElement, Partial<Record<"x" | "y", Entry>>>();
  let anchor: HTMLElement | null = doc.body;
  let frame = 0;
  let disposed = false;
  const watched = new Set<Element>();
  const root = () =>
    (doc.scrollingElement || doc.documentElement) as HTMLElement;
  const position = (entry: Entry) =>
    entry.axis === "y"
      ? entry.node.scrollTop
      : entry.rtl
      ? entry.maximum + entry.node.scrollLeft
      : entry.node.scrollLeft;
  const setPosition = (entry: Entry, value: number) => {
    value = Math.max(0, Math.min(entry.maximum, value));
    if (entry.axis === "y") {
      entry.node.scrollTop = value;
    } else {
      entry.node.scrollLeft = entry.rtl ? value - entry.maximum : value;
    }
    schedule();
  };
  const make = (node: HTMLElement, axis: "x" | "y"): Entry => {
    const clip = doc.createElement("div");
    clip.className = "clip";
    const track = doc.createElement("div");
    track.className = `track ${axis}`;
    track.tabIndex = 0;
    track.setAttribute("role", "scrollbar");
    track.setAttribute(
      "aria-label",
      axis === "y" ? "垂直滚动条" : "水平滚动条",
    );
    track.setAttribute(
      "aria-orientation",
      axis === "y" ? "vertical" : "horizontal",
    );
    track.setAttribute("aria-valuemin", "0");
    const thumb = doc.createElement("div");
    thumb.className = "thumb";
    track.append(thumb);
    clip.append(track);
    shadow.append(clip);
    const entry = {
      node,
      axis,
      clip,
      track,
      thumb,
      length: 0,
      thumbLength: 0,
      maximum: 0,
      rtl: false,
    };
    let drag: { id: number; offset: number } | null = null;
    const coordinate = (event: PointerEvent) =>
      axis === "y" ? event.clientY : event.clientX;
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) {
        return;
      }
      const rect = track.getBoundingClientRect();
      const start = axis === "y" ? rect.top : rect.left;
      setPosition(
        entry,
        ((coordinate(event) - start - drag.offset) /
          Math.max(1, entry.length - entry.thumbLength)) *
          entry.maximum,
      );
      event.preventDefault();
      event.stopPropagation();
    };
    track.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      const rect = thumb.getBoundingClientRect();
      const start = axis === "y" ? rect.top : rect.left;
      const end = axis === "y" ? rect.bottom : rect.right;
      const point = coordinate(event);
      drag = {
        id: event.pointerId,
        offset:
          point >= start && point <= end
            ? point - start
            : entry.thumbLength / 2,
      };
      track.setPointerCapture(event.pointerId);
      track.focus({ preventScroll: true });
      track.classList.add("dragging");
      move(event);
    });
    track.addEventListener("pointermove", move);
    const finish = () => {
      drag = null;
      track.classList.remove("dragging");
    };
    track.addEventListener("pointerup", finish);
    track.addEventListener("pointercancel", finish);
    track.addEventListener("lostpointercapture", finish);
    track.addEventListener(
      "wheel",
      (event) => {
        const horizontal =
          event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
        const target = entries.get(node)?.[horizontal ? "x" : "y"];
        if (!target) {
          return;
        }
        const delta = horizontal ? event.deltaX || event.deltaY : event.deltaY;
        const unit =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
            ? horizontal
              ? node.clientWidth
              : node.clientHeight
            : 1;
        const before = position(target);
        setPosition(target, before + delta * unit);
        if (before !== position(target)) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      { passive: false },
    );
    track.addEventListener("keydown", (event) => {
      const current = position(entry);
      const page = axis === "y" ? node.clientHeight : node.clientWidth;
      const values: Record<string, number> = {
        Home: 0,
        End: entry.maximum,
        PageUp: current - page * 0.9,
        PageDown: current + page * 0.9,
      };
      values[axis === "y" ? "ArrowUp" : "ArrowLeft"] = current - 40;
      values[axis === "y" ? "ArrowDown" : "ArrowRight"] = current + 40;
      if (event.key in values) {
        event.preventDefault();
        event.stopPropagation();
        setPosition(entry, values[event.key]);
      }
    });
    return entry;
  };
  const box = (node: HTMLElement) => {
    if (node === root()) {
      return {
        left: 0,
        top: 0,
        right: doc.documentElement.clientWidth,
        bottom: win.innerHeight,
        width: doc.documentElement.clientWidth,
        height: win.innerHeight,
      };
    }
    const rect = node.getBoundingClientRect();
    const x = node.offsetWidth ? rect.width / node.offsetWidth : 1;
    const y = node.offsetHeight ? rect.height / node.offsetHeight : 1;
    const left = rect.left + node.clientLeft * x;
    const top = rect.top + node.clientTop * y;
    const width = node.clientWidth * x;
    const height = node.clientHeight * y;
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    };
  };
  const render = () => {
    frame = 0;
    if (disposed) {
      return;
    }
    // Only the document and the hovered/focused ancestry need controls. No
    // full-tree layout scan on every streamed token, scroll, or animation tick.
    const candidates = new Set<HTMLElement>([root(), doc.body]);
    for (
      let node = anchor;
      node && node !== doc.documentElement;
      node = node.parentElement
    ) {
      if (node.isConnected) {
        candidates.add(node);
      }
    }
    for (const [node, axes] of entries) {
      if (!candidates.has(node)) {
        Object.values(axes).forEach((entry) => entry?.clip.remove());
        entries.delete(node);
      }
    }
    for (const node of watched) {
      if (!candidates.has(node as HTMLElement)) {
        resize.unobserve(node);
        watched.delete(node);
      }
    }
    for (const node of candidates) {
      if (!watched.has(node)) {
        resize.observe(node);
        watched.add(node);
      }
    }
    for (const node of candidates) {
      const computed = win.getComputedStyle(node);
      const bounds = box(node);
      const clip = {
        left: Math.max(0, bounds.left),
        top: Math.max(0, bounds.top),
        right: Math.min(win.innerWidth, bounds.right),
        bottom: Math.min(win.innerHeight, bounds.bottom),
      };
      for (
        let parent = node.parentElement;
        parent && parent !== doc.documentElement;
        parent = parent.parentElement
      ) {
        const css = win.getComputedStyle(parent);
        if (
          /(auto|scroll|hidden|clip)/.test(`${css.overflowX} ${css.overflowY}`)
        ) {
          const rect = box(parent);
          clip.left = Math.max(clip.left, rect.left);
          clip.top = Math.max(clip.top, rect.top);
          clip.right = Math.min(clip.right, rect.right);
          clip.bottom = Math.min(clip.bottom, rect.bottom);
        }
      }
      const axes = entries.get(node) || {};
      for (const axis of ["x", "y"] as const) {
        const viewport = axis === "y" ? node.clientHeight : node.clientWidth;
        const total = axis === "y" ? node.scrollHeight : node.scrollWidth;
        const overflow = axis === "y" ? computed.overflowY : computed.overflowX;
        const allowed =
          node === root()
            ? !/hidden|clip/.test(overflow)
            : /auto|scroll|overlay/.test(overflow);
        if (
          !allowed ||
          total <= viewport + 1 ||
          !viewport ||
          clip.right <= clip.left ||
          clip.bottom <= clip.top
        ) {
          axes[axis]?.clip.remove();
          delete axes[axis];
          continue;
        }
        const entry = axes[axis] || make(node, axis);
        axes[axis] = entry;
        entry.length = (axis === "y" ? bounds.height : bounds.width) - 4;
        entry.maximum = total - viewport;
        entry.rtl = computed.direction === "rtl";
        entry.thumbLength = Math.min(
          entry.length,
          Math.max(24, (entry.length * viewport) / total),
        );
        const offset =
          (Math.max(0, Math.min(entry.maximum, position(entry))) /
            entry.maximum) *
          (entry.length - entry.thumbLength);
        entry.clip.style.cssText = `left:${clip.left}px;top:${
          clip.top
        }px;width:${clip.right - clip.left}px;height:${
          clip.bottom - clip.top
        }px`;
        entry.track.style.cssText =
          axis === "y"
            ? `left:${bounds.right - 14 - clip.left}px;top:${
                bounds.top + 2 - clip.top
              }px;height:${entry.length}px`
            : `left:${bounds.left + 2 - clip.left}px;top:${
                bounds.bottom - 14 - clip.top
              }px;width:${entry.length}px`;
        entry.thumb.style.cssText =
          axis === "y"
            ? `top:${offset}px;height:${entry.thumbLength}px`
            : `left:${offset}px;width:${entry.thumbLength}px`;
        entry.track.setAttribute("aria-valuemax", String(entry.maximum));
        entry.track.setAttribute(
          "aria-valuenow",
          String(Math.round(position(entry))),
        );
      }
      if (Object.keys(axes).length) {
        entries.set(node, axes);
      }
    }
  };
  function schedule() {
    if (!disposed && !frame) {
      frame = win.requestAnimationFrame(render);
    }
  }
  const point = (event: Event) => {
    const target = event.target;
    if (target === host) {
      return;
    }
    if (target instanceof win.HTMLElement) {
      anchor = target;
    }
    schedule();
  };
  const mutation = new win.MutationObserver(schedule);
  mutation.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden", "open"],
  });
  const resize = new win.ResizeObserver(schedule);
  resize.observe(doc.documentElement);
  if (doc.body) {
    resize.observe(doc.body);
  }
  doc.addEventListener("pointermove", point, { passive: true });
  doc.addEventListener("pointerdown", point, { passive: true });
  doc.addEventListener("focusin", point);
  doc.addEventListener("scroll", point, { capture: true, passive: true });
  doc.addEventListener("load", schedule, true);
  win.addEventListener("resize", schedule);
  schedule();
  return () => {
    disposed = true;
    win.cancelAnimationFrame(frame);
    mutation.disconnect();
    resize.disconnect();
    doc.removeEventListener("pointermove", point);
    doc.removeEventListener("pointerdown", point);
    doc.removeEventListener("focusin", point);
    doc.removeEventListener("scroll", point, true);
    doc.removeEventListener("load", schedule, true);
    win.removeEventListener("resize", schedule);
    host.remove();
    sheet.remove();
    entries.clear();
    watched.clear();
  };
}

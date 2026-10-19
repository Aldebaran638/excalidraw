/** Generic routing for trusted embedded controls, not ordinary website embeds. */
export const controlsAncestor = (
  target: EventTarget | null,
  ownerWindow: Window & typeof globalThis,
) =>
  target instanceof ownerWindow.HTMLElement
    ? target.closest<HTMLElement>('[data-embeddable-interaction="controls"]')
    : null;

export const embeddedControlsCanScroll = (
  event: WheelEvent | React.WheelEvent,
  boundary: HTMLElement,
  ownerWindow: Window & typeof globalThis,
) => {
  let node =
    event.target instanceof ownerWindow.HTMLElement ? event.target : null;
  while (node && boundary.contains(node)) {
    const style = ownerWindow.getComputedStyle(node);
    if (
      (/auto|scroll/.test(style.overflowY) &&
        ((event.deltaY > 0 &&
          node.scrollTop + node.clientHeight < node.scrollHeight - 1) ||
          (event.deltaY < 0 && node.scrollTop > 0))) ||
      (/auto|scroll/.test(style.overflowX) &&
        ((event.deltaX > 0 &&
          node.scrollLeft + node.clientWidth < node.scrollWidth - 1) ||
          (event.deltaX < 0 && node.scrollLeft > 0)))
    ) {
      return true;
    }
    if (node === boundary) {
      break;
    }
    node = node.parentElement;
  }
  return false;
};

export const observeEmbeddedPinch = (
  root: HTMLElement,
  enabled: () => boolean,
  onPinch: (
    ratio: number,
    previous: { x: number; y: number },
    current: { x: number; y: number },
  ) => void,
) => {
  const ownerWindow = root.ownerDocument.defaultView as Window &
    typeof globalThis;
  let gesture: { distance: number; center: { x: number; y: number } } | null =
    null;
  let suppressClickUntil = 0;
  const read = (event: TouchEvent) => {
    const [a, b] = Array.from(event.touches);
    return {
      distance: Math.max(
        1,
        Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      ),
      center: {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
      },
    };
  };
  const start = (event: TouchEvent) => {
    if (
      enabled() &&
      event.touches.length >= 2 &&
      controlsAncestor(event.target, ownerWindow)
    ) {
      gesture = read(event);
      root.setAttribute("data-embeddable-pinch", "true");
      event.preventDefault();
    }
  };
  const move = (event: TouchEvent) => {
    if (!gesture || event.touches.length < 2) {
      return;
    }
    const next = read(event);
    onPinch(next.distance / gesture.distance, gesture.center, next.center);
    gesture = next;
    event.preventDefault();
    event.stopPropagation();
  };
  const end = (event: TouchEvent) => {
    if (gesture && event.touches.length < 2) {
      gesture = null;
      suppressClickUntil = ownerWindow.performance.now() + 400;
      root.removeAttribute("data-embeddable-pinch");
      event.preventDefault();
    }
  };
  const click = (event: MouseEvent) => {
    if (ownerWindow.performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  root.addEventListener("touchstart", start, { capture: true, passive: false });
  root.addEventListener("touchmove", move, { capture: true, passive: false });
  root.addEventListener("touchend", end, { capture: true, passive: false });
  root.addEventListener("touchcancel", end, { capture: true, passive: false });
  root.addEventListener("click", click, true);
  return () => {
    root.removeEventListener("touchstart", start, true);
    root.removeEventListener("touchmove", move, true);
    root.removeEventListener("touchend", end, true);
    root.removeEventListener("touchcancel", end, true);
    root.removeEventListener("click", click, true);
    root.removeAttribute("data-embeddable-pinch");
  };
};

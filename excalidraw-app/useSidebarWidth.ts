import { useCallback, useEffect, useRef, useState } from "react";

import { RIGHT_SIDEBAR_WIDTH } from "@excalidraw/excalidraw/components/App.viewport";

import {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  sidebarWidthLimit,
} from "./components/SidebarResizeHandle";

import type { RefObject } from "react";

const STORAGE_KEY = "aldebaran.sidebar-width";

export const useSidebarWidth = (root: RefObject<HTMLElement | null>) => {
  const [width, setWidth] = useState(RIGHT_SIDEBAR_WIDTH);
  const preferred = useRef(RIGHT_SIDEBAR_WIDTH);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const ownerWindow = root.current?.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }
    try {
      const stored = Number(ownerWindow.localStorage.getItem(STORAGE_KEY));
      if (
        Number.isFinite(stored) &&
        stored >= SIDEBAR_MIN_WIDTH &&
        stored <= SIDEBAR_MAX_WIDTH
      ) {
        preferred.current = stored;
      }
    } catch {
      // Width remains usable when browser storage is unavailable.
    }
    const update = () =>
      setWidth(
        Math.min(
          preferred.current,
          sidebarWidthLimit(
            root.current?.clientWidth || ownerWindow.innerWidth,
          ),
        ),
      );
    update();
    ownerWindow.addEventListener("resize", update);
    return () => {
      ownerWindow.removeEventListener("resize", update);
      ownerWindow.clearTimeout(timer.current);
    };
  }, [root]);

  const resize = useCallback(
    (next: number) => {
      const ownerWindow = root.current?.ownerDocument.defaultView;
      if (!ownerWindow || !Number.isFinite(next)) {
        return;
      }
      const clamped = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(
          next,
          sidebarWidthLimit(
            root.current?.clientWidth || ownerWindow.innerWidth,
          ),
        ),
      );
      preferred.current = clamped;
      setWidth(clamped);
      ownerWindow.clearTimeout(timer.current);
      timer.current = ownerWindow.setTimeout(() => {
        try {
          ownerWindow.localStorage.setItem(
            STORAGE_KEY,
            String(preferred.current),
          );
        } catch {
          // Preference persistence must never interrupt editing.
        }
      }, 200);
    },
    [root],
  );
  return { width, resize };
};

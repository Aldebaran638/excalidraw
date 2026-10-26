import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { HtmlAppView } from "./HtmlAppView";

import type { AppPreviewReport } from "../data/appPreview";
import type { HtmlState } from "../data/chatHtml";

/** Short-lived, non-persisting verifier, not another canvas/application dataset.
 * Reuses the production runtime but never registers state/history callbacks. */
export function AppPreviewCheck({
  anchor,
  identity,
  source,
  state,
  runtimeVersion,
  onResult,
}: {
  anchor: HTMLElement;
  identity: string;
  source: string;
  state: HtmlState;
  runtimeVersion: number;
  onResult: (report: AppPreviewReport) => void;
}) {
  const [container, setContainer] = useState<HTMLElement>();
  useEffect(() => {
    const doc = anchor.ownerDocument;
    const host = doc.createElement("div");
    host.className = "note-chat app-preview-verifier";
    host.setAttribute("aria-hidden", "true");
    host.inert = true;
    Object.assign(host.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      width: `${Math.max(280, anchor.clientWidth - 24)}px`,
      height: "480px",
      opacity: "0",
      pointerEvents: "none",
    });
    (anchor.closest(".excalidraw") || doc.body).appendChild(host);
    setContainer(host);
    return () => host.remove();
  }, [anchor, identity]);
  return container
    ? createPortal(
        <HtmlAppView
          identity={`verification/${identity}`}
          source={source}
          initialState={state}
          runtimeVersion={runtimeVersion}
          complete
          verifyInteractions
          onPreview={onResult}
        />,
        container,
      )
    : null;
}

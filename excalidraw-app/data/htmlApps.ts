import { randomId } from "@excalidraw/common";
import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { readCanvasHtmlApp } from "./chatHtml";

/** Fork the identity, never the source pointer, when creating an independent copy. */
export const forkHtmlApps = <T extends ExcalidrawElement>(
  elements: readonly T[],
  previousIds = new Set<string>(),
  identities = new Map<string, string>(),
) =>
  elements.map((element) => {
    const app = readCanvasHtmlApp(element.customData?.htmlApp);
    return app && !previousIds.has(element.id)
      ? (newElementWith(element as ExcalidrawElement, {
          link: `https://apps.excalidraw.local/${element.id}`,
          customData: {
            ...element.customData,
            htmlApp: {
              ...structuredClone(app),
              appId: identities.get(element.id) || randomId(),
              version: 1,
              pendingSource: true,
            },
          },
        }) as T)
      : element;
  });

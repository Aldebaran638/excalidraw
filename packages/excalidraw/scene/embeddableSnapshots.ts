import type {
  NonDeletedExcalidrawElement,
  FileId,
} from "@excalidraw/element/types";

import type { BinaryFiles, DataURL } from "../types";

// Scroll is a local view detail. Cache a snapshot for export without creating
// an element mutation or triggering repository persistence.
const localSnapshots = new Map<
  string,
  { baseline: string; width: number; height: number; svg: string }
>();
export const cacheEmbeddableSnapshot = (
  element: NonDeletedExcalidrawElement,
  svg: string,
) => {
  const baseline = element.customData?.embeddable?.snapshot;
  if (typeof baseline === "string") {
    localSnapshots.set(element.id, {
      baseline,
      width: element.width,
      height: element.height,
      svg,
    });
    if (localSnapshots.size > 100) {
      localSnapshots.delete(localSnapshots.keys().next().value!);
    }
  }
};

/** Host snapshots are exported as images, never as executable DOM. */
export const prepareEmbeddableSnapshots = (
  elements: readonly NonDeletedExcalidrawElement[],
  files: BinaryFiles,
) => {
  const nextFiles = { ...files };
  const nextElements = elements.map((element): NonDeletedExcalidrawElement => {
    let svg =
      element.type === "embeddable"
        ? element.customData?.embeddable?.snapshot
        : null;
    const local = localSnapshots.get(element.id);
    if (
      local &&
      local.baseline === svg &&
      local.width === element.width &&
      local.height === element.height
    ) {
      svg = local.svg;
    }
    if (
      typeof svg !== "string" ||
      !svg.startsWith("<svg") ||
      svg.length > 2 * 1024 * 1024
    ) {
      return element;
    }
    const fileId = `embed-${element.id}` as FileId;
    nextFiles[fileId] = {
      id: fileId,
      mimeType: "image/svg+xml",
      dataURL: `data:image/svg+xml,${encodeURIComponent(svg)}` as DataURL,
      created: 0,
    };
    return {
      ...element,
      type: "image",
      fileId,
      status: "saved",
      scale: [1, 1],
      crop: null,
    };
  });
  return { elements: nextElements, files: nextFiles };
};

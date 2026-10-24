import { fixBindingsAfterDeletion, newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

/** Tombstone legacy AI elements and repair bindings with the native algorithm. */
export const retireLegacyWidgets = (elements: readonly ExcalidrawElement[]) => {
  const deleted: ExcalidrawElement[] = [];
  const next = elements.map((element) => {
    if (!element.isDeleted && element.customData?.aiWidget) {
      const removed = newElementWith(element, { isDeleted: true });
      deleted.push(removed);
      return removed;
    }
    // Binding repair mutates affected elements; never mutate the caller's note.
    return structuredClone(element);
  });
  fixBindingsAfterDeletion(next, deleted);
  return { elements: next, removed: deleted.map((element) => element.id) };
};

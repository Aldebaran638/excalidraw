import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

export const listRepositoryNotes = async (): Promise<string[]> => {
  const response = await fetch("/api/notes");
  if (!response.ok) {
    throw new Error("Unable to list repository notes");
  }
  const data = (await response.json()) as { notes?: unknown };
  if (
    !Array.isArray(data.notes) ||
    !data.notes.every((note) => typeof note === "string")
  ) {
    throw new Error("Invalid repository notes response");
  }
  return data.notes;
};

export const saveRepositoryNote = async (
  name: string,
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) => {
  const filename = name.toLowerCase().endsWith(".excalidraw")
    ? name
    : `${name}.excalidraw`;
  const content = serializeAsJSON(elements, appState, files, "local");
  const response = await fetch(`/api/notes/${encodeURIComponent(filename)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: content,
  });
  if (!response.ok) {
    throw new Error("Unable to save repository note");
  }
  return filename;
};

export const loadRepositoryNote = async (name: string) => {
  const response = await fetch(`/api/notes/${encodeURIComponent(name)}`);
  if (!response.ok) {
    throw new Error("Unable to load repository note");
  }
  return loadFromBlob(await response.blob(), null, null);
};

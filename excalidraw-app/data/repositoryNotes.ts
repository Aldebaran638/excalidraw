import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

export type RepositoryNoteChange = Readonly<{
  name: string;
  kind: "updated" | "deleted";
  revision?: string;
  sourceId?: string;
}>;

export type RepositoryNoteSaveOptions = Readonly<{
  expectedRevision?: string | null;
  createOnly?: boolean;
  clientId?: string | null;
  /** Reuse a snapshot serialized by the sync queue. */
  serializedContent?: string;
}>;

export const serializeRepositoryNote = (
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) => serializeAsJSON(elements, appState, files, "local");

export const subscribeToRepositoryNoteChanges = (
  listener: (change: RepositoryNoteChange) => void,
  ownerWindow: Window,
  onReconnect?: () => void,
) => {
  const source = new (ownerWindow as Window & typeof globalThis).EventSource(
    "/api/notes/events",
  );
  source.addEventListener("ready", () => onReconnect?.());
  source.onmessage = (event) => {
    try {
      const change = JSON.parse(event.data) as RepositoryNoteChange;
      if (
        typeof change.name === "string" &&
        ["updated", "deleted"].includes(change.kind)
      ) {
        listener(change);
      }
    } catch {
      /* Ignore malformed events; reconnect checks the revision. */
    }
  };
  return () => source.close();
};

export const normalizeRepositoryNoteName = (name: string) => {
  const trimmedName = name.trim();
  return trimmedName.toLowerCase().endsWith(".excalidraw")
    ? trimmedName
    : `${trimmedName}.excalidraw`;
};

export const createTimestampedRepositoryNoteName = (date = new Date()) => {
  const part = (value: number, length = 2) =>
    value.toString().padStart(length, "0");
  return `note-${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(
    date.getDate(),
  )}-${part(date.getHours())}${part(date.getMinutes())}${part(
    date.getSeconds(),
  )}-${part(date.getMilliseconds(), 3)}.excalidraw`;
};

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
  options: RepositoryNoteSaveOptions = {},
) => {
  const filename = normalizeRepositoryNoteName(name);
  const content =
    options.serializedContent ??
    serializeRepositoryNote(elements, appState, files);
  const response = await fetch(`/api/notes/${encodeURIComponent(filename)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(options.clientId
        ? { "X-Repository-Client-Id": options.clientId }
        : {}),
      ...(options.expectedRevision
        ? { "If-Match": `"${options.expectedRevision}"` }
        : {}),
      ...(options.createOnly ? { "If-None-Match": "*" } : {}),
    },
    body: content,
  });
  if (response.status === 409 || response.status === 412) {
    const error = new Error("Repository note changed locally");
    error.name = "RepositoryNoteConflictError";
    throw error;
  }
  if (!response.ok) {
    throw new Error("Unable to save repository note");
  }
  const data = (await response.json()) as {
    name?: unknown;
    revision?: unknown;
  };
  return {
    name: typeof data.name === "string" ? data.name : filename,
    revision: typeof data.revision === "string" ? data.revision : null,
  };
};

export const repositoryNoteExists = async (name: string) => {
  const filename = normalizeRepositoryNoteName(name);
  const response = await fetch(`/api/notes/${encodeURIComponent(filename)}`, {
    method: "HEAD",
  });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error("Unable to check repository note");
  }
  return true;
};

export const loadRepositoryNote = async (name: string) => {
  const response = await fetch(`/api/notes/${encodeURIComponent(name)}`);
  if (!response.ok) {
    throw new Error("Unable to load repository note");
  }
  return {
    ...(await loadFromBlob(await response.blob(), null, null)),
    revision: response.headers.get("ETag")?.replaceAll('"', "") || null,
  };
};

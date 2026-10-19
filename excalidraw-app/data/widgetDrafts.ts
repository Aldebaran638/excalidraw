import { del, entries, set } from "idb-keyval";

import type { UseStore } from "idb-keyval";
import type {
  WidgetDefinition,
  WidgetDocument,
} from "../../packages/interactive-widgets/types";

export type WidgetDraft = {
  key: string;
  updated: number;
  note: string | null;
  session: {
    region: { x: number; y: number; width: number; height: number };
    note: string | null;
    target?: string;
    definition?: WidgetDefinition;
  };
  prompt: string;
  context: { id: string; label: string; content: string }[];
  candidates: WidgetDocument[];
  candidateIndex: number;
};

// Use the editor's owning realm, including when mounted inside another window.
export const widgetDraftStore = (ownerWindow: Window): UseStore => {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const request = ownerWindow.indexedDB.open("excalidraw-widget-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return (mode, callback) =>
    db.then((database) =>
      callback(database.transaction("drafts", mode).objectStore("drafts")),
    );
};

export const readWidgetDrafts = async (
  store: UseStore,
  tab: string,
  note: string | null,
) => {
  const all = await entries<string, WidgetDraft>(store);
  const expired = Date.now() - 7 * 86400000;
  await Promise.all(
    all
      .filter(([, value]) => value.updated < expired)
      .map(([key]) => del(key, store)),
  );
  return all
    .map(([, value]) => value)
    .filter(
      (value) =>
        value.updated >= expired &&
        value.key.startsWith(`${tab}:`) &&
        value.note === note,
    )
    .sort((a, b) => b.updated - a.updated);
};

export const saveWidgetDraft = async (store: UseStore, draft: WidgetDraft) => {
  await set(draft.key, draft, store);
  const all = (await entries<string, WidgetDraft>(store)).sort(
    (a, b) => b[1].updated - a[1].updated,
  );
  await Promise.all(
    all
      .filter(
        ([, value], index) =>
          index >= 20 || value.updated < Date.now() - 7 * 86400000,
      )
      .map(([key]) => del(key, store)),
  );
};
export const removeWidgetDraft = (store: UseStore, key: string) =>
  del(key, store);

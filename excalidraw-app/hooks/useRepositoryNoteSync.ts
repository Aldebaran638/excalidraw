import { debounce, randomId } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import {
  createTimestampedRepositoryNoteName,
  normalizeRepositoryNoteName,
  loadRepositoryNote,
  saveRepositoryNote,
  serializeRepositoryNote,
  subscribeToRepositoryNoteChanges,
} from "../data/repositoryNotes";

import { readMetadata } from "../data/noteIdentity";

import type { RepositoryMetadata } from "../data/noteIdentity";

const STORAGE_KEY = "aldebaran.repository-note-name";
const CLIENT_ID_STORAGE_KEY = "aldebaran.repository-note-client-id";
const SAVE_DELAY = 600;

export type RepositorySyncStatus =
  | "unbound"
  | "pending"
  | "syncing"
  | "synced"
  | "external"
  | "missing"
  | "conflict"
  | "unavailable"
  | "error";

type SceneSnapshot = Readonly<{
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
  serializedContent: string;
}>;

const isConflictError = (error: unknown) =>
  error instanceof Error && error.name === "RepositoryNoteConflictError";

export const useRepositoryNoteSync = ({
  excalidrawAPI,
  ownerWindow,
  hasTransientEdits,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  ownerWindow: Window | null;
  hasTransientEdits?: () => boolean;
}) => {
  const [repositoryNoteName, setRepositoryNoteNameState] = useState<
    string | null
  >(null);
  const [status, setStatus] = useState<RepositorySyncStatus>("unbound");
  const [documentSession, setDocumentSession] = useState(0);
  const [repositoryNoteId, setRepositoryNoteId] = useState<string | null>(null);
  const metadataRef = useRef<RepositoryMetadata | null>(null);
  const nameRef = useRef<string | null>(null);
  const revisionRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const applyingRemoteRef = useRef(false);
  const snapshotRef = useRef<SceneSnapshot | null>(null);
  const clientIdRef = useRef<string | null>(null);
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const saveGenerationRef = useRef(0);
  const scheduledContentsRef = useRef<{ token: symbol; content: string }[]>([]);
  const lastPersistedContentRef = useRef<string | null>(null);
  const queuedContentRef = useRef<string | null>(null);
  const availableRef = useRef(false);
  const [available, setAvailable] = useState(false);
  const [externalUpdate, setExternalUpdate] = useState<{
    name: string;
    kind: "updated" | "deleted";
    revision?: string;
  } | null>(null);
  const externalUpdateRef = useRef<typeof externalUpdate>(null);
  const transientRef = useRef(hasTransientEdits);
  transientRef.current = hasTransientEdits;

  const getRepositoryClientId = useCallback(() => {
    if (clientIdRef.current) {
      return clientIdRef.current;
    }
    let clientId: string | null = null;
    if (ownerWindow) {
      try {
        clientId = ownerWindow.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
      } catch {
        // Storage can be unavailable in embedded/private browser contexts.
      }
    }
    clientId ||= randomId();
    clientIdRef.current = clientId;
    if (ownerWindow) {
      try {
        ownerWindow.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
      } catch {
        // The in-memory id still identifies this mounted editor instance.
      }
    }
    return clientId;
  }, [ownerWindow]);

  const setRepositoryNoteName = useCallback(
    (name: string | null) => {
      nameRef.current = name;
      setRepositoryNoteNameState(name);
      if (!ownerWindow) {
        return;
      }
      if (name) {
        ownerWindow.localStorage.setItem(STORAGE_KEY, name);
      } else {
        ownerWindow.localStorage.removeItem(STORAGE_KEY);
      }
    },
    [ownerWindow],
  );

  const applyRepositoryNote = useCallback(
    async (name: string, source: "open" | "external" | "initial") => {
      if (!excalidrawAPI) {
        return;
      }
      applyingRemoteRef.current = true;
      try {
        const data = await loadRepositoryNote(name);
        metadataRef.current = data.metadata;
        setRepositoryNoteId(data.metadata?.noteId || null);
        const currentAppState = excalidrawAPI.getAppState();
        const restoredAppState = restoreAppState(
          data.appState,
          currentAppState,
        );
        // Chat is application chrome, not a document property. Loading a note
        // must not close its conversations or interrupt their background streams.
        if (currentAppState.openSidebar?.tab === "note-chat") {
          restoredAppState.openSidebar = currentAppState.openSidebar;
        }
        excalidrawAPI.updateScene({
          elements: restoreElements(data.elements, null, {
            repairBindings: true,
          }),
          // A filesystem edit should update the drawing without moving the
          // user's camera. Explicitly opening a note still restores its
          // persisted viewport.
          appState: source === "external" ? undefined : restoredAppState,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        if (data.files) {
          excalidrawAPI.addFiles(Object.values(data.files));
        }
        lastPersistedContentRef.current = serializeRepositoryNote(
          excalidrawAPI.getSceneElementsIncludingDeleted(),
          source === "external"
            ? currentAppState
            : { ...currentAppState, ...restoredAppState },
          excalidrawAPI.getFiles(),
          metadataRef.current,
        );
        queuedContentRef.current = null;
        revisionRef.current = data.revision;
        setRepositoryNoteName(name);
        setStatus(source === "external" ? "external" : "synced");
      } finally {
        const releaseRemoteApply = () => {
          applyingRemoteRef.current = false;
        };
        if (ownerWindow) {
          // React may deliver the scene change callback after the current
          // microtask. Keep the guard through the next task so an external
          // update cannot immediately schedule a write-back.
          ownerWindow.setTimeout(releaseRemoteApply, 0);
        } else {
          releaseRemoteApply();
        }
      }
    },
    [excalidrawAPI, ownerWindow, setRepositoryNoteName],
  );

  const performSaveSnapshot = useCallback(
    async (
      snapshot: SceneSnapshot,
      explicitName?: string,
      generation = saveGenerationRef.current,
    ) => {
      const isAutomaticCreate = !explicitName && !nameRef.current;
      let targetName = explicitName
        ? normalizeRepositoryNoteName(explicitName)
        : nameRef.current;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (!targetName) {
          targetName = createTimestampedRepositoryNoteName(
            new Date(Date.now() + attempt),
          );
        }
        setStatus("syncing");
        try {
          // Save As owns the target's identity, never the source's chat history.
          let metadata = metadataRef.current;
          if (explicitName && targetName !== nameRef.current) {
            if (!ownerWindow) {
              throw new Error("编辑器尚未准备好");
            }
            const target = await ownerWindow.fetch(
              `/api/notes/${encodeURIComponent(targetName)}`,
            );
            if (target.status === 404) {
              metadata = null;
            } else if (!target.ok) {
              throw new Error("无法确认目标笔记身份，未覆盖文件");
            } else {
              metadata = readMetadata((await target.json()).repositoryMetadata);
            }
          }
          const serialized = JSON.parse(snapshot.serializedContent);
          delete serialized.repositoryMetadata;
          if (metadata) {
            serialized.repositoryMetadata = metadata;
          }
          const serializedContent = JSON.stringify(serialized, null, 2);
          const result = await saveRepositoryNote(
            targetName,
            snapshot.elements,
            snapshot.appState,
            snapshot.files,
            {
              expectedRevision:
                targetName === nameRef.current ? revisionRef.current : null,
              createOnly: isAutomaticCreate,
              clientId: getRepositoryClientId(),
              serializedContent,
            },
          );
          // The write may finish after another document was opened. Persisting
          // its original file is valid; rebinding the new canvas is not.
          if (generation !== saveGenerationRef.current) {
            return undefined;
          }
          revisionRef.current = result.revision;
          metadataRef.current = metadata;
          setRepositoryNoteId(metadata?.noteId || null);
          lastPersistedContentRef.current = serializedContent;
          if (queuedContentRef.current === snapshot.serializedContent) {
            queuedContentRef.current = null;
          }
          setRepositoryNoteName(result.name);
          setStatus(queuedContentRef.current ? "pending" : "synced");
          return result.name;
        } catch (error) {
          if (generation !== saveGenerationRef.current) {
            excalidrawAPI?.setToast({
              message: `上一个笔记 ${targetName} 保存失败，请重新打开核对。当前笔记绑定未改变。`,
              duration: 5000,
            });
            return undefined;
          }
          if (
            isAutomaticCreate &&
            error instanceof Error &&
            error.name === "RepositoryNoteConflictError"
          ) {
            targetName = null;
            continue;
          }
          if (isConflictError(error) && nameRef.current) {
            saveGenerationRef.current += 1;
            const change = { name: nameRef.current, kind: "updated" as const };
            externalUpdateRef.current = change;
            setExternalUpdate(change);
            setStatus("conflict");
            throw error;
          }
          setStatus("error");
          throw error;
        }
      }
      setStatus("error");
      throw new Error("Unable to create a unique repository note name");
    },
    [getRepositoryClientId, setRepositoryNoteName, ownerWindow, excalidrawAPI],
  );

  // Serialize all writes. A debounced autosave and an explicit Save/Save As
  // must never race with one another or overwrite a newer snapshot.
  const saveSnapshot = useCallback(
    (snapshot: SceneSnapshot, explicitName?: string) => {
      const generation = saveGenerationRef.current;
      const token = Symbol("repository-save");
      scheduledContentsRef.current.push({
        token,
        content: snapshot.serializedContent,
      });
      const nextSave = saveQueueRef.current.then(() => {
        if (generation !== saveGenerationRef.current) {
          if (queuedContentRef.current === snapshot.serializedContent) {
            queuedContentRef.current = null;
          }
          return undefined;
        }
        return performSaveSnapshot(snapshot, explicitName, generation);
      });
      const completedSave = nextSave.finally(() => {
        scheduledContentsRef.current = scheduledContentsRef.current.filter(
          (item) => item.token !== token,
        );
      });
      saveQueueRef.current = completedSave.catch(() => {
        if (queuedContentRef.current === snapshot.serializedContent) {
          queuedContentRef.current = null;
        }
        return undefined;
      });
      return completedSave;
    },
    [performSaveSnapshot],
  );

  const debouncedSave = useMemo(
    () =>
      debounce(() => {
        const snapshot = snapshotRef.current;
        if (!snapshot) {
          return;
        }
        void saveSnapshot(snapshot).catch(() => {});
      }, SAVE_DELAY),
    [saveSnapshot],
  );

  const queueSceneSave = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      if (
        !availableRef.current ||
        !readyRef.current ||
        applyingRemoteRef.current ||
        externalUpdateRef.current
      ) {
        return;
      }
      if (!nameRef.current && !elements.some((element) => !element.isDeleted)) {
        return;
      }
      const serializedContent = serializeRepositoryNote(
        elements,
        appState,
        files,
        metadataRef.current,
      );
      if (
        serializedContent === lastPersistedContentRef.current &&
        !scheduledContentsRef.current.some(
          (item) => item.content !== serializedContent,
        )
      ) {
        snapshotRef.current = null;
        queuedContentRef.current = null;
        debouncedSave.cancel();
        setStatus("synced");
        return;
      }
      if (serializedContent === queuedContentRef.current) {
        return;
      }
      snapshotRef.current = {
        elements,
        appState,
        files,
        serializedContent,
      };
      queuedContentRef.current = serializedContent;
      setStatus("pending");
      debouncedSave();
    },
    [debouncedSave],
  );

  const saveCurrent = useCallback(async () => {
    if (!excalidrawAPI) {
      return;
    }
    debouncedSave.cancel();
    const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
    const appState = excalidrawAPI.getAppState();
    const files = excalidrawAPI.getFiles();
    return saveSnapshot({
      elements,
      appState,
      files,
      serializedContent: serializeRepositoryNote(
        elements,
        appState,
        files,
        metadataRef.current,
      ),
    });
  }, [debouncedSave, excalidrawAPI, saveSnapshot]);

  const saveAs = useCallback(
    async (name: string) => {
      if (!excalidrawAPI) {
        throw new Error("Editor is not ready");
      }
      debouncedSave.cancel();
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
      const appState = excalidrawAPI.getAppState();
      const files = excalidrawAPI.getFiles();
      return saveSnapshot(
        {
          elements,
          appState,
          files,
          serializedContent: serializeRepositoryNote(
            elements,
            appState,
            files,
            metadataRef.current,
          ),
        },
        name,
      );
    },
    [debouncedSave, excalidrawAPI, saveSnapshot],
  );

  const open = useCallback(
    async (name: string) => {
      saveGenerationRef.current += 1;
      debouncedSave.cancel();
      await applyRepositoryNote(name, "open");
      setDocumentSession((value) => value + 1);
    },
    [applyRepositoryNote, debouncedSave],
  );

  const flush = useCallback(() => debouncedSave.flush(), [debouncedSave]);
  const ensureNoteIdentity = useCallback(
    async (fork = false) => {
      if (externalUpdateRef.current) {
        throw new Error("请先处理本地笔记冲突");
      }
      if (!availableRef.current) {
        throw new Error("本地笔记服务不可用");
      }
      const generation = saveGenerationRef.current;
      await saveQueueRef.current;
      if (generation !== saveGenerationRef.current) {
        throw new Error("笔记已切换，请重试");
      }
      if (
        !fork &&
        metadataRef.current?.noteId === repositoryNoteId &&
        repositoryNoteId &&
        nameRef.current
      ) {
        return { noteId: repositoryNoteId, name: nameRef.current };
      }
      if (fork || !metadataRef.current) {
        metadataRef.current = { version: 1, noteId: randomId() };
      }
      const expectedId = metadataRef.current.noteId;
      const name = await saveCurrent();
      if (!name || metadataRef.current?.noteId !== expectedId) {
        throw new Error("笔记已切换，请重新创建会话");
      }
      return { noteId: expectedId, name };
    },
    [saveCurrent, repositoryNoteId],
  );

  useEffect(() => () => debouncedSave.cancel(), [debouncedSave]);
  useEffect(
    () =>
      excalidrawAPI?.onEvent("document:replace", () => {
        if (applyingRemoteRef.current) {
          return;
        }
        saveGenerationRef.current++;
        debouncedSave.cancel();
        metadataRef.current = null;
        setRepositoryNoteId(null);
        revisionRef.current = null;
        snapshotRef.current = null;
        queuedContentRef.current = null;
        lastPersistedContentRef.current = null;
        setRepositoryNoteName(null);
        setDocumentSession((value) => value + 1);
        setStatus("unbound");
      }),
    [excalidrawAPI, debouncedSave, setRepositoryNoteName],
  );

  useEffect(() => {
    if (!excalidrawAPI || !ownerWindow || readyRef.current) {
      return;
    }
    void ownerWindow
      .fetch("/api/health")
      .then(async (res) => {
        if (!res.ok || !(await res.json()).repositoryNotes) {
          throw new Error("Repository API unavailable");
        }
        availableRef.current = true;
        setAvailable(true);
        const savedName = ownerWindow.localStorage.getItem(STORAGE_KEY);
        if (savedName) {
          await applyRepositoryNote(savedName, "initial").catch(() => {
            setRepositoryNoteName(null);
            setStatus("missing");
          });
        }
        readyRef.current = true;
      })
      .catch(() => {
        setStatus("unavailable");
        readyRef.current = true;
      });
  }, [applyRepositoryNote, excalidrawAPI, ownerWindow, setRepositoryNoteName]);

  useEffect(() => {
    if (!excalidrawAPI || !ownerWindow || !available) {
      return;
    }
    const receive = (change: {
      name: string;
      kind: "updated" | "deleted";
      revision?: string;
      sourceId?: string;
    }) => {
      if (change.sourceId === getRepositoryClientId()) {
        return;
      }
      if (change.name !== nameRef.current) {
        return;
      }
      if (change.revision && change.revision === revisionRef.current) {
        return;
      }
      if (queuedContentRef.current || transientRef.current?.()) {
        saveGenerationRef.current += 1;
        debouncedSave.cancel();
        externalUpdateRef.current = change;
        setExternalUpdate(change);
        setStatus("conflict");
        return;
      }
      if (change.kind === "deleted") {
        saveGenerationRef.current += 1;
        debouncedSave.cancel();
        revisionRef.current = null;
        setRepositoryNoteName(null);
        setStatus("missing");
        excalidrawAPI.setToast({
          message: `${change.name} was deleted locally. The canvas is preserved.`,
          duration: 3500,
        });
        return;
      }
      saveGenerationRef.current += 1;
      debouncedSave.cancel();
      void applyRepositoryNote(change.name, "external")
        .then(() => {
          excalidrawAPI.setToast({
            message: `Updated ${change.name} from the local file`,
            duration: 1800,
          });
        })
        .catch(() => {
          setStatus("error");
        });
    };
    return subscribeToRepositoryNoteChanges(receive, ownerWindow, () => {
      const name = nameRef.current;
      if (!name) {
        return;
      }
      void ownerWindow
        .fetch(`/api/notes/${encodeURIComponent(name)}`, { method: "HEAD" })
        .then((res) => {
          if (res.status === 404) {
            receive({ name, kind: "deleted" });
            return;
          }
          const revision = res.headers.get("ETag")?.replaceAll('"', "");
          if (res.ok && revision && revision !== revisionRef.current) {
            receive({ name, kind: "updated", revision });
          }
        })
        .catch(() => {
          /* Keep the canvas while offline. */
        });
    });
  }, [
    applyRepositoryNote,
    debouncedSave,
    excalidrawAPI,
    getRepositoryClientId,
    setRepositoryNoteName,
    ownerWindow,
    available,
  ]);

  const resolveExternalUpdate = useCallback(
    async (choice: "discard" | "copy") => {
      const change = externalUpdateRef.current;
      if (!change || !excalidrawAPI) {
        return;
      }
      if (choice === "copy") {
        await saveAs(createTimestampedRepositoryNoteName());
      } else if (change.kind === "deleted") {
        revisionRef.current = null;
        setRepositoryNoteName(null);
        setStatus("missing");
      } else {
        await applyRepositoryNote(change.name, "external");
      }
      queuedContentRef.current = null;
      snapshotRef.current = null;
      externalUpdateRef.current = null;
      setExternalUpdate(null);
    },
    [excalidrawAPI, saveAs, applyRepositoryNote, setRepositoryNoteName],
  );

  return {
    flush,
    open,
    queueSceneSave,
    repositoryNoteName,
    repositoryNoteId,
    ensureNoteIdentity,
    documentSession,
    saveAs,
    saveCurrent,
    status,
    externalUpdate,
    resolveExternalUpdate,
    available,
  };
};

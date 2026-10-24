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
  RepositoryNoteLoadError,
} from "../data/repositoryNotes";

import { readMetadata } from "../data/noteIdentity";
import { forkHtmlApps } from "../data/htmlApps";
import { readCanvasHtmlApp } from "../data/chatHtml";

import type { RepositoryMetadata } from "../data/noteIdentity";

const STORAGE_KEY = "aldebaran.repository-note-name";
const RECOVERY_KEY = "aldebaran.repository-note-recovery";
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

export type RepositoryLoadFailure = {
  name: string;
  kind: "missing" | "error";
  message: string;
};

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
  const loadBlockedRef = useRef<
    (RepositoryLoadFailure & { baseline: string; review?: boolean }) | null
  >(null);
  const [loadFailure, setLoadFailure] = useState<RepositoryLoadFailure | null>(
    null,
  );
  const [retryingLoad, setRetryingLoad] = useState(false);
  const retryingLoadRef = useRef(false);
  const loadRequestRef = useRef(0);
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
    recovery?: boolean;
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

  const currentContent = useCallback(
    () =>
      excalidrawAPI
        ? JSON.stringify({
            elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
            files: excalidrawAPI.getFiles(),
            background: excalidrawAPI.getAppState().viewBackgroundColor,
          })
        : "",
    [excalidrawAPI],
  );

  const markRecovery = useCallback(
    (name: string | null) => {
      try {
        if (name) {
          ownerWindow?.localStorage.setItem(RECOVERY_KEY, name);
        } else {
          ownerWindow?.localStorage.removeItem(RECOVERY_KEY);
        }
      } catch {
        // The in-memory guard still protects this page if storage is unavailable.
      }
    },
    [ownerWindow],
  );

  const blockLoad = useCallback(
    (name: string, error: unknown) => {
      const failure: RepositoryLoadFailure = {
        name,
        kind:
          error instanceof RepositoryNoteLoadError && error.status === 404
            ? "missing"
            : "error",
        message: error instanceof Error ? error.message : "笔记读取失败",
      };
      loadBlockedRef.current = {
        ...failure,
        review: loadBlockedRef.current?.review,
        baseline:
          loadBlockedRef.current?.name === name
            ? loadBlockedRef.current.baseline
            : currentContent(),
      };
      setLoadFailure(failure);
      setStatus(failure.kind);
      markRecovery(name);
    },
    [currentContent, markRecovery],
  );

  const applyRepositoryNote = useCallback(
    async (
      name: string,
      source: "open" | "external" | "initial",
      loaded?: Awaited<ReturnType<typeof loadRepositoryNote>>,
    ) => {
      if (!excalidrawAPI) {
        return;
      }
      applyingRemoteRef.current = true;
      const request = ++loadRequestRef.current;
      const generation = saveGenerationRef.current;
      const baseline =
        loadBlockedRef.current?.name === name
          ? loadBlockedRef.current.baseline
          : currentContent();
      try {
        const data = loaded ?? (await loadRepositoryNote(name));
        if (
          request !== loadRequestRef.current ||
          generation !== saveGenerationRef.current
        ) {
          return;
        }
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
        loadBlockedRef.current = null;
        markRecovery(null);
        setLoadFailure(null);
        setRepositoryNoteName(name);
        setStatus(source === "external" ? "external" : "synced");
      } catch (error) {
        if (
          source !== "open" &&
          request === loadRequestRef.current &&
          generation === saveGenerationRef.current
        ) {
          blockLoad(name, error);
          loadBlockedRef.current!.baseline = baseline;
        }
        throw error;
      } finally {
        const releaseRemoteApply = () => {
          if (request === loadRequestRef.current) {
            applyingRemoteRef.current = false;
          }
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
    [
      excalidrawAPI,
      ownerWindow,
      setRepositoryNoteName,
      currentContent,
      blockLoad,
      markRecovery,
    ],
  );

  const performSaveSnapshot = useCallback(
    async (
      snapshot: SceneSnapshot,
      explicitName?: string,
      generation = saveGenerationRef.current,
    ) => {
      if (
        loadBlockedRef.current &&
        (!explicitName ||
          normalizeRepositoryNoteName(explicitName) ===
            loadBlockedRef.current.name)
      ) {
        throw new Error(
          "原笔记尚未成功读取，自动保存已暂停。请重试读取，或明确另存为其他文件。",
        );
      }
      if (!readyRef.current) {
        throw new Error("本地笔记服务尚未准备好，请稍后重试");
      }
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
          const independentCopy = Boolean(
            explicitName && targetName !== nameRef.current,
          );
          if (independentCopy) {
            metadata ||= { version: 1, noteId: randomId() };
            serialized.elements = forkHtmlApps(snapshot.elements);
          }
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
          if (independentCopy && excalidrawAPI) {
            const identities = new Map<string, string>(
              serialized.elements.flatMap(
                (element: OrderedExcalidrawElement) => {
                  const app = readCanvasHtmlApp(element.customData?.htmlApp);
                  return app ? [[element.id, app.appId] as const] : [];
                },
              ),
            );
            // Save As may take time: rebase identities onto the live scene, never
            // restore the older snapshot over edits made while the request ran.
            excalidrawAPI.updateScene({
              elements: forkHtmlApps(
                excalidrawAPI.getSceneElementsIncludingDeleted(),
                new Set(),
                identities,
              ),
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
          setRepositoryNoteId(metadata?.noteId || null);
          lastPersistedContentRef.current = serializedContent;
          if (queuedContentRef.current === snapshot.serializedContent) {
            queuedContentRef.current = null;
          }
          setRepositoryNoteName(result.name);
          loadBlockedRef.current = null;
          markRecovery(null);
          setLoadFailure(null);
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
    [
      getRepositoryClientId,
      setRepositoryNoteName,
      ownerWindow,
      excalidrawAPI,
      markRecovery,
    ],
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
        loadBlockedRef.current ||
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
      if (loadBlockedRef.current) {
        throw new Error(
          "原笔记尚未成功读取，请先重试读取或手动另存为；不会自动创建新笔记。",
        );
      }
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
        if (fork && excalidrawAPI) {
          excalidrawAPI.updateScene({
            elements: forkHtmlApps(
              excalidrawAPI.getSceneElementsIncludingDeleted(),
            ),
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
      }
      const expectedId = metadataRef.current.noteId;
      const name = await saveCurrent();
      if (!name || metadataRef.current?.noteId !== expectedId) {
        throw new Error("笔记已切换，请重新创建会话");
      }
      return { noteId: expectedId, name };
    },
    [saveCurrent, repositoryNoteId, excalidrawAPI],
  );

  useEffect(() => () => debouncedSave.cancel(), [debouncedSave]);
  useEffect(
    () =>
      excalidrawAPI?.onEvent("document:replace", () => {
        // updateScene() does not emit document:replace. An explicit import or
        // new document must invalidate even a currently pending repository read.
        saveGenerationRef.current++;
        loadRequestRef.current++;
        applyingRemoteRef.current = false;
        loadBlockedRef.current = null;
        markRecovery(null);
        setLoadFailure(null);
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
        const imported = excalidrawAPI.getSceneElementsIncludingDeleted();
        const independent = forkHtmlApps(imported);
        if (independent.some((element, index) => element !== imported[index])) {
          excalidrawAPI.updateScene({
            elements: independent,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
      }),
    [excalidrawAPI, debouncedSave, setRepositoryNoteName, markRecovery],
  );

  useEffect(() => {
    if (!excalidrawAPI || !ownerWindow || readyRef.current) {
      return;
    }
    // Restore the binding before I/O. A failed read is NOT a new document.
    const savedName = ownerWindow.localStorage.getItem(STORAGE_KEY);
    const recoveringDraft =
      !!savedName &&
      ownerWindow.localStorage.getItem(RECOVERY_KEY) === savedName;
    const generation = saveGenerationRef.current;
    if (savedName) {
      setRepositoryNoteName(savedName);
      loadBlockedRef.current = {
        name: savedName,
        kind: "error",
        message: "正在读取原笔记",
        baseline: currentContent(),
        review: recoveringDraft,
      };
      if (recoveringDraft) {
        blockLoad(
          savedName,
          new Error(
            "上次读取未完成，已保留浏览器中的画布。请重试读取并确认恢复方式。",
          ),
        );
      }
    }
    void ownerWindow
      .fetch("/api/health")
      .then(async (res) => {
        if (!res.ok || !(await res.json()).repositoryNotes) {
          throw new Error("Repository API unavailable");
        }
        availableRef.current = true;
        setAvailable(true);
        if (generation !== saveGenerationRef.current) {
          readyRef.current = true;
          return;
        }
        if (savedName && !recoveringDraft) {
          await applyRepositoryNote(savedName, "initial").catch((error) => {
            if (generation === saveGenerationRef.current) {
              blockLoad(savedName, error);
            }
          });
        }
        readyRef.current = true;
      })
      .catch(() => {
        if (generation !== saveGenerationRef.current) {
          readyRef.current = true;
          return;
        }
        if (savedName) {
          blockLoad(savedName, new Error("本地笔记服务暂时无法连接"));
        } else {
          setStatus("unavailable");
        }
        readyRef.current = true;
      });
  }, [
    applyRepositoryNote,
    excalidrawAPI,
    ownerWindow,
    setRepositoryNoteName,
    blockLoad,
    currentContent,
  ]);

  const retryLoad = useCallback(async () => {
    const blocked = loadBlockedRef.current;
    if (!blocked || retryingLoadRef.current) {
      return;
    }
    retryingLoadRef.current = true;
    setRetryingLoad(true);
    const generation = saveGenerationRef.current;
    try {
      const data = await loadRepositoryNote(blocked.name);
      if (
        generation !== saveGenerationRef.current ||
        loadBlockedRef.current !== blocked
      ) {
        return;
      }
      availableRef.current = true;
      setAvailable(true);
      readyRef.current = true;
      if (
        blocked.review ||
        currentContent() !== blocked.baseline ||
        transientRef.current?.()
      ) {
        const change = {
          name: blocked.name,
          kind: "updated" as const,
          revision: data.revision ?? undefined,
          recovery: true,
        };
        externalUpdateRef.current = change;
        setExternalUpdate(change);
        setStatus("conflict");
      } else {
        await applyRepositoryNote(blocked.name, "external", data);
      }
    } catch (error) {
      if (
        generation === saveGenerationRef.current &&
        loadBlockedRef.current === blocked
      ) {
        blockLoad(blocked.name, error);
      }
    } finally {
      retryingLoadRef.current = false;
      setRetryingLoad(false);
    }
  }, [applyRepositoryNote, blockLoad, currentContent]);

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
      if (loadBlockedRef.current) {
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
        blockLoad(change.name, new RepositoryNoteLoadError(404));
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
        .catch((error) => {
          blockLoad(change.name, error);
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
    blockLoad,
  ]);

  const resolveExternalUpdate = useCallback(
    async (choice: "discard" | "copy") => {
      const change = externalUpdateRef.current;
      if (!change || !excalidrawAPI) {
        return;
      }
      const generation = saveGenerationRef.current;
      try {
        if (choice === "copy") {
          await saveAs(createTimestampedRepositoryNoteName());
        } else if (change.kind === "deleted") {
          blockLoad(change.name, new RepositoryNoteLoadError(404));
          externalUpdateRef.current = null;
          setExternalUpdate(null);
          return;
        } else {
          await applyRepositoryNote(change.name, "external");
        }
        if (generation !== saveGenerationRef.current) {
          return;
        }
        queuedContentRef.current = null;
        snapshotRef.current = null;
        externalUpdateRef.current = null;
        setExternalUpdate(null);
      } catch (error) {
        if (generation === saveGenerationRef.current) {
          excalidrawAPI.setToast({
            message: `恢复未完成，当前画布已保留：${
              error instanceof Error ? error.message : "请重试"
            }`,
            duration: 5000,
          });
        }
      }
    },
    [excalidrawAPI, saveAs, applyRepositoryNote, blockLoad],
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
    loadFailure,
    retryLoad,
    retryingLoad,
  };
};

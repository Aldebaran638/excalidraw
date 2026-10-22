import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { newElement } from "@excalidraw/element";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useRepositoryNoteSync } from "../hooks/useRepositoryNoteSync";
import {
  loadRepositoryNote,
  RepositoryNoteLoadError,
  saveRepositoryNote,
  subscribeToRepositoryNoteChanges,
} from "../data/repositoryNotes";

vi.mock("../data/repositoryNotes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/repositoryNotes")>()),
  loadRepositoryNote: vi.fn(),
  saveRepositoryNote: vi.fn(),
  subscribeToRepositoryNoteChanges: vi.fn(() => () => {}),
}));

const NAME = "original.excalidraw";
const KEY = "aldebaran.repository-note-name";
const load = vi.mocked(loadRepositoryNote);
const save = vi.mocked(saveRepositoryNote);
const loaded = () =>
  ({
    elements: [],
    appState: {},
    files: {},
    metadata: { version: 1, noteId: "original-note-id" },
    revision: "original-revision",
  } as unknown as Awaited<ReturnType<typeof loadRepositoryNote>>);

const setup = () => {
  let elements: readonly OrderedExcalidrawElement[] = [];
  let state = {
    ...getDefaultAppState(),
    scrollX: 123,
    scrollY: 456,
    width: 1440,
    height: 1000,
    offsetTop: 0,
    offsetLeft: 0,
  };
  let replaceDocument = () => {};
  const updateScene = vi.fn((update) => {
    if (update.elements) {
      elements = update.elements;
    }
    if (update.appState) {
      state = { ...state, ...update.appState };
    }
  });
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => state,
    getFiles: () => ({}),
    updateScene,
    addFiles: vi.fn(),
    setToast: vi.fn(),
    onEvent: (_name: string, listener: () => void) => {
      replaceDocument = listener;
      return () => {};
    },
  } as unknown as ExcalidrawImperativeAPI;
  const hook = renderHook(() =>
    useRepositoryNoteSync({ excalidrawAPI: api, ownerWindow: window }),
  );
  return {
    ...hook,
    api,
    updateScene,
    replace: () => act(() => replaceDocument()),
    edit: () =>
      act(() => {
        elements = [
          newElement({
            type: "rectangle",
            x: 10,
            y: 20,
            width: 30,
            height: 40,
          }) as OrderedExcalidrawElement,
        ];
        hook.result.current.queueSceneSave(elements, state, {});
      }),
  };
};

describe("repository binding recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    load.mockReset();
    save.mockReset();
    localStorage.setItem(KEY, NAME);
    localStorage.removeItem("aldebaran.repository-note-recovery");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ repositoryNotes: true }),
      }),
    );
    save.mockResolvedValue({ name: NAME, revision: "saved-revision" });
  });
  afterEach(() => {
    cleanup();
    localStorage.removeItem(KEY);
    localStorage.removeItem("aldebaran.repository-note-recovery");
    vi.unstubAllGlobals();
  });

  it.each([
    ["network", new TypeError("Failed to fetch"), "error"],
    ["HTTP 500", new RepositoryNoteLoadError(500), "error"],
    ["HTTP 404", new RepositoryNoteLoadError(404), "missing"],
    ["malformed file", new SyntaxError("Invalid JSON"), "error"],
  ])(
    "preserves binding and blocks automatic/manual writes after %s",
    async (_label, error, status) => {
      load.mockRejectedValue(error);
      const h = setup();
      await waitFor(() =>
        expect(h.result.current.loadFailure?.kind).toBe(status),
      );
      expect(h.result.current.repositoryNoteName).toBe(NAME);
      expect(localStorage.getItem(KEY)).toBe(NAME);
      expect(h.updateScene).not.toHaveBeenCalled();
      h.edit();
      await act(async () => {
        h.result.current.flush();
      });
      await expect(h.result.current.saveCurrent()).rejects.toThrow(
        "原笔记尚未成功读取",
      );
      await expect(h.result.current.ensureNoteIdentity()).rejects.toThrow(
        "不会自动创建新笔记",
      );
      expect(save).not.toHaveBeenCalled();
      expect(h.result.current.repositoryNoteId).toBeNull();
    },
  );

  it("retains the binding when the health check fails, and can recover", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const h = setup();
    await waitFor(() => expect(h.result.current.loadFailure).not.toBeNull());
    expect(load).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe(NAME);
    load.mockResolvedValue(loaded());
    await act(async () => {
      await h.result.current.retryLoad();
    });
    expect(h.result.current.loadFailure).toBeNull();
    expect(h.result.current.available).toBe(true);
    expect(h.result.current.repositoryNoteId).toBe("original-note-id");
    expect(h.api.getAppState()).toMatchObject({ scrollX: 123, scrollY: 456 });
  });

  it("successful retry resumes writes to the SAME file with its revision and identity", async () => {
    load.mockRejectedValueOnce(new RepositoryNoteLoadError(500));
    const h = setup();
    await waitFor(() => expect(h.result.current.loadFailure).not.toBeNull());
    load.mockResolvedValue(loaded());
    await act(async () => {
      await h.result.current.retryLoad();
    });
    expect(h.result.current.loadFailure).toBeNull();
    expect(h.result.current.repositoryNoteName).toBe(NAME);
    expect(h.updateScene.mock.calls[0][0].appState).toBeUndefined();
    // Remote-apply guard releases on the next task, then local edits save normally.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    h.edit();
    await act(async () => {
      await h.result.current.flush();
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toBe(NAME);
    expect(save.mock.calls[0][4]).toMatchObject({
      expectedRevision: "original-revision",
      createOnly: false,
    });
    expect(
      JSON.parse(save.mock.calls[0][4]!.serializedContent!).repositoryMetadata
        .noteId,
    ).toBe("original-note-id");
  });

  it("does not overwrite edits made while paused; explicit discard loads the original", async () => {
    load.mockRejectedValueOnce(new RepositoryNoteLoadError(500));
    const h = setup();
    await waitFor(() => expect(h.result.current.loadFailure).not.toBeNull());
    h.edit();
    load.mockResolvedValue(loaded());
    await act(async () => {
      await h.result.current.retryLoad();
    });
    expect(h.result.current.status).toBe("conflict");
    expect(h.result.current.externalUpdate).toMatchObject({
      name: NAME,
      recovery: true,
    });
    expect(h.updateScene).not.toHaveBeenCalled();
    expect(h.api.getSceneElementsIncludingDeleted()).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      await h.result.current.resolveExternalUpdate("discard");
    });
    expect(h.result.current.loadFailure).toBeNull();
    expect(h.api.getSceneElementsIncludingDeleted()).toHaveLength(0);
    expect(h.result.current.repositoryNoteId).toBe("original-note-id");
  });

  it("allows an explicitly named new file, but never overwrites the unread original", async () => {
    load.mockRejectedValue(new RepositoryNoteLoadError(500));
    const h = setup();
    await waitFor(() => expect(h.result.current.loadFailure).not.toBeNull());
    await expect(h.result.current.saveAs(NAME)).rejects.toThrow(
      "原笔记尚未成功读取",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    save.mockResolvedValue({
      name: "chosen-copy.excalidraw",
      revision: "copy-revision",
    });
    await act(async () => {
      await h.result.current.saveAs("chosen-copy");
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toBe("chosen-copy.excalidraw");
    expect(h.result.current.loadFailure).toBeNull();
    expect(h.result.current.repositoryNoteName).toBe("chosen-copy.excalidraw");
  });

  it("keeps a deleted file bound and pauses writes instead of recreating it", async () => {
    load.mockResolvedValue(loaded());
    const h = setup();
    await waitFor(() => expect(h.result.current.status).toBe("synced"));
    const receive = vi
      .mocked(subscribeToRepositoryNoteChanges)
      .mock.calls.at(-1)![0];
    act(() => receive({ name: NAME, kind: "deleted" }));
    expect(h.result.current.loadFailure?.kind).toBe("missing");
    expect(h.result.current.repositoryNoteName).toBe(NAME);
    expect(h.result.current.repositoryNoteId).toBe("original-note-id");
    expect(localStorage.getItem(KEY)).toBe(NAME);
    h.edit();
    await expect(h.result.current.saveCurrent()).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it("a late retry cannot restore the old note after a new document replaces it", async () => {
    load.mockRejectedValueOnce(new RepositoryNoteLoadError(500));
    const h = setup();
    await waitFor(() => expect(h.result.current.loadFailure).not.toBeNull());
    let finish!: (data: ReturnType<typeof loaded>) => void;
    load.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let retry!: Promise<void>;
    act(() => {
      retry = h.result.current.retryLoad();
    });
    h.replace();
    await act(async () => {
      finish(loaded());
      await retry;
    });
    expect(h.result.current.repositoryNoteName).toBeNull();
    expect(h.result.current.loadFailure).toBeNull();
    expect(h.updateScene).not.toHaveBeenCalled();
  });

  it("invalidates a pending initial read when the user imports a different document", async () => {
    let finish!: (data: ReturnType<typeof loaded>) => void;
    load.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const h = setup();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    h.replace();
    await act(async () => {
      finish(loaded());
    });
    expect(h.result.current.repositoryNoteName).toBeNull();
    expect(h.result.current.repositoryNoteId).toBeNull();
    expect(h.updateScene).not.toHaveBeenCalled();
  });

  it("preserves earlier unsaved edits across multiple unsuccessful retries", async () => {
    load.mockRejectedValue(new RepositoryNoteLoadError(500));
    const h = setup();
    await waitFor(() => expect(h.result.current.loadFailure).not.toBeNull());
    h.edit();
    await act(async () => {
      await h.result.current.retryLoad();
    });
    load.mockResolvedValue(loaded());
    await act(async () => {
      await h.result.current.retryLoad();
    });
    expect(h.result.current.status).toBe("conflict");
    expect(h.updateScene).not.toHaveBeenCalled();
    expect(h.api.getSceneElementsIncludingDeleted()).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("still automatically creates a file for a genuine unbound new drawing", async () => {
    localStorage.removeItem(KEY);
    const h = setup();
    await waitFor(() => expect(h.result.current.available).toBe(true));
    h.edit();
    await act(async () => {
      await h.result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatch(/^note-.*\.excalidraw$/);
    expect(save.mock.calls[0][4]).toMatchObject({ createOnly: true });
  });

  it("a paused canvas survives refresh without silently loading the server over it", async () => {
    localStorage.setItem("aldebaran.repository-note-recovery", NAME);
    load.mockResolvedValue(loaded());
    const h = setup();
    await waitFor(() => expect(h.result.current.loadFailure).not.toBeNull());
    expect(load).not.toHaveBeenCalled();
    expect(h.updateScene).not.toHaveBeenCalled();
    await act(async () => {
      await h.result.current.retryLoad();
    });
    expect(h.result.current.status).toBe("conflict");
    expect(h.updateScene).not.toHaveBeenCalled();
    await act(async () => {
      await h.result.current.resolveExternalUpdate("discard");
    });
    expect(
      localStorage.getItem("aldebaran.repository-note-recovery"),
    ).toBeNull();
    expect(h.result.current.loadFailure).toBeNull();
  });

  it("failed confirmation keeps edits and the recovery guard without an unhandled rejection", async () => {
    load.mockRejectedValueOnce(new RepositoryNoteLoadError(500));
    const h = setup();
    await waitFor(() => expect(h.result.current.loadFailure).not.toBeNull());
    h.edit();
    load.mockResolvedValueOnce(loaded());
    await act(async () => {
      await h.result.current.retryLoad();
    });
    load.mockRejectedValue(new RepositoryNoteLoadError(404));
    await act(async () => {
      await h.result.current.resolveExternalUpdate("discard");
    });
    expect(h.result.current.loadFailure?.kind).toBe("missing");
    expect(h.api.getSceneElementsIncludingDeleted()).toHaveLength(1);
    expect(h.api.setToast).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await expect(h.result.current.saveCurrent()).rejects.toThrow();
  });
});

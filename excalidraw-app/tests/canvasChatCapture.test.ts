import { expect, it, vi } from "vitest";
import {
  newElement,
  newImageElement,
  newEmbeddableElement,
} from "@excalidraw/element";

import type {
  ExcalidrawImperativeAPI,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import {
  freezeChatCanvas,
  waitForChatCapture,
} from "../data/canvasChatCapture";

it("freezes coordinates, files and theme before awaiting live application capture; excludes unrelated cached files", async () => {
  const fileId = "used-image" as FileId;
  const picture = newImageElement({
    type: "image",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    fileId,
  });
  const app = newEmbeddableElement({
    type: "embeddable",
    x: 20,
    y: 0,
    width: 10,
    height: 10,
    customData: { htmlApp: {}, embeddable: { snapshot: '<svg old="true"/>' } },
  });
  const files = {
    [fileId]: {
      id: fileId,
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AAAA",
      created: 1,
    },
    unrelated: {
      id: "unrelated",
      mimeType: "image/png",
      dataURL: "SECRET_OTHER_NOTE",
      created: 1,
    },
  } as unknown as BinaryFiles;
  const state = {
    theme: "light",
    viewBackgroundColor: "#ffffff",
    frameRendering: { enabled: true, name: true, outline: true, clip: true },
  };
  const api = {
    getSceneElements: () => [picture, app],
    getFiles: () => files,
    getAppState: () => state,
  } as unknown as ExcalidrawImperativeAPI;
  let resolve!: (svg: string) => void;
  const pending = freezeChatCanvas(
    api,
    () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  );
  Object.assign(picture, { x: 500 });
  state.theme = "dark";
  files[fileId].dataURL = "data:image/png;base64,BBBB" as any;
  resolve(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
  );
  const frozen = await pending;
  expect(frozen.elements[0].x).toBe(0);
  expect(frozen.appState.theme).toBe("light");
  expect(frozen.files[fileId].dataURL).toBe("data:image/png;base64,AAAA");
  expect(JSON.stringify(frozen)).not.toContain("SECRET_OTHER_NOTE");
  expect(frozen.elements.find((e) => e.id === app.id)?.type).toBe("image");
  expect(frozen.errors).toEqual({});
});
it("keeps unavailable embeddings explicit without preventing unrelated scene capture", async () => {
  const shape = newElement({
    type: "rectangle",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  });
  const app = newEmbeddableElement({
    type: "embeddable",
    x: 100,
    y: 100,
    width: 20,
    height: 20,
    customData: { htmlApp: {} },
  });
  const api = {
    getSceneElements: () => [shape, app],
    getFiles: () => ({}),
    getAppState: () => ({
      theme: "light",
      viewBackgroundColor: "#fff",
      frameRendering: {},
    }),
  } as unknown as ExcalidrawImperativeAPI;
  const frozen = await freezeChatCanvas(api, async () => {
    throw new Error("应用尚未启动");
  });
  expect(frozen.errors[app.id]).toBe("应用尚未启动");
  expect(frozen.elements[0]).toEqual(shape);
  expect(frozen.elements[1].customData?.embeddable?.snapshotRequired).toBe(
    false,
  );
});
it("does not fall back to a stale application preview when capture returns oversized or invalid data", async () => {
  const app = newEmbeddableElement({
    type: "embeddable",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    customData: {
      htmlApp: {},
      embeddable: { snapshot: '<svg stale="true"/>' },
    },
  });
  const api = {
    getSceneElements: () => [app],
    getFiles: () => ({}),
    getAppState: () => ({
      theme: "light",
      viewBackgroundColor: "#fff",
      frameRendering: {},
    }),
  } as unknown as ExcalidrawImperativeAPI;
  const frozen = await freezeChatCanvas(
    api,
    async () => "<html>invalid</html>",
  );
  expect(frozen.errors[app.id]).toMatch(/格式无效/);
  expect(JSON.stringify(frozen.elements)).not.toContain("stale");
});

it("bounds browser decoder waits and ignores late completion after user stop", async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController();
    let finish!: (value: string) => void;
    const pending = waitForChatCapture(
      document,
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
      abort.signal,
    );
    abort.abort(new Error("user stopped"));
    await expect(pending).rejects.toThrow("user stopped");
    finish("late pixels");
    const timeout = waitForChatCapture(
      document,
      new Promise<string>(() => {}),
      new AbortController().signal,
    );
    const rejected = expect(timeout).rejects.toThrow("18 秒");
    await vi.advanceTimersByTimeAsync(18000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

import { getCommonBounds } from "@excalidraw/element";
import { exportToCanvas } from "@excalidraw/excalidraw/scene/export";
import { prepareEmbeddableSnapshots } from "@excalidraw/excalidraw/scene/embeddableSnapshots";

import type {
  ExcalidrawImperativeAPI,
  AppState,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import { canvasRegion, CHAT_IMAGE_BYTES, CHAT_IMAGE_EDGE } from "./chatImages";

import type { CanvasRegion } from "./chatImages";

export type FrozenChatCanvas = {
  capturedAt: number;
  elements: NonDeletedExcalidrawElement[];
  files: BinaryFiles;
  appState: Pick<AppState, "viewBackgroundColor" | "theme" | "frameRendering">;
  errors: Record<string, string>;
};
/** No provider or mutable scene is consulted after this promise settles. */
export async function freezeChatCanvas(
  api: ExcalidrawImperativeAPI,
  capture: (id: string) => Promise<string>,
): Promise<FrozenChatCanvas> {
  const elements = structuredClone(
    api.getSceneElements(),
  ) as NonDeletedExcalidrawElement[];
  const state = api.getAppState();
  const files: BinaryFiles = {};
  const liveFiles = api.getFiles();
  for (const element of elements) {
    if (
      element.type === "image" &&
      element.fileId &&
      liveFiles[element.fileId]
    ) {
      files[element.fileId] = structuredClone(liveFiles[element.fileId]);
    }
  }
  const snapshot: FrozenChatCanvas = {
    capturedAt: Date.now(),
    elements,
    files,
    appState: structuredClone({
      viewBackgroundColor: state.viewBackgroundColor,
      theme: state.theme,
      frameRendering: state.frameRendering,
    }),
    errors: {},
  };
  await Promise.all(
    elements
      .filter((e) => e.type === "embeddable" || e.type === "iframe")
      .map(async (e) => {
        try {
          if (e.type !== "embeddable" || !e.customData?.htmlApp) {
            throw new Error("此网页嵌入暂不支持当前画面截图");
          }
          const svg = await capture(e.id);
          if (!svg.startsWith("<svg") || svg.length > 2 * 1024 * 1024) {
            throw new Error("应用截图格式无效或超过 2MB");
          }
          // Frozen source changes the cache baseline: later live captures cannot replace it.
          elements[elements.indexOf(e)] = {
            ...e,
            customData: {
              ...e.customData,
              embeddable: {
                ...e.customData?.embeddable,
                snapshot: svg,
                snapshotRequired: false,
              },
            },
          };
        } catch (error) {
          snapshot.errors[e.id] = (error as Error).message;
          elements[elements.indexOf(e)] = {
            ...e,
            customData: {
              ...e.customData,
              embeddable: { snapshotRequired: false },
            },
          };
        }
      }),
  );
  const prepared = prepareEmbeddableSnapshots(elements, snapshot.files);
  snapshot.elements = prepared.elements;
  snapshot.files = prepared.files;
  return snapshot;
}
/** Waiting can end even when a browser image/font decoder itself is not cancellable. */
export function waitForChatCapture<T>(
  doc: Document,
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const win = doc.defaultView;
  if (!win) {
    return Promise.reject(new Error("截图页面已关闭"));
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      win.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason || new Error("截图已停止"));
    };
    const timer = win.setTimeout(() => {
      cleanup();
      reject(new Error("浏览器截图等待超过 18 秒，已停止等待"));
    }, 18000);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
export async function captureFrozenCanvas(
  doc: Document,
  snapshot: FrozenChatCanvas,
  input: CanvasRegion,
) {
  const region = canvasRegion(input);
  for (const e of snapshot.elements) {
    if (!snapshot.errors[e.id]) {
      continue;
    }
    const [x1, y1, x2, y2] = getCommonBounds([e]);
    if (x1 < region.x2 && x2 > region.x1 && y1 < region.y2 && y2 > region.y1) {
      throw new Error(`元素 ${e.id} 无法截图：${snapshot.errors[e.id]}`);
    }
  }
  const width = region.x2 - region.x1;
  const height = region.y2 - region.y1;
  const scale = Math.min(1, CHAT_IMAGE_EDGE / Math.max(width, height));
  const canvas = await exportToCanvas(
    snapshot.elements,
    {
      ...snapshot.appState,
      exportWithDarkMode: snapshot.appState.theme === "dark",
    } as AppState,
    snapshot.files,
    {
      exportBackground: true,
      viewBackgroundColor: snapshot.appState.viewBackgroundColor,
      exportPadding: 0,
      exportBounds: { x: region.x1, y: region.y1, width, height },
    },
    () => {
      const node = doc.createElement("canvas");
      node.width = Math.max(1, Math.round(width * scale));
      node.height = Math.max(1, Math.round(height * scale));
      return { canvas: node, scale };
    },
  );
  const data = canvas.toDataURL("image/png");
  if (Math.ceil((data.split(",")[1].length * 3) / 4) > CHAT_IMAGE_BYTES) {
    throw new Error("截图超过 2MB，请缩小截图区域");
  }
  return data.split(",")[1];
}

export async function normalizeChatImage(doc: Document, file: File) {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  ) {
    throw new Error("请选择不超过 10MB 的 PNG、JPEG 或 WebP 图片");
  }
  const win = doc.defaultView!;
  const url = win.URL.createObjectURL(file);
  const image = doc.createElement("img");
  try {
    image.src = url;
    await image.decode();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 64000000
    ) {
      throw new Error("图片尺寸过大或无法解码");
    }
    const scale = Math.min(
      1,
      CHAT_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = doc.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas
      .getContext("2d")!
      .drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/png").split(",")[1];
    if (Math.ceil((data.length * 3) / 4) > CHAT_IMAGE_BYTES) {
      throw new Error("规范化后的图片超过 2MB，请压缩后上传");
    }
    return data;
  } finally {
    win.URL.revokeObjectURL(url);
  }
}

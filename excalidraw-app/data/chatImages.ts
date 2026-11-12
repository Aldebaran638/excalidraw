export type CanvasRegion = { x1: number; y1: number; x2: number; y2: number };
export type ChatImageRef = {
  id: string;
  name: string;
  mimeType: "image/png";
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  source: "upload" | "canvas";
  capturedAt?: number;
  region?: CanvasRegion;
};
export const CHAT_IMAGE_LIMIT = 5;
export const CHAT_IMAGE_BYTES = 2 * 1024 * 1024;
export const CHAT_IMAGES_BYTES = 8 * 1024 * 1024;
export const CHAT_IMAGE_EDGE = 2048;
export function canvasRegion(value: unknown): CanvasRegion {
  const v = value as CanvasRegion;
  if (
    !v ||
    Object.keys(v).some((k) => !["x1", "y1", "x2", "y2"].includes(k)) ||
    ![v.x1, v.y1, v.x2, v.y2].every(
      (n) =>
        typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1000000,
    ) ||
    v.x2 <= v.x1 ||
    v.y2 <= v.y1
  ) {
    throw new Error(
      "截图坐标无效：需要有限的画布坐标，且右下角必须位于左上角右下方",
    );
  }
  return { x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2 };
}
export const chatImageURL = (noteId: string, sessionId: string, id: string) =>
  `/api/notes/${encodeURIComponent(noteId)}/chats/${encodeURIComponent(
    sessionId,
  )}/images/${encodeURIComponent(id)}`;

/** Binary image payloads have a separate size/token budget, never text-read characters. */
export function textContextSize(messages: unknown): number {
  return JSON.stringify(messages, (key, value) =>
    key === "images" ? undefined : value,
  ).length;
}

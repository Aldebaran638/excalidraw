import { randomUUID } from "node:crypto";

import { canvasRegion } from "../../data/chatImages";

import type { CanvasRegion, ChatImageRef } from "../../data/chatImages";

/** One active turn owns these requests; late, duplicate and foreign results fail closed. */
export class AgentScreenshots {
  private pending = new Map<
    string,
    {
      region: CanvasRegion;
      resolve: (v: ChatImageRef) => void;
      reject: (e: Error) => void;
      claimed: boolean;
    }
  >();
  async request(
    region: unknown,
    signal: AbortSignal,
    emit: (id: string, region: CanvasRegion) => void,
  ) {
    const bounds = canvasRegion(region);
    signal.throwIfAborted();
    const id = randomUUID();
    return new Promise<ChatImageRef>((resolve, reject) => {
      const finish = (error?: Error, image?: ChatImageRef) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(id);
        if (error) {
          reject(error);
        } else {
          resolve(image!);
        }
      };
      const abort = () =>
        finish(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("截图已停止"),
        );
      const timer = setTimeout(
        () => finish(new Error("画布截图等待超过 20 秒，浏览器可能已断开")),
        20000,
      );
      this.pending.set(id, {
        region: bounds,
        claimed: false,
        resolve: (image) => finish(undefined, image),
        reject: (error) => finish(error),
      });
      signal.addEventListener("abort", abort, { once: true });
      emit(id, bounds);
    });
  }
  claim(id: string) {
    const pending = this.pending.get(id);
    if (!pending || pending.claimed) {
      throw new Error("截图请求已过期、重复或不属于当前轮次");
    }
    pending.claimed = true;
    return pending.region;
  }
  finish(id: string, value: ChatImageRef | Error) {
    const pending = this.pending.get(id);
    if (!pending) {
      throw new Error("截图请求已过期");
    }
    if (value instanceof Error) {
      pending.reject(value);
    } else {
      pending.resolve(value);
    }
  }
}

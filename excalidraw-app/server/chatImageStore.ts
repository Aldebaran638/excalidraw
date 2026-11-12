import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";

import { validId } from "../data/noteIdentity";
import {
  CHAT_IMAGE_BYTES,
  CHAT_IMAGE_EDGE,
  canvasRegion,
} from "../data/chatImages";

import { ChatError } from "./chatStore";

import type { ChatImageRef } from "../data/chatImages";

/** Browser normalizes all input formats to a bounded, non-interlaced PNG. */
export function inspectChatPNG(data: Buffer) {
  if (
    data.length > CHAT_IMAGE_BYTES ||
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new ChatError(400, "图片必须是规范化 PNG，且不超过 2MB");
  }
  let width = 0;
  let height = 0;
  let channels = 0;
  let ended = false;
  const compressed: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= data.length) {
    const size = data.readUInt32BE(offset);
    if (size > data.length - offset - 12) {
      throw new ChatError(400, "PNG 数据不完整");
    }
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + size);
    // CRC guards both corrupted uploads and ambiguous decoder behavior.
    let crc = 0xffffffff;
    for (const b of data.subarray(offset + 4, offset + 8 + size)) {
      crc ^= b;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    if ((crc ^ 0xffffffff) >>> 0 !== data.readUInt32BE(offset + 8 + size)) {
      throw new ChatError(400, "PNG 校验失败");
    }
    if (offset === 8 && type !== "IHDR") {
      throw new ChatError(400, "缺少 PNG 图像头");
    }
    if (type === "IHDR") {
      if (
        width ||
        size !== 13 ||
        body[8] !== 8 ||
        ![2, 6].includes(body[9]) ||
        body[10] ||
        body[11] ||
        body[12]
      ) {
        throw new ChatError(400, "不支持的 PNG 编码，请重新上传");
      }
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = body[9] === 6 ? 4 : 3;
      if (
        !width ||
        !height ||
        width > CHAT_IMAGE_EDGE ||
        height > CHAT_IMAGE_EDGE
      ) {
        throw new ChatError(400, "图片尺寸超过 2048 像素");
      }
    }
    if (type === "IDAT") {
      compressed.push(body);
    }
    offset += size + 12;
    if (type === "IEND") {
      ended = size === 0 && offset === data.length;
      break;
    }
  }
  if (!width || !ended || !compressed.length) {
    throw new ChatError(400, "PNG 数据不完整");
  }
  try {
    const row = width * channels + 1;
    const raw = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: row * height,
    });
    if (raw.length !== row * height) {
      throw new Error();
    }
    for (let y = 0; y < height; y++) {
      if (raw[y * row] > 4) {
        throw new Error();
      }
    }
  } catch {
    throw new ChatError(400, "PNG 像素数据损坏");
  }
  return { width, height };
}

export class ChatImageStore {
  constructor(private directory: string) {}
  private folder(noteId: string, sessionId: string, kind = "images") {
    if (!validId(noteId) || !validId(sessionId)) {
      throw new ChatError(400, "图片所属会话无效");
    }
    return path.join(this.directory, ".chats", noteId, kind, sessionId);
  }
  private file(noteId: string, sessionId: string, id: string) {
    if (!validId(id)) {
      throw new ChatError(400, "无效图片身份");
    }
    return path.join(this.folder(noteId, sessionId), id);
  }
  async save(
    noteId: string,
    sessionId: string,
    data: Buffer,
    info: Pick<ChatImageRef, "name" | "source" | "capturedAt" | "region">,
  ) {
    const dimensions = inspectChatPNG(data);
    if (!["upload", "canvas"].includes(info.source)) {
      throw new ChatError(400, "图片来源无效");
    }
    if (
      info.source === "canvas" &&
      (!Number.isFinite(info.capturedAt) || !info.region)
    ) {
      throw new ChatError(400, "截图缺少快照信息");
    }
    const ref: ChatImageRef = {
      id: randomUUID(),
      name: String(info.name || "图片").slice(0, 120),
      mimeType: "image/png",
      ...dimensions,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      source: info.source,
      ...(info.source === "canvas"
        ? { capturedAt: info.capturedAt, region: canvasRegion(info.region) }
        : {}),
    };
    const folder = this.file(noteId, sessionId, ref.id);
    const temporary = `${folder}.pending`;
    await fs.mkdir(temporary, { recursive: true });
    try {
      await fs.writeFile(path.join(temporary, "image.png"), data, {
        flag: "wx",
      });
      await fs.writeFile(
        path.join(temporary, "metadata.json"),
        JSON.stringify(ref),
        { flag: "wx" },
      );
      await fs.rename(temporary, folder);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true });
      throw error;
    }
    return ref;
  }
  async read(noteId: string, sessionId: string, id: string) {
    const folder = this.file(noteId, sessionId, id);
    try {
      const ref = JSON.parse(
        await fs.readFile(path.join(folder, "metadata.json"), "utf8"),
      ) as ChatImageRef;
      const data = await fs.readFile(path.join(folder, "image.png"));
      if (
        ref.id !== id ||
        createHash("sha256").update(data).digest("hex") !== ref.sha256
      ) {
        throw new ChatError(422, "图片校验失败");
      }
      return { ref, data };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ChatError(404, "图片不存在，原消息已保留");
      }
      throw error;
    }
  }
  async writeSnapshot(
    noteId: string,
    sessionId: string,
    id: string,
    value: unknown,
  ) {
    if (
      !validId(id) ||
      !value ||
      !Array.isArray((value as any).elements) ||
      !Number.isFinite((value as any).capturedAt)
    ) {
      throw new ChatError(400, "画布快照格式无效");
    }
    const folder = this.folder(noteId, sessionId, "canvas-snapshots");
    await fs.mkdir(folder, { recursive: true });
    const temporary = path.join(folder, `${id}.${randomUUID()}.pending`);
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { flag: "wx" });
      // link publishes once, with no overwrite race between tabs/repeated POSTs.
      await fs.link(temporary, path.join(folder, `${id}.json`));
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async readSnapshot(
    noteId: string,
    sessionId: string,
    id: string,
  ): Promise<any> {
    if (!validId(id)) {
      throw new ChatError(400, "无效画布快照身份");
    }
    try {
      return JSON.parse(
        await fs.readFile(
          path.join(
            this.folder(noteId, sessionId, "canvas-snapshots"),
            `${id}.json`,
          ),
          "utf8",
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ChatError(404, "发送时的画布快照缺失，未读取当前画布替代");
      }
      throw error;
    }
  }
}

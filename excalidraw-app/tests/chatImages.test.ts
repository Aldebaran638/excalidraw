// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createServer } from "node:http";

import { afterEach, expect, it, vi } from "vitest";

import { ChatImageStore, inspectChatPNG } from "../server/chatImageStore";
import { ChatStore } from "../server/chatStore";
import { createChatService } from "../server/agent/chat";
import { AgentScreenshots } from "../server/agent/agentScreenshots";
import { redactImages } from "../server/agent/agentLog";
import { canvasRegion, textContextSize } from "../data/chatImages";
import { CHAT_HEADERS } from "../data/clientProtocol";
import { readSSE } from "../data/sse";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});
function png(width = 2, height = 2, noise = false) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const b of body) {
      crc ^= b;
      for (let i = 0; i < 8; i++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let seed = 17;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (noise) {
        for (let channel = 0; channel < 3; channel++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          raw[y * (width * 4 + 1) + x * 4 + 1 + channel] = seed >>> 24;
        }
      } else {
        raw[y * (width * 4 + 1) + x * 4 + 2] = 255;
      }
      raw[y * (width * 4 + 1) + x * 4 + 4] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const fixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chat-images-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const noteId = randomUUID();
  await fs.writeFile(
    path.join(directory, "note.excalidraw"),
    JSON.stringify({
      type: "excalidraw",
      elements: [],
      repositoryMetadata: { version: 1, noteId },
    }),
  );
  const chats = new ChatStore(directory);
  const session = await chats.create(noteId);
  const images = new ChatImageStore(directory);
  return { directory, noteId, session, chats, images };
};
async function serve(handle: any) {
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
const response = (delta: object, finish: string) =>
  new Response(
    `data: ${JSON.stringify({
      choices: [{ delta, finish_reason: finish }],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );

it.each([
  { x1: 0, y1: 0, x2: 0, y2: 10 },
  { x1: 2, y1: 1, x2: 1, y2: 3 },
  { x1: NaN, y1: 0, x2: 1, y2: 1 },
  { x1: 0, y1: 0, x2: Infinity, y2: 1 },
  { x1: 0, y1: 0, x2: 1, y2: 1, path: "/etc/passwd" },
])("rejects invalid rectangles %j", (value) => {
  expect(() => canvasRegion(value)).toThrow();
});
it("preserves negative scene coordinates", () => {
  expect(canvasRegion({ x1: -200, y1: -100, x2: -20, y2: 0 })).toEqual({
    x1: -200,
    y1: -100,
    x2: -20,
    y2: 0,
  });
});
it("validates real PNG bytes and rejects corrupt, incomplete or oversize images", () => {
  expect(inspectChatPNG(png())).toEqual({ width: 2, height: 2 });
  const invalid = Buffer.from(png());
  invalid[40] ^= 1;
  for (const data of [
    invalid,
    png().subarray(0, 30),
    Buffer.from("<svg/>"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
    png(2049, 1),
  ]) {
    expect(() => inspectChatPNG(data)).toThrow();
  }
});
it("publishes images atomically, isolates sessions, and detects damaged bytes", async () => {
  const f = await fixture();
  const ref = await f.images.save(f.noteId, f.session.id, png(), {
    name: "测试图片",
    source: "upload",
  });
  expect(ref.sha256).toBe(createHash("sha256").update(png()).digest("hex"));
  expect((await f.images.read(f.noteId, f.session.id, ref.id)).data).toEqual(
    png(),
  );
  await expect(
    f.images.read(f.noteId, randomUUID(), ref.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    f.images.read(f.noteId, f.session.id, "../x"),
  ).rejects.toMatchObject({ status: 400 });
  const file = path.join(
    f.directory,
    ".chats",
    f.noteId,
    "images",
    f.session.id,
    ref.id,
    "image.png",
  );
  await fs.writeFile(file, "broken");
  await expect(
    f.images.read(f.noteId, f.session.id, ref.id),
  ).rejects.toMatchObject({ status: 422 });
});
it("frozen snapshots are immutable and a missing original never becomes a current snapshot", async () => {
  const f = await fixture();
  const id = randomUUID();
  const value = { capturedAt: 1, elements: [{ id: "old" }], files: {} };
  await f.images.writeSnapshot(f.noteId, f.session.id, id, value);
  await expect(
    f.images.writeSnapshot(f.noteId, f.session.id, id, {
      ...value,
      elements: [],
    }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(
    (await f.images.readSnapshot(f.noteId, f.session.id, id)).elements,
  ).toEqual([{ id: "old" }]);
  await expect(
    f.images.readSnapshot(f.noteId, f.session.id, randomUUID()),
  ).rejects.toMatchObject({ status: 404 });
});
it("rejects unsolicited, duplicate and late screenshot results", async () => {
  const bridge = new AgentScreenshots();
  const abort = new AbortController();
  let id = "";
  const pending = bridge.request(
    { x1: 0, y1: 0, x2: 10, y2: 10 },
    abort.signal,
    (requestId) => {
      id = requestId;
    },
  );
  expect(() => bridge.claim("foreign")).toThrow();
  expect(bridge.claim(id).x2).toBe(10);
  expect(() => bridge.claim(id)).toThrow();
  bridge.finish(id, new Error("capture failed"));
  await expect(pending).rejects.toThrow("capture failed");
  expect(() => bridge.claim(id)).toThrow();
});
it("cancels and times out screenshot waits", async () => {
  const bridge = new AgentScreenshots();
  const abort = new AbortController();
  const first = bridge.request(
    { x1: 0, y1: 0, x2: 1, y2: 1 },
    abort.signal,
    () => {},
  );
  abort.abort(new Error("user stopped"));
  await expect(first).rejects.toThrow("user stopped");
  vi.useFakeTimers();
  const wait = bridge.request(
    { x1: 0, y1: 0, x2: 1, y2: 1 },
    new AbortController().signal,
    () => {},
  );
  const assertion = expect(wait).rejects.toThrow("20 秒");
  await vi.advanceTimersByTimeAsync(20000);
  await assertion;
});
it("omits binary payloads from text budgets and communication evidence", () => {
  const data = "A".repeat(100000);
  const payload = {
    messages: [
      {
        images: [{ type: "image", data, mimeType: "image/png" }],
        content: "hello",
      },
      {
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${data}` },
          },
        ],
      },
    ],
  };
  expect(textContextSize([{ content: "hi", images: [{ data }] }])).toBeLessThan(
    100,
  );
  const log = JSON.stringify(redactImages(payload));
  expect(log).not.toContain(data);
  expect(log).toContain("omitted");
  expect(log).toContain("hello");
});
it.each([true, false])(
  "passes real image content through Pi (vision=%s), persists tool thumbnails and retains image-only user messages",
  async (vision) => {
    const f = await fixture();
    const uploadedPixels = png(128, 128, true);
    expect(uploadedPixels.toString("base64").length).toBeGreaterThan(32000);
    const image = await f.images.save(f.noteId, f.session.id, uploadedPixels, {
      name: "user.png",
      source: "upload",
    });
    const snapshotId = randomUUID();
    await f.images.writeSnapshot(f.noteId, f.session.id, snapshotId, {
      capturedAt: 123,
      elements: [],
      files: {},
      noteSnapshot: {
        capturedAt: 123,
        elements: [
          {
            id: "shape",
            type: "rectangle",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
          },
        ],
      },
    });
    const calls: any[] = [];
    const transport = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (calls.length === 1) {
        return response(
          {
            tool_calls: [
              {
                index: 0,
                id: "screenshot_1",
                type: "function",
                function: {
                  name: "capture_note_region",
                  arguments: JSON.stringify({
                    x1: -10,
                    y1: -10,
                    x2: 100,
                    y2: 100,
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      }
      return response(
        { content: vision ? "我看到了图片" : "当前模型暂不支持看图" },
        "stop",
      );
    }) as typeof fetch;
    const service = await createChatService(
      f.directory,
      { baseUrl: "http://mock/v1", model: "mock", vision },
      transport,
    );
    cleanups.push(() => service.close());
    const base = await serve(service.handle);
    const turnId = randomUUID();
    const api = `/api/notes/${f.noteId}/chats/${f.session.id}`;
    const r = await fetch(`${base + api}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CHAT_HEADERS },
      body: JSON.stringify({
        turnId,
        content: "",
        attachments: [image],
        revision: f.session.revision,
        canvasSnapshotId: snapshotId,
        snapshot: { capturedAt: 999, elements: [] },
      }),
    });
    expect(r.status).toBe(200);
    const events: any[] = [];
    for await (const frame of readSSE(r.body!)) {
      const event = JSON.parse(frame.data);
      events.push(event);
      if (event.type === "capture_request") {
        expect(event.capture.snapshotId).toBe(snapshotId);
        const feedback = await fetch(
          `${base + api}/turns/${turnId}/captures/${event.capture.requestId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: png().toString("base64") }),
          },
        );
        expect(feedback.status).toBe(200);
        const duplicate = await fetch(
          `${base + api}/turns/${turnId}/captures/${event.capture.requestId}`,
          {
            method: "POST",
            body: JSON.stringify({ data: png().toString("base64") }),
          },
        );
        expect(duplicate.status).toBe(409);
      }
    }
    const stored = await f.chats.read(f.noteId, f.session.id);
    expect(stored.messages).toHaveLength(2);
    expect(stored.messages[0].content).toBe("");
    expect(stored.messages[0].attachments?.[0].id).toBe(image.id);
    const activity = stored.messages[1].activities![0];
    expect(activity.status).toBe("complete");
    expect(activity.images?.[0].source).toBe("canvas");
    expect(activity.snapshotAt).toBe(123);
    expect(activity.imageDelivery).toBe(vision ? "sent" : "unsupported");
    expect(events.some((e) => e.type === "done" && e.saved)).toBe(true);
    expect(calls.length).toBe(2);
    expect(
      calls[0].messages.filter((message: any) => message.role === "user"),
    ).toHaveLength(1);
    const imageContent = (body: any) =>
      JSON.stringify(body).includes("data:image/png;base64,");
    expect(imageContent(calls[0])).toBe(vision);
    expect(imageContent(calls[1])).toBe(vision);
    if (vision) {
      expect(JSON.stringify(calls[1])).toContain(activity.images![0].name);
      const parts = calls[1].messages
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .filter((p: any) => p.type === "image_url");
      expect(parts.length).toBeGreaterThanOrEqual(2);
    }
    const storedImage = await fetch(
      `${base + api}/images/${activity.images![0].id}`,
    );
    expect(storedImage.headers.get("Content-Type")).toBe("image/png");
    const foreign = await f.chats.create(f.noteId);
    expect(
      (
        await fetch(
          `${base}/api/notes/${f.noteId}/chats/${foreign.id}/images/${image.id}`,
        )
      ).status,
    ).toBe(404);
    const evidence = await fs.readFile(
      path.join(
        f.directory,
        ".chats",
        f.noteId,
        "agent-logs",
        f.session.id,
        `${turnId}.jsonl`,
      ),
      "utf8",
    );
    expect(evidence).not.toContain(png().toString("base64"));
    expect(evidence).not.toContain(uploadedPixels.toString("base64"));
    expect(evidence).toContain(image.sha256);
  },
  30000,
);

it("does not publish an image when atomic persistence fails", async () => {
  const f = await fixture();
  const rename = vi
    .spyOn(fs, "rename")
    .mockRejectedValueOnce(
      Object.assign(new Error("disk full"), { code: "ENOSPC" }),
    );
  try {
    await expect(
      f.images.save(f.noteId, f.session.id, png(), {
        name: "未保存",
        source: "upload",
      }),
    ).rejects.toThrow("disk full");
  } finally {
    rename.mockRestore();
  }
  const folder = path.join(
    f.directory,
    ".chats",
    f.noteId,
    "images",
    f.session.id,
  );
  expect(await fs.readdir(folder)).toEqual([]);
});

it("rejects cross-origin image writes and foreign attachment references before contacting the model", async () => {
  const f = await fixture();
  const other = await f.chats.create(f.noteId);
  const foreign = await f.images.save(f.noteId, other.id, png(), {
    name: "other",
    source: "upload",
  });
  const transport = vi.fn() as typeof fetch;
  const service = await createChatService(
    f.directory,
    { baseUrl: "http://mock/v1", model: "mock" },
    transport,
  );
  cleanups.push(() => service.close());
  const base = await serve(service.handle);
  const api = `/api/notes/${f.noteId}/chats/${f.session.id}`;
  const denied = await fetch(`${base + api}/images`, {
    method: "POST",
    headers: { Origin: "https://other.example" },
    body: JSON.stringify({ data: png().toString("base64") }),
  });
  expect(denied.status).toBe(403);
  const response = await fetch(`${base + api}/turns`, {
    method: "POST",
    body: JSON.stringify({
      turnId: randomUUID(),
      content: "图片",
      attachments: [foreign],
      revision: f.session.revision,
      snapshot: { capturedAt: 1, elements: [] },
    }),
  });
  expect(response.status).toBe(404);
  expect(transport).not.toHaveBeenCalled();
  expect((await f.chats.read(f.noteId, f.session.id)).messages).toEqual([]);
});

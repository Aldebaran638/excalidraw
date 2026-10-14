import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createNoteService } from "../server/notes";
import { createAIHandler } from "../server/ai";
import { EXAMPLES } from "../../packages/interactive-widgets/examples";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) {
    await clean();
  }
});
const serve = async (handle: ReturnType<typeof createAIHandler>) => {
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
describe("shared repository and AI services", () => {
  it("serializes concurrent If-Match writes and rejects deleted file recreation", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "excalidraw-note-test-"),
    );
    cleanups.push(() => fs.rm(dir, { recursive: true }));
    const notes = await createNoteService(dir);
    cleanups.push(notes.close);
    const url = await serve(notes.handle);
    const body = JSON.stringify({
      type: "excalidraw",
      elements: [],
      appState: {},
    });
    const created = await fetch(`${url}/api/notes/a.excalidraw`, {
      method: "PUT",
      body,
      headers: { "If-None-Match": "*" },
    });
    const { revision } = (await created.json()) as { revision: string };
    const requests = [1, 2].map((n) =>
      fetch(`${url}/api/notes/a.excalidraw`, {
        method: "PUT",
        body: JSON.stringify({
          type: "excalidraw",
          elements: [],
          appState: { name: n },
        }),
        headers: { "If-Match": `"${revision}"` },
      }),
    );
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    await fs.unlink(path.join(dir, "a.excalidraw"));
    const deleted = await fetch(`${url}/api/notes/a.excalidraw`, {
      method: "PUT",
      body,
      headers: { "If-Match": `"${revision}"` },
    });
    expect(deleted.status).toBe(409);
    expect((await fs.readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });
  it("publishes a single source-tagged SSE event and observes external edits", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "excalidraw-events-test-"),
    );
    cleanups.push(() => fs.rm(dir, { recursive: true }));
    const notes = await createNoteService(dir);
    cleanups.push(notes.close);
    const url = await serve(notes.handle);
    const abort = new AbortController();
    cleanups.push(async () => abort.abort());
    const response = await fetch(`${url}/api/notes/events`, {
      signal: abort.signal,
    });
    const chunks: string[] = [];
    const read = (async () => {
      try {
        for await (const chunk of response.body as any) {
          chunks.push(Buffer.from(chunk).toString());
        }
      } catch {
        /* aborted */
      }
    })();
    const body = JSON.stringify({ type: "excalidraw", elements: [] });
    await fetch(`${url}/api/notes/a.excalidraw`, {
      method: "PUT",
      body,
      headers: { "X-Repository-Client-Id": "client-A" },
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(chunks.join("").match(/"kind":"updated"/g)).toHaveLength(1);
    expect(chunks.join("")).toContain('"sourceId":"client-A"');
    await fs.writeFile(path.join(dir, "a.excalidraw"), `${body}\n`);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(chunks.join("").match(/"kind":"updated"/g)).toHaveLength(2);
    await fs.unlink(path.join(dir, "a.excalidraw"));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(chunks.join("")).toContain('"kind":"deleted"');
    abort.abort();
    await read;
  });
  it("uses the configured model and repairs invalid JSON exactly once", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"bad":true}' } }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify(EXAMPLES.kubernetes) } },
            ],
          }),
        ),
      );
    const handler = createAIHandler(
      { baseUrl: "http://model/v1", model: "qwen3.8-27b" },
      upstream,
    );
    const url = await serve(handler);
    const response = await fetch(`${url}/api/ai/widgets/generate`, {
      method: "POST",
      body: JSON.stringify({ prompt: "K8s 点击解释" }),
    });
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    const options = JSON.parse(String(upstream.mock.calls[0][1]?.body));
    expect(options).toMatchObject({
      model: "qwen3.8-27b",
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(
      (upstream.mock.calls[0][1]?.headers as Record<string, string>)
        .Authorization,
    ).toBeUndefined();
  });
  it("does not accept a failed repair or silently return a template", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "not JSON" } }] }),
          ),
      );
    const url = await serve(
      createAIHandler(
        { baseUrl: "http://model/v1", model: "qwen3.8-27b" },
        upstream,
      ),
    );
    const response = await fetch(`${url}/api/ai/widgets/generate`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Example" }),
    });
    expect(response.status).toBe(422);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

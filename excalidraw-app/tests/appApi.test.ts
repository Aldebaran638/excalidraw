import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { expect, it } from "vitest";

import { createAppApi } from "../server/appApi";

it("creates independent source files, checks target versions and explicitly recovers the same missing identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "html-app-api-"));
  const noteId = randomUUID();
  const filename = path.join(directory, "test.excalidraw");
  const note: any = {
    repositoryMetadata: { version: 1, noteId },
    elements: [],
  };
  await fs.writeFile(filename, JSON.stringify(note));
  const handler = createAppApi(directory);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${
    (server.address() as { port: number }).port
  }/api/notes/${noteId}/apps`;
  const body = {
    source: '<h1 id="title">计数器</h1><button>+1</button>',
    title: "计数器",
    state: { forms: {}, custom: { count: 3 } },
  };
  const post = (suffix: string, value: unknown) =>
    fetch(base + suffix, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  try {
    const response = await post("", body);
    expect(response.status).toBe(201);
    const app = await response.json();
    const duplicate = await (await post("", body)).json();
    expect(duplicate.artifactId).not.toBe(app.artifactId);
    note.elements = [
      {
        id: "canvas-element",
        type: "embeddable",
        customData: {
          htmlApp: {
            formatVersion: 1,
            appId: app.artifactId,
            version: 1,
            sourceHash: app.sourceHash,
            sourceSnapshot: body.source,
            runtimeVersion: 2,
            title: body.title,
            state: body.state,
          },
        },
      },
    ];
    await fs.writeFile(filename, JSON.stringify(note));
    const target = {
      elementId: "canvas-element",
      appId: app.artifactId,
      version: 1,
      sourceHash: app.sourceHash,
    };
    const changed = await post("", {
      ...body,
      source: body.source.replace("计数器", "新版计数器"),
      target,
    });
    expect(changed.status).toBe(201);
    const next = await changed.json();
    expect(next.artifactId).toBe(app.artifactId);
    expect(next.version).toBe(2);
    expect(
      (await (await fetch(`${base}/${app.artifactId}?version=1`)).json())
        .source,
    ).toBe(body.source);
    note.elements[0].customData.htmlApp = {
      ...note.elements[0].customData.htmlApp,
      version: 2,
      sourceHash: next.sourceHash,
      sourceSnapshot: next.source,
    };
    await fs.writeFile(filename, JSON.stringify(note));
    expect((await post("", { ...body, target })).status).toBe(409);
    const sourceFile = path.join(
      directory,
      ".apps",
      noteId,
      app.artifactId,
      "versions",
      "2",
      "source.html",
    );
    await fs.unlink(sourceFile);
    expect((await fetch(`${base}/${app.artifactId}?version=2`)).status).toBe(
      404,
    );
    const restored = await post(`/${app.artifactId}/restore`, {
      ...body,
      source: next.source,
    });
    expect(restored.status).toBe(201);
    expect((await restored.json()).artifactId).toBe(app.artifactId);
    expect(await fs.readFile(sourceFile, "utf8")).toBe(next.source);
    expect((await post(`/${app.artifactId}`, body)).status).toBe(405);
    expect((await post(`/${app.artifactId}/restore`, body)).status).toBe(409);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

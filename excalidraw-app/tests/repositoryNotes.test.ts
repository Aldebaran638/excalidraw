import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "@excalidraw/excalidraw/types";

import { saveRepositoryNote } from "../data/repositoryNotes";

describe("repository note transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the client id and optimistic concurrency headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ name: "note.excalidraw", revision: "rev-2" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await saveRepositoryNote(
      "note",
      [],
      {} as AppState,
      {},
      {
        clientId: "client-A",
        expectedRevision: "rev-1",
      },
    );

    const [, request] = fetchMock.mock.calls[0];
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Repository-Client-Id": "client-A",
      "If-Match": '"rev-1"',
    });
  });

  it("normalizes precondition failures to a conflict error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      saveRepositoryNote(
        "note",
        [],
        {} as AppState,
        {},
        {
          clientId: "client-A",
          expectedRevision: "stale",
        },
      ),
    ).rejects.toMatchObject({
      name: "RepositoryNoteConflictError",
    });
  });
});

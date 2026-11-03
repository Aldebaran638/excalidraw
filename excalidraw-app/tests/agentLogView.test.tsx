import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AgentCommunicationLog } from "../components/AgentCommunicationLog";

import type { ReactNode } from "react";

// The native Dialog's portal appears after its parent's first effect. Keep
// that lifecycle in this test; a synchronous div mock misses the real bug.
vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => {
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
      setMounted(true);
    }, []);
    return mounted ? <div>{children}</div> : null;
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("loads on the first delayed Dialog mount and ignores late data from a previously selected turn", async () => {
  const ownerWindow = document.defaultView!;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  let release: (value: Response) => void = () => {};
  const late = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const entry = (turnId: string) => ({
    version: 1,
    noteId: "note",
    sessionId: "session",
    turnId,
    sequence: 1,
    at: Date.now(),
    kind: "turn_end",
    data: { status: "complete" },
  });
  const reply = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  const fetcher = vi
    .spyOn(ownerWindow, "fetch")
    .mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("agent-logs")) {
        return reply({
          turns: ["turn-a", "turn-b"].map((turnId) => ({
            turnId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            running: false,
            bytes: 200,
          })),
        });
      }
      if (url.includes("turn-b")) {
        return late;
      }
      return reply({
        entries: url.includes("after=0") ? [entry("turn-a")] : [],
        next: 1,
        hasMore: false,
        incomplete: false,
      });
    });
  const view = render(
    <AgentCommunicationLog
      noteId="note"
      sessionId="session"
      messages={[]}
      onClose={() => {}}
    />,
  );
  await view.findByText("结束本轮");
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining("agent-logs/turn-a?after=0"),
    expect.anything(),
  );
  fireEvent.click(view.getByText("结束本轮"));
  expect(await view.findByText("轮次 turn-a")).toBeInTheDocument();
  fireEvent.change(view.getByLabelText("通信轮次"), {
    target: { value: "turn-b" },
  });
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("turn-b"),
      expect.anything(),
    ),
  );
  fireEvent.change(view.getByLabelText("通信轮次"), {
    target: { value: "turn-a" },
  });
  await view.findByText("结束本轮");
  release(
    new Response(
      JSON.stringify({
        entries: [entry("turn-b")],
        next: 1,
        hasMore: false,
        incomplete: false,
      }),
    ),
  );
  await waitFor(() => expect(view.getAllByText("结束本轮")).toHaveLength(1));
  fireEvent.click(view.getByText("结束本轮"));
  expect(view.queryByText("轮次 turn-b")).not.toBeInTheDocument();
  expect(await view.findByText("轮次 turn-a")).toBeInTheDocument();
});

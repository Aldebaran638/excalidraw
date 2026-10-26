import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { HtmlAppView } from "../components/HtmlAppView";

afterEach(cleanup);

it("keeps one parser within a version and rejects callbacks from replaced frames", () => {
  const onPreview = vi.fn();
  const onState = vi.fn();
  const onError = vi.fn();
  const onRuntime = vi.fn();
  const props = {
    source: "<main>one",
    complete: false,
    initialState: { forms: {}, custom: {} },
    onPreview,
    onState,
    onError,
    onRuntime,
  };
  const mounted = render(<HtmlAppView {...props} identity="app/v1" />);
  const owner = mounted.container.ownerDocument.defaultView!;
  owner.structuredClone = structuredClone;
  const original = mounted.container.querySelector("iframe")!;
  const oldWindow = original.contentWindow;
  const oldToken = original.srcdoc.match(
    /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i,
  )![0];
  const send = (
    source: Window | null,
    token: string,
    type: string,
    data?: unknown,
  ) =>
    act(() => {
      owner.dispatchEvent(
        new owner.MessageEvent("message", {
          source,
          data: { token, type, data },
        }),
      );
    });
  mounted.rerender(
    <HtmlAppView {...props} identity="app/v1" source="<main>one more</main>" />,
  );
  expect(mounted.container.querySelector("iframe")).toBe(original);
  mounted.rerender(
    <HtmlAppView {...props} identity="app/v2" source="<main>two</main>" />,
  );
  const current = mounted.container.querySelector("iframe")!;
  expect(current).not.toBe(original);
  const token = current.srcdoc.match(
    /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i,
  )![0];
  const report = { ids: ["current"], nodes: 1, relations: 0, errors: [] };
  send(oldWindow, oldToken, "preview", report);
  send(oldWindow, oldToken, "error", "stale runtime error");
  send(oldWindow, oldToken, "state", { forms: {}, custom: { stale: true } });
  expect(onPreview).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(onState).not.toHaveBeenCalled();
  send(current.contentWindow, token, "preview", report);
  expect(onPreview).toHaveBeenCalledTimes(1);
  expect(onPreview).toHaveBeenCalledWith(report);
  const runtime = onRuntime.mock.calls.at(-1)![0];
  expect(runtime.preview()).toEqual(report);
  runtime.preview().ids.push("cannot mutate cached observation");
  expect(runtime.preview().ids).toEqual(["current"]);
  send(current.contentWindow, token, "preview_dirty");
  expect(runtime.preview()).toBeNull();
});

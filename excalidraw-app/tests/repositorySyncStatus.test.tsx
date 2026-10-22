import { fireEvent, render } from "@testing-library/react";
import { vi } from "vitest";

import { RepositorySyncStatus } from "../components/RepositorySyncStatus";

it("offers retry after failure, then truthfully shows confirmation rather than a stale failure", () => {
  const failure = {
    name: "original.excalidraw",
    kind: "error" as const,
    message: "HTTP 500",
  };
  const retry = vi.fn();
  const view = render(
    <RepositorySyncStatus
      status="error"
      loadFailure={failure}
      onRetry={retry}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "重试读取" }));
  expect(retry).toHaveBeenCalledTimes(1);
  view.rerender(
    <RepositorySyncStatus
      status="error"
      loadFailure={failure}
      onRetry={retry}
      retrying
    />,
  );
  expect(view.getByRole("button", { name: "读取中…" })).toBeDisabled();
  view.rerender(
    <RepositorySyncStatus
      status="conflict"
      loadFailure={failure}
      onRetry={retry}
    />,
  );
  expect(view.getByRole("status")).toHaveAccessibleName(
    "恢复待确认，自动保存已暂停",
  );
  expect(view.queryByRole("button")).toBeNull();
});

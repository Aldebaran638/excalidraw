import { Excalidraw } from "@excalidraw/excalidraw";

import {
  fireEvent,
  render,
  waitFor,
  withExcalidrawDimensions,
} from "../../packages/excalidraw/tests/test-utils";

import { AppSidebar } from "../components/AppSidebar";
import { RIGHT_SIDEBAR_WIDTH } from "../../packages/excalidraw/components/App.viewport";

describe("application sidebar shell", () => {
  it.each([false, true])(
    "retains the shell/header/tablist and docking policy across tabs (docked=%s)",
    async (docked) => {
      const { container } = await render(
        <Excalidraw
          initialData={{
            appState: {
              openSidebar: { name: "default", tab: "library" },
              defaultSidebarDockedPreference: docked,
            },
          }}
        >
          <AppSidebar chats={null} />
        </Excalidraw>,
      );
      await withExcalidrawDimensions(
        { width: 1920, height: 1080 },
        async () => {
          const shell = container.querySelector(".app-sidebar");
          const header = container.querySelector(".sidebar__header");
          const tabs = container.querySelector("[role=tablist]");
          expect(shell).not.toBeNull();
          expect(
            container
              .querySelector<HTMLElement>(".excalidraw")
              ?.style.getPropertyValue("--right-sidebar-width"),
          ).toBe(`${RIGHT_SIDEBAR_WIDTH}px`);
          for (const index of [2, 1, 3, 4, 0, 2, 1]) {
            const triggers = tabs!.querySelectorAll("button");
            fireEvent.mouseDown(triggers[index], { button: 0, ctrlKey: false });
            await waitFor(() =>
              expect(triggers[index]).toHaveAttribute("data-state", "active"),
            );
            expect(container.querySelector(".app-sidebar")).toBe(shell);
            expect(container.querySelector(".sidebar__header")).toBe(header);
            expect(container.querySelector("[role=tablist]")).toBe(tabs);
            expect(shell!.classList.contains("sidebar--docked")).toBe(docked);
            expect(shell).not.toHaveClass("note-chat-sidebar");
          }
        },
      );
    },
  );
});

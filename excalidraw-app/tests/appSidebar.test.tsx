import { Excalidraw } from "@excalidraw/excalidraw";
import { useRef } from "react";

import {
  fireEvent,
  render,
  waitFor,
  withExcalidrawDimensions,
} from "../../packages/excalidraw/tests/test-utils";

import { AppSidebar } from "../components/AppSidebar";
import { RIGHT_SIDEBAR_WIDTH } from "../../packages/excalidraw/components/App.viewport";
import { useSidebarWidth } from "../useSidebarWidth";
import { sidebarWidthLimit } from "../components/SidebarResizeHandle";

const ResizableSidebar = () => {
  const root = useRef<HTMLDivElement>(null);
  const { width, resize } = useSidebarWidth(root);
  return (
    <div ref={root}>
      <Excalidraw
        UIOptions={{ sidebarWidth: width }}
        initialData={{
          appState: {
            openSidebar: { name: "default", tab: "library" },
            defaultSidebarDockedPreference: false,
          },
        }}
      >
        <AppSidebar chats={null} width={width} onResize={resize} />
      </Excalidraw>
    </div>
  );
};

describe("application sidebar shell", () => {
  it("keeps the sidebar open on canvas click and shares/persists its adjustable width", async () => {
    localStorage.setItem("aldebaran.sidebar-width", "480");
    try {
      const { container, unmount } = await render(<ResizableSidebar />);
      const editor = container.querySelector<HTMLElement>(".excalidraw")!;
      const handle = container.querySelector<HTMLElement>("[role=separator]")!;
      expect(editor.style.getPropertyValue("--right-sidebar-width")).toBe(
        "480px",
      );
      fireEvent.pointerDown(container.querySelector("canvas")!, { button: 0 });
      expect(container.querySelector(".app-sidebar")).not.toBeNull();
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      await waitFor(() =>
        expect(editor.style.getPropertyValue("--right-sidebar-width")).toBe(
          "496px",
        ),
      );
      fireEvent.keyDown(handle, { key: "Home" });
      await waitFor(() =>
        expect(handle).toHaveAttribute("aria-valuenow", "328"),
      );
      fireEvent.doubleClick(handle);
      await waitFor(() =>
        expect(handle).toHaveAttribute("aria-valuenow", "360"),
      );
      await waitFor(() =>
        expect(localStorage.getItem("aldebaran.sidebar-width")).toBe("360"),
      );
      unmount();
    } finally {
      localStorage.removeItem("aldebaran.sidebar-width");
    }
  });

  it("bounds desktop width while preserving canvas space", () => {
    expect(sidebarWidthLimit(1440)).toBe(800);
    expect(sidebarWidthLimit(900)).toBe(620);
    expect(sidebarWidthLimit(390)).toBe(328);
  });
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

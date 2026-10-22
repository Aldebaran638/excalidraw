import React from "react";

import { CANVAS_SEARCH_TAB, DEFAULT_SIDEBAR } from "@excalidraw/common";

import { DefaultSidebar, Excalidraw } from "../index";
import {
  fireEvent,
  render,
  waitFor,
  withExcalidrawDimensions,
} from "../tests/test-utils";

import {
  assertExcalidrawWithSidebar,
  assertSidebarDockButton,
} from "./Sidebar/siderbar.test.helpers";

const { h } = window;

describe("DefaultSidebar", () => {
  it.each([undefined, false])(
    "preserves native search docking unless the host opts out (%s)",
    async (forceDockOnSearch) => {
      await render(
        <Excalidraw
          initialData={{
            appState: {
              openSidebar: {
                name: DEFAULT_SIDEBAR.name,
                tab: CANVAS_SEARCH_TAB,
              },
            },
          }}
        >
          <DefaultSidebar forceDockOnSearch={forceDockOnSearch} />
        </Excalidraw>,
      );
      await withExcalidrawDimensions(
        { width: 1920, height: 1080 },
        async () => {
          const { sidebar } = await assertSidebarDockButton(
            forceDockOnSearch === false,
          );
          expect(sidebar.classList.contains("sidebar--docked")).toBe(
            forceDockOnSearch !== false,
          );
          expect(h.state.defaultSidebarDockedPreference).toBe(false);
        },
      );
    },
  );
  it("when `docked={undefined}` & `onDock={undefined}`, should allow docking", async () => {
    await assertExcalidrawWithSidebar(
      <DefaultSidebar />,
      DEFAULT_SIDEBAR.name,
      async () => {
        expect(h.state.defaultSidebarDockedPreference).toBe(false);

        const { dockButton } = await assertSidebarDockButton(true);

        fireEvent.click(dockButton);
        await waitFor(() => {
          expect(h.state.defaultSidebarDockedPreference).toBe(true);
          expect(dockButton).toHaveClass("selected");
        });

        fireEvent.click(dockButton);
        await waitFor(() => {
          expect(h.state.defaultSidebarDockedPreference).toBe(false);
          expect(dockButton).not.toHaveClass("selected");
        });
      },
    );
  });

  it("when `docked={undefined}` & `onDock`, should allow docking", async () => {
    await assertExcalidrawWithSidebar(
      <DefaultSidebar onDock={() => {}} />,
      DEFAULT_SIDEBAR.name,
      async () => {
        expect(h.state.defaultSidebarDockedPreference).toBe(false);

        const { dockButton } = await assertSidebarDockButton(true);

        fireEvent.click(dockButton);
        await waitFor(() => {
          expect(h.state.defaultSidebarDockedPreference).toBe(true);
          expect(dockButton).toHaveClass("selected");
        });

        fireEvent.click(dockButton);
        await waitFor(() => {
          expect(h.state.defaultSidebarDockedPreference).toBe(false);
          expect(dockButton).not.toHaveClass("selected");
        });
      },
    );
  });

  it("when `docked={true}` & `onDock`, should allow docking", async () => {
    await assertExcalidrawWithSidebar(
      <DefaultSidebar onDock={() => {}} />,
      DEFAULT_SIDEBAR.name,
      async () => {
        expect(h.state.defaultSidebarDockedPreference).toBe(false);

        const { dockButton } = await assertSidebarDockButton(true);

        fireEvent.click(dockButton);
        await waitFor(() => {
          expect(h.state.defaultSidebarDockedPreference).toBe(true);
          expect(dockButton).toHaveClass("selected");
        });

        fireEvent.click(dockButton);
        await waitFor(() => {
          expect(h.state.defaultSidebarDockedPreference).toBe(false);
          expect(dockButton).not.toHaveClass("selected");
        });
      },
    );
  });

  it("when `onDock={false}`, should disable docking", async () => {
    await assertExcalidrawWithSidebar(
      <DefaultSidebar onDock={false} />,
      DEFAULT_SIDEBAR.name,
      async () => {
        await withExcalidrawDimensions(
          { width: 1920, height: 1080 },
          async () => {
            expect(h.state.defaultSidebarDockedPreference).toBe(false);

            await assertSidebarDockButton(false);
          },
        );
      },
    );
  });

  it("when `docked={true}` & `onDock={false}`, should force-dock sidebar", async () => {
    await assertExcalidrawWithSidebar(
      <DefaultSidebar docked onDock={false} />,
      DEFAULT_SIDEBAR.name,
      async () => {
        expect(h.state.defaultSidebarDockedPreference).toBe(false);

        const { sidebar } = await assertSidebarDockButton(false);
        expect(sidebar).toHaveClass("sidebar--docked");
      },
    );
  });

  it("when `docked={true}` & `onDock={undefined}`, should force-dock sidebar", async () => {
    await assertExcalidrawWithSidebar(
      <DefaultSidebar docked />,
      DEFAULT_SIDEBAR.name,
      async () => {
        expect(h.state.defaultSidebarDockedPreference).toBe(false);

        const { sidebar } = await assertSidebarDockButton(false);
        expect(sidebar).toHaveClass("sidebar--docked");
      },
    );
  });

  it("when `docked={false}` & `onDock={undefined}`, should force-undock sidebar", async () => {
    await assertExcalidrawWithSidebar(
      <DefaultSidebar docked={false} />,
      DEFAULT_SIDEBAR.name,
      async () => {
        expect(h.state.defaultSidebarDockedPreference).toBe(false);

        const { sidebar } = await assertSidebarDockButton(false);
        expect(sidebar).not.toHaveClass("sidebar--docked");
      },
    );
  });
});

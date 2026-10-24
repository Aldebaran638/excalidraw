import React, { useState } from "react";

import { Excalidraw, MainMenu } from "../../index";
import { render, queryAllByTestId, act, waitFor } from "../../tests/test-utils";
import { DefaultSidebar } from "../DefaultSidebar";
import { Sidebar } from "../Sidebar/Sidebar";

describe("Test internal component fallback rendering", () => {
  it.each([false, true])(
    "keeps one sidebar when host starts mounted=%s and is toggled",
    async (initial) => {
      let toggle!: (visible: boolean) => void;
      const Editor = () => {
        const [visible, setVisible] = useState(initial);
        toggle = setVisible;
        return (
          <Excalidraw
            initialData={{
              appState: { openSidebar: { name: "default", tab: "note-chat" } },
            }}
          >
            {visible && (
              <DefaultSidebar className="test-host-sidebar">
                <Sidebar.Tab tab="note-chat">
                  <p>Host chat</p>
                </Sidebar.Tab>
              </DefaultSidebar>
            )}
          </Excalidraw>
        );
      };
      const { container } = await render(<Editor />);
      const setHostVisible = toggle;
      for (const visible of [true, false, true]) {
        await act(async () => setHostVisible(visible));
        await waitFor(() => {
          expect(container.querySelectorAll(".sidebar")).toHaveLength(1);
          expect(Boolean(container.querySelector(".test-host-sidebar"))).toBe(
            visible,
          );
          if (visible) {
            expect(container.querySelector(".sidebar")?.textContent).toContain(
              "Host chat",
            );
          }
        });
      }
    },
  );
  it("should render only one menu per excalidraw instance (custom menu first scenario)", async () => {
    const { container } = await render(
      <div>
        <Excalidraw>
          <MainMenu>test</MainMenu>
        </Excalidraw>
        <Excalidraw />
      </div>,
    );

    expect(queryAllByTestId(container, "main-menu-trigger")?.length).toBe(2);

    const excalContainers = container.querySelectorAll<HTMLDivElement>(
      ".excalidraw-container",
    );

    expect(
      queryAllByTestId(excalContainers[0], "main-menu-trigger")?.length,
    ).toBe(1);
    expect(
      queryAllByTestId(excalContainers[1], "main-menu-trigger")?.length,
    ).toBe(1);
  });

  it("should render only one menu per excalidraw instance (default menu first scenario)", async () => {
    const { container } = await render(
      <div>
        <Excalidraw />
        <Excalidraw>
          <MainMenu>test</MainMenu>
        </Excalidraw>
      </div>,
    );

    expect(queryAllByTestId(container, "main-menu-trigger")?.length).toBe(2);

    const excalContainers = container.querySelectorAll<HTMLDivElement>(
      ".excalidraw-container",
    );

    expect(
      queryAllByTestId(excalContainers[0], "main-menu-trigger")?.length,
    ).toBe(1);
    expect(
      queryAllByTestId(excalContainers[1], "main-menu-trigger")?.length,
    ).toBe(1);
  });

  it("should render only one menu per excalidraw instance (two custom menus scenario)", async () => {
    const { container } = await render(
      <div>
        <Excalidraw>
          <MainMenu>test</MainMenu>
        </Excalidraw>
        <Excalidraw>
          <MainMenu>test</MainMenu>
        </Excalidraw>
      </div>,
    );

    expect(queryAllByTestId(container, "main-menu-trigger")?.length).toBe(2);

    const excalContainers = container.querySelectorAll<HTMLDivElement>(
      ".excalidraw-container",
    );

    expect(
      queryAllByTestId(excalContainers[0], "main-menu-trigger")?.length,
    ).toBe(1);
    expect(
      queryAllByTestId(excalContainers[1], "main-menu-trigger")?.length,
    ).toBe(1);
  });

  it("should render only one menu per excalidraw instance (two default menus scenario)", async () => {
    const { container } = await render(
      <div>
        <Excalidraw />
        <Excalidraw />
      </div>,
    );

    expect(queryAllByTestId(container, "main-menu-trigger")?.length).toBe(2);

    const excalContainers = container.querySelectorAll<HTMLDivElement>(
      ".excalidraw-container",
    );

    expect(
      queryAllByTestId(excalContainers[0], "main-menu-trigger")?.length,
    ).toBe(1);
    expect(
      queryAllByTestId(excalContainers[1], "main-menu-trigger")?.length,
    ).toBe(1);
  });
});

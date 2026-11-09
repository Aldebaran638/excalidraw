import { CaptureUpdateAction } from "@excalidraw/element";

import { act } from "@testing-library/react";

import { getNormalizedZoom } from "../scene";
import { createUndoAction, createRedoAction } from "../actions/actionHistory";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { render, unmountComponent } from "./test-utils";
const h = window.h;
unmountComponent();
const move = (deltaX: number, deltaY: number) => ({
  deltaX,
  deltaY,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
});
describe("native embedded drag transactions", () => {
  beforeEach(async () => {
    await render(<Excalidraw />);
  });
  it("moves with one native undo and redo", () => {
    const el = API.createElement({
      type: "embeddable",
      x: 100,
      y: 100,
      width: 200,
      height: 200,
    });
    act(() => {
      h.app.updateScene({
        elements: [el],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
    let drag: ReturnType<typeof h.app.beginEmbeddedDrag>;
    act(() => {
      drag = h.app.beginEmbeddedDrag(el.id);
    });
    act(() => {
      drag!.move(move(60, 30));
    });
    act(() => {
      drag!.move(move(120, 60));
    });
    act(() => {
      drag!.end();
    });
    expect(h.elements[0].x).toBe(220);
    act(() => {
      h.app.actionManager.executeAction(createUndoAction(h.history));
    });
    expect(h.elements[0].x).toBe(100);
    act(() => {
      h.app.actionManager.executeAction(createRedoAction(h.history));
    });
    expect(h.elements[0].x).toBe(220);
  });
  it("cancel restores geometry while retaining new application data", () => {
    const el = API.createElement({
      type: "embeddable",
      x: 100,
      y: 100,
      width: 200,
      height: 200,
    });
    act(() => {
      h.app.updateScene({
        elements: [el],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
    let drag: ReturnType<typeof h.app.beginEmbeddedDrag>;
    act(() => {
      drag = h.app.beginEmbeddedDrag(el.id);
    });
    act(() => {
      drag!.move(move(60, 30));
    });
    act(() => {
      h.app.scene.mutateElement(el, { customData: { count: 3 } });
    });
    act(() => {
      drag!.end(true);
    });
    expect(el.x).toBe(100);
    expect(el.customData?.count).toBe(3);
    expect(h.state.selectedElementsAreBeingDragged).toBe(false);
  });
  it("scales viewport deltas and moves an entire group", () => {
    const a = API.createElement({
      type: "embeddable",
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      groupIds: ["group"],
    });
    const b = API.createElement({
      type: "rectangle",
      x: 300,
      y: 100,
      width: 100,
      height: 100,
      groupIds: ["group"],
    });
    act(() => {
      h.app.updateScene({
        elements: [a, b],
        appState: { zoom: { value: getNormalizedZoom(0.5) } },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
    let drag: ReturnType<typeof h.app.beginEmbeddedDrag>;
    act(() => {
      drag = h.app.beginEmbeddedDrag(a.id);
    });
    act(() => {
      expect(drag!.move(move(50, 20))).toBe(true);
    });
    act(() => {
      drag!.end();
    });
    expect(a.x).toBe(200);
    expect(b.x).toBe(400);
    expect(a.y).toBe(140);
    expect(b.y).toBe(140);
  });
  it("cancels on deletion and releases the transaction", () => {
    const el = API.createElement({ type: "embeddable", x: 100, y: 100 });
    act(() => {
      h.app.updateScene({
        elements: [el],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
    let drag: ReturnType<typeof h.app.beginEmbeddedDrag>;
    act(() => {
      drag = h.app.beginEmbeddedDrag(el.id);
    });
    act(() => {
      drag!.move(move(20, 20));
    });
    act(() => {
      h.app.scene.replaceAllElements([]);
    });
    act(() => {
      expect(drag!.move(move(40, 40))).toBe(false);
    });
    expect(h.elements).toHaveLength(0);
    expect(h.state.selectedElementsAreBeingDragged).toBe(false);
  });
  it("rejects locked and non-selection targets", () => {
    const el = API.createElement({ type: "embeddable", locked: true });
    act(() => {
      h.app.updateScene({
        elements: [el],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
    expect(h.app.beginEmbeddedDrag(el.id)).toBeNull();
    expect(h.app.beginEmbeddedDrag("missing")).toBeNull();
  });
});

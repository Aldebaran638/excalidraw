import { describe, expect, it, vi } from "vitest";
import { newEmbeddableElement } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { EXAMPLES } from "../../packages/interactive-widgets/examples";
import { commitWidgetScene } from "../data/widgetScene";

import type { WidgetDocument } from "../../packages/interactive-widgets/types";

const document = (): WidgetDocument => ({
  version: 2,
  catalogVersion: 2,
  definition: { ...EXAMPLES.calculator, version: 2 },
  state: { ...EXAMPLES.calculator.initialState },
  prompt: "测试",
});
const fixture = (initial: ExcalidrawElement[] = []) => {
  let elements = initial;
  const updateScene = vi.fn((update) => {
    elements = update.elements;
  });
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    updateScene,
  } as unknown as ExcalidrawImperativeAPI;
  return { api, updateScene, elements: () => elements };
};
describe("shared native widget scene commands", () => {
  it("inserts independent native elements and captures exactly one history entry per insertion", () => {
    const { api, elements, updateScene } = fixture();
    const doc = document();
    const options = {
      document: doc,
      region: { x: 10, y: 20, width: 700, height: 480 },
    };
    const first = commitWidgetScene(api, options);
    const second = commitWidgetScene(api, options);
    expect(first.id).not.toBe(second.id);
    expect(elements().every((element) => element.type === "embeddable")).toBe(
      true,
    );
    expect(updateScene).toHaveBeenCalledTimes(2);
    expect(updateScene.mock.calls[0][0].appState).toEqual({
      selectedElementIds: { [first.id]: true },
    });
    expect(first.document.state).not.toBe(second.document.state);
    expect(first.document.state).not.toBe(doc.state);
  });
  it("preserves current geometry and live compatible inputs, and blocks stale definitions without an update", () => {
    const original = document();
    const old = newEmbeddableElement({
      type: "embeddable",
      x: 999,
      y: 33,
      width: 333,
      height: 222,
      customData: { aiWidget: original, userField: "keep" },
    });
    const { api, elements, updateScene } = fixture([old]);
    const modified = {
      ...document(),
      definition: { ...document().definition, title: "修改后计算器" },
    };
    const source = {
      noteId: "note-owned",
      sessionId: "session-owned",
      artifactId: "artifact-owned",
      version: 2,
    };
    const result = commitWidgetScene(api, {
      document: modified,
      region: { x: 0, y: 0, width: 700, height: 480 },
      target: old.id,
      baseDefinition: original.definition,
      liveState: { ...original.state, a: 71 },
      source,
    });
    expect(result.id).toBe(old.id);
    expect(result.document.state.a).toBe(71);
    expect(elements()[0]).toMatchObject({
      x: 999,
      y: 33,
      width: 333,
      height: 222,
      customData: { userField: "keep", aiWidgetChatSource: source },
    });
    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(updateScene.mock.calls[0][0].appState).toBeUndefined();
    expect(() =>
      commitWidgetScene(api, {
        document: modified,
        region: old,
        target: old.id,
        baseDefinition: original.definition,
      }),
    ).toThrow("定义已变化");
    expect(updateScene).toHaveBeenCalledTimes(1);
  });
  it("rejects deleted targets and supports explicitly adopting trial inputs", () => {
    const doc = document();
    const old = newEmbeddableElement({
      type: "embeddable",
      x: 0,
      y: 0,
      width: 500,
      height: 400,
      customData: { aiWidget: doc },
    });
    const { api } = fixture([old]);
    expect(
      commitWidgetScene(api, {
        document: { ...doc, state: { ...doc.state, a: 42 } },
        region: old,
        target: old.id,
        baseDefinition: doc.definition,
        trialInputs: true,
      }).document.state.a,
    ).toBe(42);
    const deleted = fixture([{ ...old, isDeleted: true }]);
    expect(() =>
      commitWidgetScene(deleted.api, {
        document: doc,
        region: old,
        target: old.id,
        baseDefinition: doc.definition,
      }),
    ).toThrow("已删除");
  });
});

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { newElementWith, newEmbeddableElement } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  readWidget,
  reconcileState,
} from "../../packages/interactive-widgets/schema";
import { renderSnapshot } from "../../packages/interactive-widgets/snapshot";
import { WIDGET_LINK_PREFIX } from "../../packages/interactive-widgets/types";

import { definitionKey } from "./chatWidgets";

import type {
  WidgetDefinition,
  WidgetDocument,
  WidgetState,
} from "../../packages/interactive-widgets/types";
import type { ChatWidgetSource } from "./chatWidgets";

export const widgetMetadata = (
  doc: WidgetDocument,
  width: number,
  height: number,
  scroll = 0,
) => ({
  aiWidget: doc,
  embeddable: {
    contentLocked: true,
    interaction: "controls",
    snapshot: renderSnapshot(doc, width, height, scroll),
    snapshotWidth: width,
    snapshotHeight: height,
  },
});
export const commitWidgetScene = (
  api: ExcalidrawImperativeAPI,
  options: {
    document: WidgetDocument;
    region: { x: number; y: number; width: number; height: number };
    target?: string;
    baseDefinition?: WidgetDefinition;
    liveState?: WidgetState;
    trialInputs?: boolean;
    source?: ChatWidgetSource;
    resizeTarget?: boolean;
  },
) => {
  const elements = api.getSceneElementsIncludingDeleted();
  const old = options.target
    ? elements.find(
        (element) => element.id === options.target && !element.isDeleted,
      )
    : undefined;
  const previous = readWidget(old?.customData?.aiWidget);
  if (
    options.target &&
    (!old ||
      old.type !== "embeddable" ||
      !previous ||
      !options.baseDefinition ||
      definitionKey(previous.definition) !==
        definitionKey(options.baseDefinition))
  ) {
    throw new Error(
      "目标已删除或组件定义已变化，请基于新版重新生成，或将候选导入为新组件。",
    );
  }
  if (!readWidget(options.document)) {
    throw new Error("候选组件数据无效");
  }
  const reconciled = reconcileState(
    previous
      ? { ...previous, state: options.liveState || previous.state }
      : null,
    options.document.definition,
  );
  const document: WidgetDocument = {
    ...options.document,
    version: 2,
    catalogVersion: 2,
    definition: { ...options.document.definition, version: 2 },
    state: structuredClone(
      previous && !options.trialInputs
        ? reconciled.state
        : options.document.state,
    ),
  };
  const region =
    old && !options.resizeTarget
      ? { x: old.x, y: old.y, width: old.width, height: old.height }
      : options.region;
  const metadata = {
    ...widgetMetadata(document, region.width, region.height),
    ...(options.source ? { aiWidgetChatSource: options.source } : {}),
  };
  const element = old
    ? newElementWith(old, {
        ...(options.resizeTarget
          ? { width: region.width, height: region.height }
          : {}),
        customData: { ...old.customData, ...metadata },
      })
    : newEmbeddableElement({
        type: "embeddable",
        ...region,
        strokeColor: "#6366f1",
        backgroundColor: "#f8f8fc",
        strokeWidth: 1,
        roughness: 0,
        customData: metadata,
      });
  const result = old
    ? element
    : newElementWith(element, { link: WIDGET_LINK_PREFIX + element.id });
  api.updateScene({
    elements: old
      ? elements.map((item) => (item.id === old.id ? result : item))
      : [...elements, result],
    ...(!old
      ? { appState: { selectedElementIds: { [result.id]: true } } }
      : {}),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return { id: result.id, document, reset: reconciled.reset };
};

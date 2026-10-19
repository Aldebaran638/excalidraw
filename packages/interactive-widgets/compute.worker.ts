import { computeWidget } from "./compute";
import { layoutWidget } from "./layout";
const context =
  typeof self.OffscreenCanvas === "function"
    ? new self.OffscreenCanvas(1, 1).getContext("2d")
    : null;
const measureText = context
  ? (text: string, size: number, weight: string) => {
      context.font = `${
        weight === "bold" ? 700 : weight === "medium" ? 500 : 400
      } ${size}px system-ui,sans-serif`;
      return context.measureText(text).width;
    }
  : undefined;
self.postMessage({ ready: true });
self.onmessage = (event) => {
  try {
    const { definition, state, requestId, width } = event.data;
    const { tree } = computeWidget(definition, state);
    const layout = layoutWidget(tree, width, measureText);
    self.postMessage({ requestId, tree, layout });
  } catch (error) {
    self.postMessage({
      requestId: event.data.requestId,
      error: (error as Error).message,
    });
  }
};

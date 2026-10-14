import { computeWidget } from "./compute";
import { layoutWidget } from "./layout";
self.postMessage({ ready: true });
self.onmessage = (event) => {
  try {
    const { definition, state, requestId, width } = event.data;
    const { tree } = computeWidget(definition, state);
    const layout = layoutWidget(tree, width);
    self.postMessage({ requestId, tree, layout });
  } catch (error) {
    self.postMessage({
      requestId: event.data.requestId,
      error: (error as Error).message,
    });
  }
};

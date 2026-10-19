import type { layoutWidget } from "./layout";
import type { WidgetDefinition, WidgetState } from "./types";

type Layout = ReturnType<typeof layoutWidget>;
const layouts = new Map<string, Layout>();
export const layoutKey = (
  definition: WidgetDefinition,
  state: WidgetState,
  width: number,
) => JSON.stringify([definition, state, width]);
export const rememberLayout = (key: string, layout: Layout) => {
  layouts.delete(key);
  layouts.set(key, layout);
  while (layouts.size > 30) {
    layouts.delete(layouts.keys().next().value!);
  }
};
export const recalledLayout = (
  definition: WidgetDefinition,
  state: WidgetState,
  width: number,
) => layouts.get(layoutKey(definition, state, width));

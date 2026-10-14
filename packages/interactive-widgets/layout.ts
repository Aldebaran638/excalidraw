import { isContainer } from "./catalog";

import type { LayoutBox, ResolvedNode } from "./types";

export const formatValue = (v: unknown): string =>
  typeof v === "number"
    ? Number(v.toPrecision(6)).toString()
    : typeof v === "string"
    ? v
    : JSON.stringify(v) ?? "";
export const nodeText = (node: ResolvedNode) =>
  formatValue(node.resolved.text ?? node.text ?? node.value ?? "");
export const layoutWidget = (root: ResolvedNode, availableWidth: number) => {
  const boxes: LayoutBox[] = [];
  const measure = (
    node: ResolvedNode,
    x: number,
    y: number,
    width: number,
  ): number => {
    const index = boxes.length;
    boxes.push({ node, x, y, width, height: 0 });
    const padding = node.style?.padding ?? (isContainer(node.type) ? 12 : 4);
    const gap = node.style?.gap ?? 10;
    let height = 0;
    if (isContainer(node.type)) {
      const heading = node.resolved.text ?? node.text ?? node.label;
      const header = heading ? 30 : 0;
      const inner = Math.max(40, width - padding * 2);
      const columns = ["row", "grid"].includes(node.type)
        ? Math.max(
            1,
            Math.min(
              node.columns || (node.type === "row" ? node.children.length : 2),
              Math.floor(inner / 220),
            ),
          )
        : 1;
      let cursorY = y + padding + header;
      for (let i = 0; i < node.children.length; i += columns) {
        const group = node.children.slice(i, i + columns);
        const cw = (inner - (columns - 1) * gap) / columns;
        const rowY = cursorY;
        const rowHeight = Math.max(
          ...group.map((child, j) =>
            measure(child, x + padding + j * (cw + gap), rowY, cw),
          ),
          0,
        );
        cursorY += rowHeight + gap;
      }
      height = Math.max(
        header + padding * 2,
        cursorY - y - (node.children.length ? gap : 0) + padding,
      );
    } else if (
      ["chart", "geometry", "matrix", "table", "heatmap"].includes(node.type)
    ) {
      const value = node.value;
      height = ["matrix", "table", "heatmap"].includes(node.type)
        ? Math.min(
            280,
            Math.max(90, (Array.isArray(value) ? value.length : 3) * 34 + 38),
          )
        : 230;
    } else if (node.type === "divider") {
      height = 12;
    } else if (node.type === "spacer") {
      height = 12;
    } else if (node.type === "icon") {
      height = 32;
    } else if (
      ["number", "input", "slider", "select", "toggle", "player"].includes(
        node.type,
      )
    ) {
      height = 76;
    } else if (node.type === "button") {
      height = 46;
    } else {
      const size = node.style?.fontSize ?? (node.type === "title" ? 22 : 14);
      const chars = Math.max(5, Math.floor((width - 12) / (size * 0.75)));
      height = Math.max(
        34,
        Math.ceil(nodeText(node).length / chars) * (size + 7) +
          8 +
          (node.label ? 24 : 0),
      );
    }
    boxes[index].height = height;
    return height;
  };
  const width = Math.max(120, Math.min(6000, availableWidth));
  const height = measure(root, 0, 0, width);
  return { boxes, width, height };
};

export const chartPoints = (value: unknown, width: number, height: number) => {
  if (!Array.isArray(value)) {
    return [];
  }
  const points = value
    .slice(0, 2000)
    .map((v, i) =>
      Array.isArray(v) ? [Number(v[0]), Number(v[1])] : [i, Number(v)],
    )
    .filter((p) => p.every(Number.isFinite));
  if (!points.length) {
    return [];
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  return points.map(([x, y]) => [
    24 + ((x - minX) / (maxX - minX || 1)) * Math.max(10, width - 48),
    height - 24 - ((y - minY) / (maxY - minY || 1)) * Math.max(10, height - 48),
  ]);
};

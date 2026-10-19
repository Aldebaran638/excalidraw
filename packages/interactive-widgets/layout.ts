import { layout as graphLayout } from "dagre-d3-es/src/dagre/index.js";
import { Graph } from "dagre-d3-es/src/graphlib/graph.js";

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
/** Shared geometry for live controls and trusted static export. */
export const segmentedGeometry = (width: number, count: number) => {
  const columns = Math.max(1, Math.min(count, Math.floor((width - 8) / 120)));
  return {
    columns,
    cellWidth: Math.max(1, (width - 8 - (columns - 1) * 4) / columns),
    rows: Math.ceil(count / columns),
    rowHeight: 48,
    gap: 4,
    top: 28,
  };
};
export const layoutWidget = (
  root: ResolvedNode,
  availableWidth: number,
  measureText?: (text: string, size: number, weight: string) => number,
) => {
  const boxes: LayoutBox[] = [];
  const edges: {
    id: string;
    from: string;
    to: string;
    label: string;
    path: string;
    x: number;
    y: number;
    directed: boolean;
    selected: boolean;
  }[] = [];
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
    if (node.type === "diagram") {
      const graph = new Graph({ compound: true, multigraph: true });
      graph.setGraph({
        rankdir: width < 700 ? "TB" : node.direction || "LR",
        ranksep: 65,
        nodesep: 24,
        marginx: 16,
        marginy: 32,
      });
      graph.setDefaultEdgeLabel(() => ({}));
      const families = new Map<string, LayoutBox[]>();
      const nodes = new Map<string, ResolvedNode>();
      const visit = (child: ResolvedNode, parent?: string) => {
        nodes.set(child.id, child);
        if (child.type === "group") {
          graph.setNode(child.id, { label: child.label || child.text || "" });
          child.children.forEach((c) => visit(c, child.id));
        } else {
          const start = boxes.length;
          measure(child, 0, 0, Math.max(160, Math.min(220, width - 64)));
          const family = boxes.splice(start);
          families.set(child.id, family);
          graph.setNode(child.id, {
            width: family[0].width,
            height: family[0].height,
          });
        }
        if (parent) {
          graph.setParent(child.id, parent);
        }
      };
      node.children.forEach((c) => visit(c));
      for (const edge of node.relations || []) {
        if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
          throw new Error(
            "关系端点必须引用显式图节点，不能引用重复模板或内容子节点",
          );
        }
        graph.setEdge(
          edge.from,
          edge.to,
          {
            width: edge.label ? Math.min(180, edge.label.length * 8) : 0,
            height: edge.label ? 20 : 0,
          },
          edge.id,
        );
      }
      graphLayout(graph, {});
      // Compound graphs can fan out wider than a narrow note. Reflow whole
      // groups vertically without scaling text, keeping Dagre's internal layout.
      if (
        graph.graph().width > width &&
        node.children.every((child) => graph.node(child.id).width <= width - 32)
      ) {
        const shifts = new Map<string, { x: number; y: number }>();
        let cursor = 32;
        for (const child of node.children) {
          const position = graph.node(child.id);
          shifts.set(child.id, {
            x: (width - position.width) / 2 - (position.x - position.width / 2),
            y: cursor - (position.y - position.height / 2),
          });
          cursor += position.height + 52;
        }
        const family = (id: string) => {
          let parent = id;
          while (graph.parent(parent)) {
            parent = graph.parent(parent)!;
          }
          return parent;
        };
        for (const id of nodes.keys()) {
          const shift = shifts.get(family(id))!;
          const position = graph.node(id);
          position.x += shift.x;
          position.y += shift.y;
        }
        (node.relations || []).forEach((edge, index) => {
          const route = graph.edge(edge.from, edge.to, edge.id);
          if (family(edge.from) === family(edge.to)) {
            const shift = shifts.get(family(edge.from))!;
            route.points = route.points.map(
              (point: { x: number; y: number }) => ({
                x: point.x + shift.x,
                y: point.y + shift.y,
              }),
            );
            if (route.x !== undefined) {
              route.x += shift.x;
              route.y += shift.y;
            }
          } else {
            const from = graph.node(edge.from);
            const to = graph.node(edge.to);
            const lane = width - 8 - (index % 3) * 10;
            route.points = [
              { x: from.x + from.width / 2, y: from.y },
              { x: lane, y: from.y },
              { x: lane, y: to.y },
              { x: to.x + to.width / 2, y: to.y },
            ];
            route.x = lane - 6;
            route.y = (from.y + to.y) / 2;
          }
        });
        graph.graph().width = width;
        graph.graph().height = cursor - 20;
      }
      for (const [id, child] of nodes) {
        const pos = graph.node(id);
        const px = x + pos.x - pos.width / 2;
        const py = y + pos.y - pos.height / 2;
        if (child.type === "group") {
          boxes.push({
            node: child,
            x: px,
            y: py,
            width: pos.width,
            height: pos.height,
          });
        } else {
          for (const box of families.get(id)!) {
            boxes.push({ ...box, x: px + box.x, y: py + box.y });
          }
        }
      }
      for (const edge of node.relations || []) {
        const routed = graph.edge(edge.from, edge.to, edge.id);
        const points = routed.points as { x: number; y: number }[];
        edges.push({
          ...edge,
          id: `${node.instanceId}:${edge.id}`,
          label: edge.label || "",
          directed: edge.directed !== false,
          path: points
            .map((p, i) => `${i ? "L" : "M"}${p.x + x} ${p.y + y}`)
            .join(" "),
          x: (routed.x || points[Math.floor(points.length / 2)].x) + x,
          y: (routed.y || points[Math.floor(points.length / 2)].y) + y,
          selected: Boolean(
            nodes.get(edge.from)?.resolved.selected ||
              nodes.get(edge.to)?.resolved.selected,
          ),
        });
      }
      width = Math.max(width, graph.graph().width || 0);
      boxes[index].width = width;
      height = graph.graph().height || 80;
    } else if (isContainer(node.type)) {
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
            Math.max(90, (Array.isArray(value) ? value.length : 3) * 44 + 38),
          )
        : 230;
    } else if (node.type === "divider") {
      height = 12;
    } else if (node.type === "spacer") {
      height = 12;
    } else if (node.type === "icon") {
      height = 32;
    } else if (node.type === "segmented") {
      const geometry = segmentedGeometry(width, node.options?.length || 1);
      boxes[index].segments = node.options?.map((option, i) => ({
        x: 4 + (i % geometry.columns) * (geometry.cellWidth + geometry.gap),
        y:
          geometry.top +
          Math.floor(i / geometry.columns) *
            (geometry.rowHeight + geometry.gap),
        width: geometry.cellWidth,
        lines: wrapText(
          option,
          Math.max(1, geometry.cellWidth - 18),
          12,
          measureText ? (text) => measureText(text, 12, "normal") : undefined,
        ).slice(0, 2),
      }));
      height =
        geometry.top + geometry.rows * (geometry.rowHeight + geometry.gap) + 4;
    } else if (node.type === "textarea") {
      height = 136;
      boxes[index].lines = wrapText(
        formatValue(node.value),
        Math.max(1, width - 26),
        14,
        measureText ? (text) => measureText(text, 14, "normal") : undefined,
      );
    } else if (
      ["number", "input", "slider", "select", "toggle", "player"].includes(
        node.type,
      )
    ) {
      height = 76;
    } else if (node.type === "button") {
      height = 46;
    } else {
      const size =
        node.style?.fontSize ??
        (node.type === "title" ? 22 : node.type === "caption" ? 12 : 14);
      const lines = wrapText(
        nodeText(node),
        width - 12,
        size,
        measureText
          ? (text) => measureText(text, size, node.style?.weight || "normal")
          : undefined,
      );
      boxes[index].lines = lines;
      height = Math.max(
        34,
        lines.length * (size + 7) + 8 + (node.label ? 24 : 0),
      );
    }
    boxes[index].height = height;
    return height;
  };
  const width = Math.max(120, Math.min(6000, availableWidth));
  const height = measure(root, 0, 0, width);
  return {
    boxes,
    edges,
    width: Math.max(width, ...boxes.map((b) => b.x + b.width)),
    height,
  };
};

/** Deterministic Unicode line breaking shared by DOM and SVG, not UTF-16 counts. */
export const wrapText = (
  text: string,
  width: number,
  size: number,
  measureText?: (text: string) => number,
) => {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let used = 0;
    for (const char of paragraph) {
      let advance =
        size *
        (/\s/.test(char) ? 0.32 : char.codePointAt(0)! <= 0x24f ? 0.58 : 1);
      if (measureText) {
        advance = measureText(line + char) - used;
      }
      if (used + advance > width && line) {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += char;
      used += advance;
    }
    lines.push(line);
  }
  return lines;
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

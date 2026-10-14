import { computeWidget } from "./compute";
import { ICONS, isContainer } from "./catalog";
import { chartPoints, formatValue, layoutWidget, nodeText } from "./layout";
import { renderFormula } from "./formula";

import type { WidgetDocument } from "./types";

const escape = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
export const renderSnapshot = (
  doc: WidgetDocument,
  width: number,
  height: number,
  scroll = 0,
) => {
  const { tree } = computeWidget(doc.definition, doc.state);
  const { boxes } = layoutWidget(tree, width);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f8f8fc"/><g transform="translate(0 ${-scroll})" font-family="system-ui,sans-serif">`,
  ];
  for (const { node, x, y, width: w, height: h } of boxes) {
    const style = node.style || {};
    const bg =
      node.resolved.background ||
      style.background ||
      (["card", "pressable"].includes(node.type) ? "#ffffff" : "none");
    const color = node.resolved.color || style.color || "#242436";
    const border =
      node.resolved.borderColor ||
      style.borderColor ||
      (node.resolved.selected ? "#6366f1" : "#dedee8");
    const size =
      style.fontSize ||
      (node.type === "title" ? 22 : node.type === "caption" ? 12 : 14);
    const weight =
      style.weight === "bold" ? 700 : style.weight === "medium" ? 500 : 400;
    out.push(
      `<g transform="translate(${x} ${y})"><rect width="${w}" height="${h}" rx="${
        style.radius ?? 10
      }" fill="${escape(bg)}" stroke="${
        ["card", "pressable", "badge"].includes(node.type)
          ? escape(border)
          : "none"
      }"/>`,
    );
    const text = (v: unknown, tx = 8, ty = 22, fs = size) =>
      out.push(
        `<text x="${tx}" y="${ty}" font-size="${fs}" fill="${escape(
          color,
        )}" font-weight="${weight}">${escape(v)}</text>`,
      );
    if (node.error) {
      text(node.error);
    } else if (isContainer(node.type)) {
      const heading = node.resolved.text ?? node.text ?? node.label;
      if (heading) {
        text(formatValue(heading), style.padding ?? 12);
      }
    } else if (node.type === "divider") {
      out.push(`<path d="M0 6H${w}" stroke="#dedee8"/>`);
    } else if (node.type === "icon") {
      text(ICONS[node.icon || "info"], 8, 26, 24);
    } else if (node.type === "formula") {
      out.push(
        `<g transform="translate(4 4)" color="${escape(color)}">${renderFormula(
          nodeText(node),
          Math.max(1, w - 8),
          Math.max(1, h - 8),
        )}</g>`,
      );
    } else if (["chart", "geometry"].includes(node.type)) {
      text(node.label);
      const points = chartPoints(node.value, w, h - 28);
      out.push('<g transform="translate(0 24)">');
      out.push(
        `<path d="M24 0V${h - 52}H${w - 12}" fill="none" stroke="${escape(
          color,
        )}" opacity=".35"/>`,
      );
      if (node.chartType === "bar") {
        points.forEach(([px, py]) =>
          out.push(
            `<rect x="${px - 4}" y="${py}" width="8" height="${Math.max(
              0,
              h - 52 - py,
            )}" fill="${escape(color)}"/>`,
          ),
        );
      } else if (node.chartType === "scatter") {
        points.forEach(([px, py]) =>
          out.push(
            `<circle cx="${px}" cy="${py}" r="3" fill="${escape(color)}"/>`,
          ),
        );
      } else {
        out.push(
          `<polyline points="${points
            .map((p) => p.join(","))
            .join(" ")}" fill="${
            node.type === "geometry" ? "rgba(99,102,241,.12)" : "none"
          }" stroke="${escape(color)}" stroke-width="2"/>`,
        );
      }
      out.push("</g>");
    } else if (["table", "matrix", "heatmap"].includes(node.type)) {
      text(node.label);
      const rows = node.value ?? (node.bind ? doc.state[node.bind] : []);
      if (Array.isArray(rows)) {
        rows.slice(0, 20).forEach((row, i) => {
          const cells = Array.isArray(row) ? row : [row];
          const cw = (w - 8) / Math.max(1, cells.length);
          cells.slice(0, 20).forEach((v, j) => {
            const cy = 28 + i * 32;
            if (cy < h - 8) {
              out.push(
                `<rect x="${
                  4 + j * cw
                }" y="${cy}" width="${cw}" height="32" fill="${
                  node.type === "heatmap" && typeof v === "number"
                    ? `rgba(90,90,200,${Math.max(
                        0.05,
                        Math.min(0.85, Math.abs(v)),
                      )})`
                    : "none"
                }" stroke="#dedee8"/>`,
              );
              text(formatValue(v), 8 + j * cw, cy + 21);
            }
          });
        });
      }
    } else if (
      ["number", "input", "slider", "select", "toggle", "player"].includes(
        node.type,
      )
    ) {
      text(node.label);
      out.push(
        `<rect x="4" y="30" width="${Math.max(
          30,
          w - 8,
        )}" height="32" rx="6" fill="#ffffff" stroke="#dedee8"/>`,
      );
      text(formatValue(doc.state[node.bind!]), 12, 51);
    } else {
      const content =
        (node.label && node.type !== "button" ? `${node.label}\n` : "") +
        (node.type === "button"
          ? node.label || nodeText(node)
          : nodeText(node));
      const chars = Math.max(4, Math.floor((w - 16) / (size * 0.75)));
      let line = 0;
      for (const paragraph of content.split("\n")) {
        for (
          let start = 0;
          start < Math.max(1, paragraph.length);
          start += chars
        ) {
          if (22 + line * (size + 7) < h) {
            text(
              paragraph.slice(start, start + chars),
              8,
              22 + line * (size + 7),
            );
          }
          line++;
        }
      }
    }
    out.push("</g>");
  }
  out.push("</g></svg>");
  return out.join("");
};

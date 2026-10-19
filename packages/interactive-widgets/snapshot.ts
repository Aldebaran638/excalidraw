import { computeWidget } from "./compute";
import { ICONS, isContainer } from "./catalog";
import { chartPoints, formatValue, layoutWidget, nodeText } from "./layout";
import { renderFormula } from "./formula";
import { iconSvg } from "./icons";
import { recalledLayout } from "./layoutCache";

import type { WidgetDocument, WidgetScrollState } from "./types";

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
  regions: WidgetScrollState = {},
) => {
  const { boxes, edges } =
    recalledLayout(doc.definition, doc.state, width) ||
    layoutWidget(computeWidget(doc.definition, doc.state).tree, width);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f8f8fc"/><g transform="translate(0 ${
      doc.version === 2 ? 0 : -scroll
    })" font-family="system-ui,sans-serif">`,
  ];
  if (doc.version === 2) {
    out.push(
      `<text x="12" y="19" fill="#737383" font-size="12">${escape(
        doc.definition.title,
      )}</text><svg x="0" y="28" width="${width}" height="${Math.max(
        1,
        height - 28,
      )}" overflow="hidden"><g transform="translate(0 ${-scroll})">`,
    );
  }
  for (const { node, x, y, width: w, height: h, lines, segments } of boxes) {
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
        ["card", "pressable", "badge", "group"].includes(node.type)
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
      if (doc.version === 2) {
        out.push(
          `<g transform="translate(4 4)" color="${escape(color)}">${iconSvg(
            node.icon || "info",
          )}</g>`,
        );
      } else {
        text(ICONS[node.icon || "info"], 8, 26, 24);
      }
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
      const local = regions[node.instanceId] || { top: 0, left: 0 };
      out.push(
        `<svg x="4" y="28" width="${Math.max(1, w - 8)}" height="${Math.max(
          1,
          h - 32,
        )}" overflow="hidden"><g transform="translate(${-local.left} ${-local.top})">`,
      );
      if (Array.isArray(rows)) {
        rows.slice(0, 20).forEach((row, i) => {
          const cells = Array.isArray(row) ? row : [row];
          const cw = Math.max(
            node.bind ? 80 : 55,
            (w - 8) / Math.max(1, cells.length),
          );
          cells.slice(0, 20).forEach((v, j) => {
            const cy = i * 44;
            out.push(
              `<rect x="${j * cw}" y="${cy}" width="${cw}" height="44" fill="${
                node.type === "heatmap" && typeof v === "number"
                  ? `rgba(90,90,200,${Math.max(
                      0.05,
                      Math.min(0.85, Math.abs(v)),
                    )})`
                  : "none"
              }" stroke="#dedee8"/>`,
            );
            out.push(
              `<svg x="${4 + j * cw}" y="${cy}" width="${Math.max(
                1,
                cw - 8,
              )}" height="44" overflow="hidden"><text x="0" y="27" font-size="${size}" fill="${escape(
                color,
              )}">${escape(formatValue(v))}</text></svg>`,
            );
          });
        });
      }
      out.push("</g></svg>");
    } else if (node.type === "segmented") {
      text(node.label, 4, 21);
      segments?.forEach((segment, i) => {
        const selected = doc.state[node.bind!] === node.options![i];
        out.push(
          `<svg x="${segment.x}" y="${segment.y}" width="${
            segment.width
          }" height="48" overflow="hidden"><rect x="0.5" y="0.5" width="${Math.max(
            1,
            segment.width - 1,
          )}" height="47" rx="6" fill="${
            selected ? "#ededfc" : "#ffffff"
          }" stroke="${selected ? "#6366f1" : "#dedee8"}"/>`,
        );
        segment.lines.forEach((line, j) =>
          text(line, 9, (48 - segment.lines.length * 18) / 2 + 14 + j * 18, 12),
        );
        out.push("</svg>");
      });
    } else if (node.type === "textarea") {
      text(node.label, 4, 21);
      out.push(
        `<svg x="4" y="28" width="${Math.max(
          1,
          w - 8,
        )}" height="102" overflow="hidden"><rect x="0.5" y="0.5" width="${Math.max(
          1,
          w - 9,
        )}" height="101" rx="6" fill="#ffffff" stroke="#dedee8"/>`,
      );
      out.push(
        `<g transform="translate(0 ${-(regions[node.instanceId]?.top || 0)})">`,
      );
      lines?.forEach((line, i) => text(line, 8, 22 + i * 21, 14));
      out.push("</g>");
      out.push("</svg>");
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
      if (lines && !node.label) {
        lines.forEach((line, index) =>
          text(line, 4, 4 + size + index * (size + 7)),
        );
        out.push("</g>");
        continue;
      }
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
  out.push(
    '<defs><marker id="iw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>',
  );
  for (const edge of edges) {
    const color = edge.selected ? "#5b5bd6" : "#92929f";
    out.push(
      `<path d="${edge.path}" fill="none" stroke="${color}" stroke-width="${
        edge.selected ? 2 : 1.3
      }"${edge.directed ? ' marker-end="url(#iw-arrow)"' : ""}/>`,
    );
    if (edge.label) {
      out.push(
        `<text x="${edge.x}" y="${
          edge.y - 5
        }" text-anchor="middle" font-size="12" fill="${color}" stroke="#f8f8fc" stroke-width="4" paint-order="stroke">${escape(
          edge.label,
        )}</text>`,
      );
    }
  }
  if (doc.version === 2) {
    out.push("</g></svg>");
  }
  out.push("</g></svg>");
  return out.join("");
};

import { parse as parseHtml } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";

import type { StyleDiagnostic } from "../data/chatHtml";

/** Warnings only. Deliberately does not reason about cross-rule cascades,
 * inheritance, media conditions, runtime assignments or visual quality. */
export function diagnoseStyles(source: string): StyleDiagnostic[] {
  const warnings: StyleDiagnostic[] = [];
  const report = (
    code: StyleDiagnostic["code"],
    offset: number,
    message: string,
  ) => {
    if (warnings.length >= 40) {
      return;
    }
    const before = source.slice(0, offset);
    warnings.push({
      code,
      line: before.split("\n").length,
      column: offset - before.lastIndexOf("\n"),
      message,
      excerpt: source.slice(Math.max(0, offset - 80), offset + 200),
    });
  };
  const inspect = (css: string, offset: number, inline = false) => {
    const prefix = inline ? "x{" : "";
    try {
      const ast = postcss.parse(prefix + css + (inline ? "}" : ""), {
        from: undefined,
      });
      ast.walkRules((rule) => {
        const declarations = new Map<
          string,
          { deps: string[]; offset: number }
        >();
        const duplicate = new Set<string>();
        for (const node of rule.nodes || []) {
          if (node.type !== "decl" || !node.prop.startsWith("--")) {
            continue;
          }
          if (declarations.has(node.prop)) {
            duplicate.add(node.prop);
          }
          const deps: string[] = [];
          valueParser(node.value).walk((part) => {
            if (
              part.type === "function" &&
              part.value.toLowerCase() === "var"
            ) {
              const name = part.nodes.find((n) => n.type === "word");
              if (name?.type === "word" && name.value.startsWith("--")) {
                deps.push(name.value);
              }
            }
          });
          declarations.set(node.prop, {
            deps,
            offset: Math.max(
              0,
              (node.source?.start?.offset || 0) - prefix.length,
            ),
          });
        }
        const done = new Set<string>();
        const active: string[] = [];
        const visit = (name: string) => {
          if (
            duplicate.has(name) ||
            done.has(name) ||
            !declarations.has(name) ||
            active.length > 300
          ) {
            return;
          }
          const index = active.indexOf(name);
          if (index >= 0) {
            report(
              "css_variable_cycle",
              offset + declarations.get(name)!.offset,
              `同一声明块中的 CSS 变量循环：${[
                ...active.slice(index),
                name,
              ].join(" → ")}；fallback 不能消除循环`,
            );
            return;
          }
          active.push(name);
          declarations.get(name)!.deps.forEach(visit);
          active.pop();
          done.add(name);
        };
        declarations.forEach((_, name) => visit(name));
      });
    } catch (error) {
      const e = error as { reason?: string; line?: number; column?: number };
      const local =
        css
          .split("\n")
          .slice(0, Math.max(0, (e.line || 1) - 1))
          .reduce((n, line) => n + line.length + 1, 0) +
        Math.max(0, (e.column || 1) - 1 - prefix.length);
      report(
        "css_parse",
        offset + local,
        `CSS 解析错误：${e.reason || "样式不完整"}`,
      );
    }
  };
  const visit = (node: any) => {
    if (node.nodeName === "style" && node.sourceCodeLocation?.startTag) {
      const start = node.sourceCodeLocation.startTag.endOffset;
      inspect(
        source.slice(
          start,
          node.sourceCodeLocation.endTag?.startOffset ??
            node.sourceCodeLocation.endOffset,
        ),
        start,
      );
    }
    for (const attr of node.attrs || []) {
      if (attr.name === "style") {
        // Entity decoding can change offsets: point at the original attribute.
        const location = node.sourceCodeLocation?.attrs?.style;
        inspect(attr.value, location?.startOffset || 0, true);
      }
    }
    for (const child of node.childNodes || []) {
      visit(child);
    }
    if (node.content) {
      visit(node.content);
    }
  };
  visit(parseHtml(source, { sourceCodeLocationInfo: true }));
  return warnings;
}

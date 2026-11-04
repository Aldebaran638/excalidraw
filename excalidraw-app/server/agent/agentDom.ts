import { parse as parseHtml } from "parse5";
import { parse as parseJS } from "acorn";

/** Conservative source/runtime cross-check, not arbitrary JS execution. Only
 * an immediate, unconditional measurement in the same lexical block qualifies.
 * Optional lookups, guarded/lazy use and incomplete ID reports are excluded. */
export function missingDomMeasurements(source: string, ids: string[]) {
  if (ids.length >= 300) {
    return [];
  }
  const present = new Set(ids);
  const errors = new Set<string>();
  const walk = (node: any, visit: (node: any) => void) => {
    if (!node || typeof node.type !== "string") {
      return;
    }
    visit(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        value.forEach((child) => walk(child, visit));
      } else if (value && typeof value === "object") {
        walk(value, visit);
      }
    }
  };
  const inspect = (ast: any, lineOffset: number) => {
    walk(ast, (block) => {
      if (block.type !== "BlockStatement" && block.type !== "Program") {
        return;
      }
      const bindings = new Map<string, { id: string; line: number }>();
      for (const statement of block.body) {
        // Crossing a branch/call/assignment is not proof of unconditional use.
        if (statement.type !== "VariableDeclaration") {
          bindings.clear();
          continue;
        }
        for (const declaration of statement.declarations) {
          const init = declaration.init;
          if (
            init?.type === "CallExpression" &&
            !init.optional &&
            init.callee.type === "MemberExpression" &&
            !init.callee.computed &&
            !init.callee.optional &&
            init.callee.object.name === "document" &&
            init.callee.property.name === "getElementById" &&
            init.arguments.length === 1 &&
            typeof init.arguments[0].value === "string" &&
            declaration.id.type === "Identifier"
          ) {
            bindings.set(declaration.id.name, {
              id: init.arguments[0].value,
              line: lineOffset + init.loc.start.line - 1,
            });
            continue;
          }
          // Only a direct initializer, not callbacks/branches or optional use.
          if (
            init?.type === "CallExpression" &&
            !init.optional &&
            init.callee.type === "MemberExpression" &&
            !init.callee.optional &&
            !init.callee.computed &&
            init.callee.property.name === "getBoundingClientRect"
          ) {
            const binding = bindings.get(init.callee.object.name);
            if (binding && !present.has(binding.id)) {
              errors.add(
                `HTML第${binding.line}行查询#${binding.id.slice(
                  0,
                  100,
                )}，同一代码块随后直接调用getBoundingClientRect，但实际DOM不存在该ID；该交互可能抛出空引用。请核对真实容器ID并修正引用，保留点击解释功能，不仅吞掉异常`,
              );
            }
          }
          if (declaration.id.type === "Identifier") {
            bindings.delete(declaration.id.name);
          }
        }
      }
    });
  };
  const visit = (node: any) => {
    if (node.tagName === "script") {
      const attrs = node.attrs || [];
      const type = attrs.find((attr: any) => attr.name === "type")?.value;
      if (!attrs.some((attr: any) => attr.name === "src")) {
        try {
          inspect(
            parseJS(
              (node.childNodes || []).map((n: any) => n.value || "").join(""),
              {
                ecmaVersion: "latest",
                sourceType: type === "module" ? "module" : "script",
                locations: true,
              },
            ),
            node.sourceCodeLocation.startTag.endLine,
          );
        } catch {
          // Syntax errors are diagnosed by the canonical source validator.
        }
      }
    }
    (node.childNodes || []).forEach(visit);
  };
  visit(parseHtml(source, { sourceCodeLocationInfo: true }));
  return [...errors].slice(0, 4);
}

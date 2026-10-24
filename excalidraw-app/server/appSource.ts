import { createHash } from "node:crypto";

import { parse as parseHtml } from "parse5";
import { parse as parseJS } from "acorn";

import { ChatError } from "./chatStore";

export const sourceHash = (source: string) =>
  createHash("sha256").update(source).digest("hex");

/** Stable categories for UI and metadata-only diagnostics. */
export const sourceErrorCode = (error: unknown) => {
  const message = (error as Error).message || "";
  if (/语法|script 标签|HTML 未完整/.test(message)) {
    return "syntax";
  }
  if (/唯一匹配|范围重叠/.test(message)) {
    return "replacement";
  }
  if (/哈希|版本|先读取/.test(message)) {
    return "version_conflict";
  }
  if (/预算|分页/.test(message)) {
    return "budget";
  }
  return error instanceof ChatError ? "invalid_request" : "storage";
};

export const readSourcePage = (
  source: string,
  startLine: number,
  lineCount: number,
  maxChars: number,
  startColumn = 0,
) => {
  const lines = source.split("\n");
  const page: string[] = [];
  let chars = 0;
  for (
    let i = startLine - 1;
    i < Math.min(lines.length, startLine - 1 + lineCount);
    i++
  ) {
    const column = i === startLine - 1 ? startColumn : 0;
    const prefix = column ? `${i + 1} (column ${column}): ` : `${i + 1}: `;
    const rest = lines[i].slice(column);
    const line = prefix + rest;
    const cost = JSON.stringify(line).length + 1;
    if (chars + cost > maxChars) {
      if (!page.length) {
        let lower = 0;
        let upper = rest.length;
        while (lower < upper) {
          const middle = Math.ceil((lower + upper) / 2);
          if (
            JSON.stringify(prefix + rest.slice(0, middle)).length + 1 <=
            maxChars
          ) {
            lower = middle;
          } else {
            upper = middle - 1;
          }
        }
        if (!lower) {
          throw new ChatError(422, "本轮阅读预算不足，请聚焦源码范围");
        }
        // Never split a UTF-16 surrogate pair at a page boundary.
        if (lower < rest.length && /[\uD800-\uDBFF]/.test(rest[lower - 1])) {
          lower--;
        }
        return {
          startLine,
          startColumn,
          endLine: i + 1,
          totalLines: lines.length,
          source: prefix + rest.slice(0, lower),
          nextLine: i + 1,
          nextColumn: column + lower,
        };
      }
      break;
    }
    page.push(line);
    chars += cost;
  }
  return {
    startLine,
    endLine: startLine + page.length - 1,
    totalLines: lines.length,
    source: page.join("\n"),
    nextLine:
      startLine + page.length <= lines.length ? startLine + page.length : null,
    nextColumn: 0,
  };
};

export const validateAppSource = (source: string) => {
  if (
    typeof source !== "string" ||
    !source.trim() ||
    Buffer.byteLength(source, "utf8") > 262144 ||
    Buffer.from(source, "utf8").toString("utf8") !== source
  ) {
    throw new ChatError(422, "源码为空或超过 256KB");
  }
  const tree = parseHtml(source, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => {
      if (error.code.startsWith("eof-in-")) {
        throw new ChatError(422, `HTML 未完整结束：${error.code}`);
      }
    },
  });
  let scriptIndex = 0;
  const visit = (node: any) => {
    for (const attribute of node.attrs || []) {
      if (/^on[a-z]+$/i.test(attribute.name)) {
        try {
          parseJS(attribute.value, {
            ecmaVersion: "latest",
            allowReturnOutsideFunction: true,
          });
        } catch (error) {
          throw new ChatError(
            422,
            `事件处理器 ${attribute.name} 语法错误：${
              (error as Error).message
            }`,
          );
        }
      }
    }
    if (node.nodeName === "script") {
      scriptIndex++;
      const type = node.attrs?.find((a: any) => a.name === "type")?.value;
      if (
        !type ||
        ["module", "text/javascript", "application/javascript"].includes(type)
      ) {
        if (!node.sourceCodeLocation?.endTag) {
          throw new ChatError(422, "script 标签未完整闭合");
        }
        if (node.attrs?.some((a: any) => a.name === "src")) {
          throw new ChatError(422, "应用脚本必须自包含，不能加载外部源码");
        }
        try {
          parseJS(
            (node.childNodes || []).map((n: any) => n.value || "").join(""),
            {
              ecmaVersion: "latest",
              sourceType: type === "module" ? "module" : "script",
            },
          );
        } catch (error) {
          const location = (error as { loc?: { line: number; column: number } })
            .loc;
          const script = (node.childNodes || [])
            .map((n: any) => n.value || "")
            .join("");
          const offset = node.sourceCodeLocation.startTag;
          const line = location
            ? offset.endLine + location.line - 1
            : offset.endLine;
          const column = location
            ? location.column + (location.line === 1 ? offset.endCol : 1)
            : offset.endCol;
          const excerpt = location
            ? script
                .split("\n")
                .slice(Math.max(0, location.line - 2), location.line + 1)
                .map((line: string) => line.slice(0, 500))
                .join("\n")
            : "";
          throw new ChatError(
            422,
            `JavaScript 语法错误：脚本 ${scriptIndex}，HTML 第 ${line} 行第 ${column} 列；${
              (error as Error).message
            }\n${excerpt}`,
          );
        }
      }
    }
    for (const child of node.childNodes || []) {
      visit(child);
    }
  };
  visit(tree);
};

export const replaceSource = (
  source: string,
  hash: string,
  edits: { oldText: string; newText: string }[],
) => {
  if (hash !== sourceHash(source)) {
    throw new ChatError(409, "源码版本已变化，请重新读取后修改");
  }
  if (!Array.isArray(edits) || !edits.length || edits.length > 100) {
    throw new ChatError(400, "编辑列表无效");
  }
  const ranges = edits
    .map((edit) => {
      if (
        !edit ||
        typeof edit.oldText !== "string" ||
        !edit.oldText ||
        typeof edit.newText !== "string" ||
        Object.keys(edit).some((key) => !["oldText", "newText"].includes(key))
      ) {
        throw new ChatError(400, "每项编辑须提供精确的 oldText 和 newText");
      }
      const start = source.indexOf(edit.oldText);
      if (start < 0 || source.indexOf(edit.oldText, start + 1) >= 0) {
        throw new ChatError(
          409,
          "待替换内容必须唯一匹配，请重新读取更完整的上下文",
        );
      }
      return { start, end: start + edit.oldText.length, ...edit };
    })
    .sort((a, b) => a.start - b.start);
  if (ranges.some((range, i) => i > 0 && range.start < ranges[i - 1].end)) {
    throw new ChatError(409, "编辑范围重叠，未应用任何修改");
  }
  let next = source;
  for (const range of [...ranges].reverse()) {
    next = next.slice(0, range.start) + range.newText + next.slice(range.end);
  }
  return next;
};

export const editSource = (
  source: string,
  hash: string,
  edits: { oldText: string; newText: string }[],
) => {
  const next = replaceSource(source, hash, edits);
  validateAppSource(next);
  return next;
};

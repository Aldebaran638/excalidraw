import { createHash } from "node:crypto";

import { parse as parseHtml } from "parse5";
import { parse as parseJS } from "acorn";

import { APP_CDN_SCRIPTS } from "../data/appLibraries";

import { ChatError } from "./chatStore";
import { SourceToolError } from "./sourceErrors";

export const sourceHash = (source: string) =>
  createHash("sha256").update(source).digest("hex");

export type SourceDiagnostic = {
  scriptIndex?: number;
  attribute?: string;
  line: number;
  column: number;
  excerpt: string;
};
export class AppSyntaxError extends ChatError {
  readonly code = "javascript_syntax";
  constructor(message: string, readonly diagnostic: SourceDiagnostic) {
    super(422, message);
  }
}

/** One exact diff against the original baseline, including all repair edits. */
export const sourceDifference = (before: string, after: string) => {
  let start = 0;
  while (
    start < Math.min(before.length, after.length) &&
    before[start] === after[start]
  ) {
    start++;
  }
  if (start === before.length && start === after.length) {
    return [];
  }
  // Use whole lines so the diff remains readable and never splits a surrogate pair.
  start = start > 0 ? before.lastIndexOf("\n", start - 1) + 1 : 0;
  let end = 0;
  while (
    end < Math.min(before.length, after.length) - start &&
    before[before.length - end - 1] === after[after.length - end - 1]
  ) {
    end++;
  }
  const suffix = before.slice(before.length - end);
  const newline = suffix.indexOf("\n");
  end = newline < 0 ? 0 : end - newline - 1;
  return [
    {
      before: before.slice(start, before.length - end),
      after: after.slice(start, after.length - end),
    },
  ];
};

/** Stable categories for UI and metadata-only diagnostics. */
export const sourceErrorCode = (error: unknown) => {
  if (error instanceof AppSyntaxError) {
    return "syntax";
  }
  if (error instanceof SourceToolError) {
    return error.code;
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
  if (
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    startLine > lines.length ||
    !Number.isInteger(lineCount) ||
    lineCount < 1 ||
    lineCount > 200 ||
    !Number.isSafeInteger(startColumn) ||
    startColumn < 0 ||
    startColumn > lines[startLine - 1].length
  ) {
    throw new SourceToolError(
      400,
      "源码分页参数无效或超出文件范围",
      "invalid_request",
    );
  }
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
          throw new SourceToolError(
            422,
            "本轮阅读预算不足，请聚焦源码范围",
            "budget",
          );
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
    startColumn,
    endLine: startLine + page.length - 1,
    totalLines: lines.length,
    source: page.join("\n"),
    nextLine:
      startLine + page.length <= lines.length ? startLine + page.length : null,
    nextColumn: 0,
  };
};

/** Authorize whole-line edits only after all columns have actually been read.
 * Long minified lines can span several pages; reading their final fragment alone
 * is not permission to replace the unseen prefix. Coverage is revision scoped. */
type ReadLineCoverage = {
  length: number;
  spans: { start: number; end: number }[];
};
export class SourceReadCoverage {
  private revisions = new Map<string, Map<number, ReadLineCoverage>>();
  record(source: string, page: ReturnType<typeof readSourcePage>) {
    const hash = sourceHash(source);
    const lines = source.split("\n");
    const revision =
      this.revisions.get(hash) || new Map<number, ReadLineCoverage>();
    this.revisions.set(hash, revision);
    for (let line = page.startLine; line <= page.endLine; line++) {
      const entry: ReadLineCoverage = revision.get(line) || {
        length: lines[line - 1].length,
        spans: [],
      };
      entry.spans.push({
        start: line === page.startLine ? page.startColumn : 0,
        end:
          line === page.endLine && page.nextColumn > 0
            ? page.nextColumn
            : entry.length,
      });
      entry.spans.sort((a, b) => a.start - b.start);
      revision.set(line, entry);
    }
  }
  firstUnread(hash: string, start: number, end: number) {
    const revision = this.revisions.get(hash);
    for (let line = start; line <= end; line++) {
      const entry = revision?.get(line);
      if (!entry) {
        return line;
      }
      let through = 0;
      for (const span of entry.spans) {
        if (span.start > through) {
          break;
        }
        through = Math.max(through, span.end);
      }
      if (through < entry.length) {
        return line;
      }
    }
    return null;
  }
}

export const searchSource = (
  source: string,
  args: {
    query: string;
    cursor?: number;
    limit?: number;
    contextLines?: number;
  },
  maxChars: number,
) => {
  const lines = source.split("\n");
  const matches: { line: number; column: number; context: string }[] = [];
  const cursor = args.cursor ?? 0;
  const context = args.contextLines ?? 1;
  if (cursor > lines.length) {
    throw new SourceToolError(
      400,
      "源码搜索位置超出文件范围",
      "invalid_request",
    );
  }
  let next: number | null = null;
  for (let i = cursor; i < lines.length; i++) {
    if (!lines[i].includes(args.query)) {
      continue;
    }
    const item = {
      line: i + 1,
      column: lines[i].indexOf(args.query),
      context: lines
        .slice(Math.max(0, i - context), i + context + 1)
        .map((line, n) => {
          const number = Math.max(0, i - context) + n + 1;
          const start =
            number === i + 1 ? Math.max(0, line.indexOf(args.query) - 200) : 0;
          return `${number}${start ? ` (column ${start})` : ""}: ${
            start ? "…" : ""
          }${line.slice(start, start + 1000)}`;
        })
        .join("\n"),
    };
    if (
      matches.length >= (args.limit ?? 5) ||
      JSON.stringify([...matches, item]).length + 250 > maxChars
    ) {
      next = i;
      break;
    }
    matches.push(item);
  }
  if (next !== null && !matches.length) {
    throw new SourceToolError(
      422,
      "本轮阅读预算不足，请缩小搜索上下文",
      "budget",
    );
  }
  return {
    matches,
    nextCursor: next,
    totalLines: lines.length,
    sourceHash: sourceHash(source),
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
        throw new SourceToolError(
          422,
          `HTML 未完整结束：${error.code}`,
          "html_incomplete",
        );
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
          const position =
            node.sourceCodeLocation?.attrs?.[attribute.name] ||
            node.sourceCodeLocation;
          const diagnostic = {
            attribute: attribute.name,
            line: position?.startLine || 1,
            column: position?.startCol || 1,
            excerpt: attribute.value.slice(0, 500),
          };
          throw new AppSyntaxError(
            `事件处理器 ${attribute.name} 语法错误：${
              (error as Error).message
            }；HTML 属性起始位置：第 ${diagnostic.line} 行第 ${
              diagnostic.column
            } 列\n${diagnostic.excerpt}`,
            diagnostic,
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
          throw new SourceToolError(
            422,
            "script 标签未完整闭合",
            "html_incomplete",
          );
        }
        const src = node.attrs?.find((a: any) => a.name === "src")?.value;
        if (src && !(APP_CDN_SCRIPTS as readonly string[]).includes(src)) {
          throw new ChatError(
            422,
            "外部脚本不在固定版本库清单中，请使用 NoteApp.load('react'|'d3'|'mermaid') 或受支持的CDN地址",
          );
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
                .slice(Math.max(0, location.line - 6), location.line + 5)
                .map((text: string, index: number) => {
                  const isErrorLine =
                    Math.max(0, location.line - 6) + index ===
                    location.line - 1;
                  const start = isErrorLine
                    ? Math.max(0, location.column - 200)
                    : 0;
                  return `${start ? "…" : ""}${text.slice(start, start + 500)}`;
                })
                .join("\n")
            : "";
          throw new AppSyntaxError(
            `JavaScript 语法错误：脚本 ${scriptIndex}，HTML 第 ${line} 行第 ${column} 列；${
              (error as Error).message
            }\n${excerpt}`,
            { scriptIndex, line, column, excerpt },
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

export type SourceEdit = { newText: string } & (
  | { oldText: string }
  | { startLine: number; endLine: number }
);
export const replaceSource = (
  source: string,
  hash: string,
  edits: SourceEdit[],
) => {
  if (hash !== sourceHash(source)) {
    throw new SourceToolError(
      409,
      "源码版本已变化，请重新读取后修改",
      "version_conflict",
    );
  }
  if (!Array.isArray(edits) || !edits.length || edits.length > 100) {
    throw new ChatError(400, "编辑列表无效");
  }
  const ranges = edits
    .map((edit) => {
      if (
        !edit ||
        typeof edit.newText !== "string" ||
        Object.keys(edit).some(
          (key) =>
            !["oldText", "newText", "startLine", "endLine"].includes(key),
        )
      ) {
        throw new ChatError(
          400,
          "每项编辑须提供newText及唯一oldText或完整行范围",
        );
      }
      if ("startLine" in edit || "endLine" in edit) {
        const range = edit as {
          startLine: number;
          endLine: number;
          newText: string;
        };
        const lines = source.split("\n");
        if (
          "oldText" in edit ||
          !Number.isInteger(range.startLine) ||
          !Number.isInteger(range.endLine) ||
          range.startLine < 1 ||
          range.endLine < range.startLine ||
          range.endLine > lines.length ||
          range.endLine - range.startLine >= 200
        ) {
          throw new SourceToolError(
            400,
            "行范围无效、混用了oldText或超过200行，请重新读取所需范围",
            "invalid_request",
          );
        }
        const start = lines
          .slice(0, range.startLine - 1)
          .reduce((n, line) => n + line.length + 1, 0);
        const end =
          range.endLine < lines.length
            ? lines
                .slice(0, range.endLine)
                .reduce((n, line) => n + line.length + 1, 0)
            : source.length;
        const newText =
          source.slice(start, end).endsWith("\n") &&
          !range.newText.endsWith("\n")
            ? `${range.newText}\n`
            : range.newText;
        return { start, end, newText };
      }
      if (
        !("oldText" in edit) ||
        typeof edit.oldText !== "string" ||
        !edit.oldText
      ) {
        throw new ChatError(400, "oldText必须是非空字符串");
      }
      const start = source.indexOf(edit.oldText);
      if (start < 0 || source.indexOf(edit.oldText, start + 1) >= 0) {
        throw new SourceToolError(
          409,
          start < 0
            ? "待替换内容不存在：不要猜空格或引号。先搜索定位，再read_app_source读取相关完整行，改用{startLine,endLine,newText}局部行替换（不带oldText）"
            : "待替换内容出现多次：请读取相关完整行，使用{startLine,endLine,newText}明确范围，或加入前后唯一上下文，不要全局替换",
          "replacement",
        );
      }
      return { start, end: start + edit.oldText.length, newText: edit.newText };
    })
    .sort((a, b) => a.start - b.start);
  if (ranges.some((range, i) => i > 0 && range.start < ranges[i - 1].end)) {
    throw new SourceToolError(
      409,
      "编辑范围重叠，未应用任何修改",
      "replacement",
    );
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
  edits: SourceEdit[],
) => {
  const next = replaceSource(source, hash, edits);
  validateAppSource(next);
  return next;
};

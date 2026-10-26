import Ajv from "ajv";

import { readCanvasHtmlApp } from "../data/chatHtml";

import { ChatError } from "./chatStore";
import { SourceToolError } from "./sourceErrors";

import type { NoteSnapshot } from "../data/chatTypes";

const functionTool = (
  name: string,
  description: string,
  properties: object,
) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, additionalProperties: false },
  },
});
const paging = {
  cursor: { type: "integer", minimum: 0 },
  limit: { type: "integer", minimum: 1, maximum: 20 },
};
export const NOTE_TOOLS = [
  functionTool(
    "get_note_outline",
    "Read a page of the current canvas outline, labels and group IDs; no other notes.",
    paging,
  ),
  functionTool(
    "search_note",
    "Search current note text, matrix values and AI widget definitions.",
    { ...paging, query: { type: "string", maxLength: 200 } },
  ),
  functionTool(
    "read_note_elements",
    "Read current canvas elements by IDs. Optional nodeId reads an internal AI widget node scoped to its element. Use cursor to page details.",
    {
      ...paging,
      ids: { type: "array", items: { type: "string" }, maxItems: 20 },
      nodeId: { type: "string", maxLength: 200 },
    },
  ),
];
export const CHAT_WIDGET_TOOLS = [
  functionTool(
    "create_widget_draft",
    "Create ONE interactive widget draft in this chat using the safe component library. Never inserts into the canvas; user previews and imports manually. Pass a clear design instruction, not code or a definition.",
    { prompt: { type: "string", maxLength: 12000 } },
  ),
  functionTool(
    "revise_widget_draft",
    "Create a revised candidate of an existing chat artifact (artifactId, version) OR current-note AI widget (elementId). Never applies changes. If no explicit reference, use current workspace. Ask for clarification if ambiguous.",
    {
      prompt: { type: "string", maxLength: 12000 },
      artifactId: { type: "string" },
      version: { type: "integer", minimum: 1 },
      elementId: { type: "string" },
    },
  ),
  functionTool(
    "read_chat_widget",
    "Read a page of this chat's widget definition and trial state. Cannot read another session. Use nodeId/cursor for details.",
    {
      ...paging,
      artifactId: { type: "string" },
      version: { type: "integer", minimum: 1 },
      nodeId: { type: "string" },
    },
  ),
];
export const APP_SOURCE_TOOLS = [
  functionTool(
    "search_app_source",
    "Locate literal text ONLY in the selected source. Optional revision=baseline reads the immutable input source before this turn's edits, useful for restoring omitted content. Default current searches the latest candidate. Does NOT authorize edits: read_app_source of current is still required.",
    {
      query: { type: "string", minLength: 1, maxLength: 200 },
      cursor: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 10 },
      contextLines: { type: "integer", minimum: 0, maximum: 3 },
      revision: { type: "string", enum: ["current", "baseline"] },
    },
  ),
  functionTool(
    "read_app_source",
    "Read the explicitly selected application's source.html with line numbers and sourceHash. Default revision=current reads the latest candidate; revision=baseline reads the immutable input to this turn, only for reference/restoration and never for editing. Read current again before editing. Follow nextLine/nextColumn for long lines (zero-based UTF-16 columns); no paths or other targets.",
    {
      startLine: { type: "integer", minimum: 1 },
      lineCount: { type: "integer", minimum: 1, maximum: 200 },
      startColumn: { type: "integer", minimum: 0 },
      revision: { type: "string", enum: ["current", "baseline"] },
    },
  ),
  functionTool(
    "edit_app_source",
    "Atomically edit the sourceHash you just read. Each edit uses EITHER unique oldText/newText OR whole-line startLine/endLine/newText (1-based inclusive, max 200 lines). Prefer line ranges for long/ambiguous text; preserve all unchanged lines and never copy the line-number prefixes. Creates a saved preview candidate only, NEVER applies to the canvas. Re-read after an edit.",
    {
      sourceHash: { type: "string" },
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
          },
          required: ["newText"],
          oneOf: [
            {
              required: ["oldText"],
              not: {
                anyOf: [{ required: ["startLine"] }, { required: ["endLine"] }],
              },
            },
            {
              required: ["startLine", "endLine"],
              not: { required: ["oldText"] },
            },
          ],
          additionalProperties: false,
        },
      },
    },
  ),
];
// The catalog and the server use the exact same parameter schemas.
const sourceValidators = new Map(
  APP_SOURCE_TOOLS.map((tool) => {
    const parameters = {
      ...tool.function.parameters,
      required:
        tool.function.name === "edit_app_source"
          ? ["sourceHash", "edits"]
          : tool.function.name === "search_app_source"
          ? ["query"]
          : [],
    };
    Object.assign(tool.function.parameters, { required: parameters.required });
    return [
      tool.function.name,
      new Ajv({ allErrors: true }).compile(parameters),
    ] as const;
  }),
);
export function validateSourceArguments(name: string, args: unknown) {
  const validate = sourceValidators.get(name);
  if (!validate || !validate(args)) {
    throw new SourceToolError(
      400,
      `源码工具参数无效：${
        (validate?.errors || [])
          .slice(0, 4)
          .map(
            (error) =>
              `${error.dataPath || "/"} ${error.message}${
                error.keyword === "additionalProperties"
                  ? ` (${JSON.stringify(error.params)})`
                  : ""
              }`,
          )
          .join("; ")
          .slice(0, 600) || "工具不存在"
      }`,
      "invalid_request",
    );
  }
}
export const sanitizeSnapshot = (value: unknown): NoteSnapshot => {
  const data = value as NoteSnapshot;
  if (
    !data ||
    !Number.isFinite(data.capturedAt) ||
    !Array.isArray(data.elements) ||
    data.elements.length > 20000
  ) {
    throw new ChatError(400, "画布快照格式错误或规模过大");
  }
  const ids = new Set<string>();
  const elements = data.elements.map((element) => {
    if (
      !element ||
      typeof element.id !== "string" ||
      element.id.length > 200 ||
      ids.has(element.id) ||
      typeof element.type !== "string"
    ) {
      throw new ChatError(400, "快照元素 ID 无效或重复");
    }
    ids.add(element.id);
    const allowed = [
      "id",
      "type",
      "x",
      "y",
      "width",
      "height",
      "groupIds",
      "text",
      "originalText",
      "matrix",
    ];
    const output = Object.fromEntries(
      allowed
        .filter((key) => Object.hasOwn(element, key))
        .map((key) => [key, element[key]]),
    );
    // Only declarative widget data, never file payloads, links or arbitrary customData.
    const widget = (element.customData as Record<string, unknown> | undefined)
      ?.aiWidget;
    if (widget && typeof widget === "object") {
      output.aiWidget = widget;
    }
    const html = readCanvasHtmlApp(
      (element.customData as Record<string, unknown> | undefined)?.htmlApp,
    );
    if (html) {
      output.htmlApp = html;
    }
    return output;
  });
  return { capturedAt: data.capturedAt, elements };
};
export const elementTitle = (element: Record<string, unknown>) => {
  const widget = element.aiWidget as
    | { definition?: { title?: string } }
    | undefined;
  return String(
    readCanvasHtmlApp(element.htmlApp)?.title ||
      widget?.definition?.title ||
      element.text ||
      element.type,
  ).slice(0, 80);
};
const findNode = (node: unknown, id: string): unknown => {
  if (!node || typeof node !== "object") {
    return null;
  }
  const value = node as { id?: string; children?: unknown[] };
  if (value.id === id) {
    return node;
  }
  for (const child of value.children || []) {
    const found = findNode(child, id);
    if (found) {
      return found;
    }
  }
  return null;
};
export const readNoteTool = (
  snapshot: NoteSnapshot,
  name: string,
  raw: unknown,
  maxChars = 8000,
) => {
  if (!NOTE_TOOLS.some((tool) => tool.function.name === name)) {
    throw new ChatError(400, "未授权的阅读工具");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ChatError(400, "工具参数必须为对象");
  }
  const args = raw as Record<string, unknown>;
  const allowed =
    name === "read_note_elements"
      ? ["ids", "nodeId", "cursor", "limit"]
      : name === "search_note"
      ? ["query", "cursor", "limit"]
      : ["cursor", "limit"];
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new ChatError(400, "工具不能指定路径、网址或其他笔记");
  }
  const cursor = args.cursor ?? 0;
  const limit = args.limit ?? 10;
  if (
    !Number.isInteger(cursor) ||
    Number(cursor) < 0 ||
    !Number.isInteger(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 20
  ) {
    throw new ChatError(400, "分页参数不正确");
  }
  let candidates = snapshot.elements;
  if (name === "search_note") {
    if (
      typeof args.query !== "string" ||
      !args.query.trim() ||
      args.query.length > 200
    ) {
      throw new ChatError(400, "请输入有效搜索词");
    }
    const query = args.query.toLocaleLowerCase();
    candidates = candidates.filter((element) =>
      JSON.stringify(element).toLocaleLowerCase().includes(query),
    );
  }
  if (name === "read_note_elements") {
    if (
      !Array.isArray(args.ids) ||
      !args.ids.length ||
      args.ids.length > 20 ||
      args.ids.some((id) => typeof id !== "string")
    ) {
      throw new ChatError(400, "请指定当前笔记元素 ID");
    }
    const ids = args.ids as string[];
    if (
      ids.some((id) => !snapshot.elements.some((element) => element.id === id))
    ) {
      throw new ChatError(400, "元素不属于当前笔记快照");
    }
    candidates = candidates.filter((element) =>
      ids.includes(String(element.id)),
    );
    if (
      args.nodeId !== undefined &&
      (typeof args.nodeId !== "string" ||
        args.nodeId.length > 200 ||
        ids.length !== 1)
    ) {
      throw new ChatError(400, "内部节点需同时指定唯一宿主元素");
    }
    // Character paging lets even a single large component be read in bounded pieces.
    const details = candidates.map((element) => {
      if (!args.nodeId) {
        return element;
      }
      const widget = element.aiWidget as
        | { definition?: { root?: unknown } }
        | undefined;
      const node = findNode(widget?.definition?.root, args.nodeId as string);
      if (!node) {
        throw new ChatError(404, "组件内部节点不存在");
      }
      return { elementId: element.id, nodeId: args.nodeId, node };
    });
    const text = JSON.stringify(details);
    let length = Math.max(1, Math.min(7000, maxChars - 600));
    const result = {
      capturedAt: snapshot.capturedAt,
      content: text.slice(Number(cursor), Number(cursor) + length),
      nextCursor:
        Number(cursor) + length < text.length ? Number(cursor) + length : null,
      elementIds: candidates.map((element) => String(element.id)),
      encoding: "json-fragment",
    };
    // Escaping also consumes the budget; shrink pages instead of rejecting
    // every page of a large component's JSON definition.
    while (JSON.stringify(result).length > maxChars && length > 1) {
      length = Math.max(1, Math.floor(length / 2));
      result.content = text.slice(Number(cursor), Number(cursor) + length);
      result.nextCursor =
        Number(cursor) + length < text.length ? Number(cursor) + length : null;
    }
    if (JSON.stringify(result).length > maxChars) {
      throw new ChatError(413, "阅读预算不足，请减少元素数量");
    }
    return result;
  }
  const items = candidates
    .slice(Number(cursor), Number(cursor) + Number(limit))
    .map((element) => ({
      id: element.id,
      type: element.type,
      title: elementTitle(element),
      groupIds: element.groupIds || [],
    }));
  return {
    capturedAt: snapshot.capturedAt,
    total: candidates.length,
    items,
    nextCursor:
      Number(cursor) + items.length < candidates.length
        ? Number(cursor) + items.length
        : null,
    elementIds: items.map((item) => String(item.id)),
  };
};

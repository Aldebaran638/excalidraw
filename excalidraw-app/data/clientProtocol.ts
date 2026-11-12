// v10 supports image attachments and frozen-canvas screenshot feedback.
export const CHAT_PROTOCOL_VERSION = 10;
export const HTML_RUNTIME_VERSION = 3;
export const CHAT_HEADERS = {
  "X-Chat-Protocol": String(CHAT_PROTOCOL_VERSION),
  "X-Chat-Capabilities":
    "html-blocks,preview-feedback,interaction-probes,canvas-capture,chat-images",
};
export const supportsHtmlBlocks = (
  headers: Record<string, string | string[] | undefined>,
) =>
  Number(headers["x-chat-protocol"]) === CHAT_PROTOCOL_VERSION &&
  String(headers["x-chat-capabilities"] || "")
    .split(",")
    .includes("html-blocks");

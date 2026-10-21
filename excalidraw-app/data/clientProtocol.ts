export const CHAT_PROTOCOL_VERSION = 2;
export const HTML_RUNTIME_VERSION = 2;
export const CHAT_HEADERS = {
  "X-Chat-Protocol": String(CHAT_PROTOCOL_VERSION),
  "X-Chat-Capabilities": "html-blocks",
};
export const supportsHtmlBlocks = (
  headers: Record<string, string | string[] | undefined>,
) =>
  Number(headers["x-chat-protocol"]) === CHAT_PROTOCOL_VERSION &&
  String(headers["x-chat-capabilities"] || "")
    .split(",")
    .includes("html-blocks");

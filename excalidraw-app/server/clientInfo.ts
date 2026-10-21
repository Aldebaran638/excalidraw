import fs from "node:fs/promises";
import path from "node:path";
import {
  CHAT_PROTOCOL_VERSION,
  HTML_RUNTIME_VERSION,
} from "../data/clientProtocol";
export const clientInfo = async () => {
  const development = process.env.NODE_ENV !== "production";
  const html = await fs
    .readFile(
      path.resolve(
        process.env.STATIC_DIR || "excalidraw-app/build",
        "index.html",
      ),
      "utf8",
    )
    .catch(() => "");
  const entry = html.match(/src="[^" ]*\/(index-[^" ]+\.js)"/)?.[1];
  return {
    buildId: development ? "development" : entry || "unknown",
    chatProtocolVersion: CHAT_PROTOCOL_VERSION,
    htmlRuntimeVersion: HTML_RUNTIME_VERSION,
  };
};

import { readBody, sendJson } from "../notes";

import { generateWidget, WidgetGenerationError } from "./widgetGeneration";

import type { IncomingMessage, ServerResponse } from "node:http";

export type AIConfig = { baseUrl: string; model: string; apiKey?: string };
export const aiConfigFromEnv = (): AIConfig => ({
  baseUrl: process.env.QWEN_BASE_URL || "http://172.31.69.234:8006/v1",
  model: process.env.QWEN_MODEL || "qwen3.8-27b",
  apiKey: process.env.QWEN_API_KEY,
});
export const createAIHandler = (
  config: AIConfig,
  transport: typeof fetch = fetch,
) => {
  const headers = {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  };
  return async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const route = new URL(req.url || "/", "http://localhost").pathname;
    if (!route.startsWith("/api/ai/")) {
      return false;
    }
    const abort = new AbortController();
    const disconnect = () => {
      if (!res.writableEnded) {
        abort.abort();
      }
    };
    res.once("close", disconnect);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (route === "/api/ai/status" && req.method === "GET") {
        timeout = setTimeout(() => abort.abort(), 5000);
        const response = await transport(
          `${config.baseUrl.replace(/\/$/, "")}/models`,
          { headers, signal: abort.signal },
        );
        const data = (await response.json()) as { data?: { id: string }[] };
        sendJson(res, 200, {
          available:
            response.ok &&
            Boolean(data.data?.some((m) => m.id === config.model)),
          model: config.model,
        });
        return true;
      }
      if (route !== "/api/ai/widgets/generate" || req.method !== "POST") {
        sendJson(res, 404, { error: "Unknown AI endpoint" });
        return true;
      }
      const body = JSON.parse(await readBody(req, 512 * 1024));
      const result = await generateWidget(
        config,
        body,
        abort.signal,
        transport,
      );
      sendJson(res, 200, result);
    } catch (e) {
      const message = abort.signal.aborted
        ? "AI 请求已取消或超时"
        : e instanceof SyntaxError
        ? "无效请求格式"
        : (e as Error).message;
      sendJson(
        res,
        abort.signal.aborted
          ? 504
          : e instanceof WidgetGenerationError
          ? e.status
          : 502,
        { error: message },
      );
    } finally {
      clearTimeout(timeout);
      res.off("close", disconnect);
    }
    return true;
  };
};

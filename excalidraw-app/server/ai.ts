import {
  CATALOG,
  ICONS,
  OPERATIONS,
} from "../../packages/interactive-widgets/catalog";
import {
  validateDefinition,
  widgetSchema,
} from "../../packages/interactive-widgets/schema";
import { computeWidget } from "../../packages/interactive-widgets/compute";
import { layoutWidget } from "../../packages/interactive-widgets/layout";
import { EXAMPLES } from "../../packages/interactive-widgets/examples";
import {
  ARCHITECTURE,
  WORKFLOW,
  SCENARIO,
} from "../../packages/interactive-widgets/designExamples";

import { readBody, sendJson } from "./notes";

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
      if (
        typeof body.prompt !== "string" ||
        !body.prompt.trim() ||
        body.prompt.length > 12000 ||
        (body.context !== undefined &&
          (!Array.isArray(body.context) || body.context.length > 50)) ||
        (body.initialIntent !== undefined &&
          (typeof body.initialIntent !== "string" ||
            body.initialIntent.length > 12000)) ||
        (body.region !== undefined &&
          (!Number.isFinite(body.region?.width) ||
            !Number.isFinite(body.region?.height) ||
            body.region.width <= 0 ||
            body.region.height <= 0 ||
            body.region.width > 20000 ||
            body.region.height > 20000))
      ) {
        sendJson(res, 400, { error: "请输入要求，或减少上下文" });
        return true;
      }
      if (body.currentDefinition) {
        validateDefinition(body.currentDefinition);
      }
      timeout = setTimeout(() => abort.abort(), 120000);
      const messages: { role: string; content: string }[] = [
        {
          role: "system",
          content: [
            "You design interactive widgets by composing an existing component library. Return ONLY a complete JSON WidgetDefinition, no markdown. Never emit JS, HTML, CSS strings or external URLs.",
            "Use version:2, title, datasets (read-only JSON dictionaries/lists), initialState (editable state), computations (expression DAG), root (node tree). Every node has a unique id and type.",
            "Architecture uses diagram nodes: children are explicit pressable/card nodes or group containers; direction LR/TB; relations:[{id,from,to,label,directed:true}]. Endpoints reference explicit leaf node IDs, never group or nested content IDs. Graph cycles are allowed; max 60 nodes and 100 relations. Use selected bindings and dictionary lookup explanations for linked learning. Do not force calculators or data tools into card grids.",
            "Respect the provided region size, use readable text and responsive layout; never shrink text to fit. Return only the latest revised design, using currentDefinition/currentState as the base and initialIntent as context.",
            "Expressions are exactly {literal:JSONValue}, {ref:'variable.or.item.field'}, {op:'operation',args:[expressions]}. Bindings support text,visible,disabled,selected,background,color,borderColor.",
            "Actions: {type:'set',target:'stateKey',value:expression}, toggle/reset/step, or {type:'batch',actions:[actions]}. Pressable containers may have children. No onClick or function code.",
            "Repeat: {id,type:'repeat',items:expression,itemKey:'id',children:[template]}; item/index available inside. Primitive lists may omit itemKey. Use stable keys, not indices.",
            "Styles: background/color/borderColor are six-digit hex; padding/gap 0-32, radius 0-24, fontSize 12-32, align start/center/end, weight normal/medium/bold. Grid columns 1-6; responsive runtime handles narrow sizes.",
            "Computations: sample(start,end,count,expr using x) -> XY pairs; map/filter(array,expr using item/index); lookup(object,key); get(array,index); matmul,transpose,scale(matrix,scalar),softmax(vector or rows),transform2d(points,matrix). Charts consume XY pairs. Never use literal strings as expressions.",
            "Keep output concise; max 300 nodes, 600 expanded nodes, 20x20 matrices, 2000 plot points. Ensure all refs and input bind keys exist. Numeric controls require numeric initialState; select needs options; slider needs min/max; repeat needs items and children.",
            `Catalog: ${JSON.stringify(CATALOG)}`,
            `Icons: ${Object.keys(ICONS).join(",")}`,
            `Operations: ${OPERATIONS.join(",")}`,
            `Example: ${JSON.stringify(
              /矩阵|attention|softmax/i.test(body.prompt)
                ? { ...EXAMPLES.attention, version: 2 }
                : /kubernetes|k8s|架构|卡片/i.test(body.prompt)
                ? ARCHITECTURE
                : /流程|flow/i.test(body.prompt)
                ? WORKFLOW
                : /场景|分段|多行|scenario/i.test(body.prompt)
                ? SCENARIO
                : { ...EXAMPLES.calculator, version: 2 },
            )}`,
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            prompt: body.prompt,
            context: body.context || [],
            currentDefinition: body.currentDefinition,
            currentState: body.currentState,
            region: body.region,
            initialIntent: body.initialIntent,
          }),
        },
      ];
      let lastError = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await transport(
          `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",
            headers,
            signal: abort.signal,
            body: JSON.stringify({
              model: config.model,
              messages,
              stream: false,
              max_tokens: 8192,
              temperature: 0.2,
              chat_template_kwargs: { enable_thinking: false },
            }),
          },
        );
        if (!response.ok) {
          throw new Error(`模型服务返回错误 ${response.status}`);
        }
        const result = (await response.json()) as {
          choices?: {
            message?: { content?: string };
            finish_reason?: string;
          }[];
        };
        const content = result.choices?.[0]?.message?.content || "";
        if (result.choices?.[0]?.finish_reason === "length") {
          throw new Error("生成内容超过模型输出上限，请减少组件内容");
        }
        try {
          const cleaned = content
            .trim()
            .replace(/^\x60\x60\x60(?:json)?\s*/, "")
            .replace(/\x60\x60\x60$/, "")
            .trim();
          const definition = validateDefinition(JSON.parse(cleaned));
          // Validate repeated keys and initial calculation before accepting a preview.
          const computed = computeWidget(definition, definition.initialState);
          if (Object.keys(computed.errors).length) {
            throw new Error(Object.values(computed.errors).join("; "));
          }
          layoutWidget(computed.tree, body.region?.width || 700);
          sendJson(res, 200, {
            definition,
            explanation: body.currentDefinition
              ? "组件已根据要求修改，请试用后应用。"
              : "组件已生成，请试用后放入笔记。",
          });
          return true;
        } catch (error) {
          lastError = (error as Error).message;
          messages.push(
            { role: "assistant", content: content.slice(0, 100000) },
            {
              role: "user",
              content: `Repair the complete JSON once. Validation error: ${lastError}\nSchema: ${JSON.stringify(
                widgetSchema,
              )}`,
            },
          );
        }
      }
      sendJson(res, 422, { error: `组件校验未通过: ${lastError}` });
    } catch (e) {
      const message = abort.signal.aborted
        ? "AI 请求已取消或超时"
        : e instanceof SyntaxError
        ? "无效请求格式"
        : (e as Error).message;
      sendJson(res, abort.signal.aborted ? 504 : 502, { error: message });
    } finally {
      clearTimeout(timeout);
      res.off("close", disconnect);
    }
    return true;
  };
};

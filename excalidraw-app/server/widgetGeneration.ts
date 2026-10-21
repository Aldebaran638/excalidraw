import { randomUUID } from "node:crypto";

import { readSSE } from "../data/sse";
import { previewFromJSONPrefix } from "../../packages/interactive-widgets/streamPreview";

import {
  CATALOG,
  ICONS,
  OPERATIONS,
} from "../../packages/interactive-widgets/catalog";
import {
  validateDefinition,
  widgetSchema,
  WidgetDefinitionError,
} from "../../packages/interactive-widgets/schema";
import { computeWidget } from "../../packages/interactive-widgets/compute";
import { layoutWidget } from "../../packages/interactive-widgets/layout";
import { EXAMPLES } from "../../packages/interactive-widgets/examples";
import {
  ARCHITECTURE,
  WORKFLOW,
  SCENARIO,
} from "../../packages/interactive-widgets/designExamples";

import type {
  WidgetDefinition,
  WidgetState,
} from "../../packages/interactive-widgets/types";
import type { AIConfig } from "./ai";
import type { WidgetGenerationProgress } from "../../packages/interactive-widgets/streamPreview";
export type WidgetGenerationInput = {
  prompt: string;
  context?: unknown[];
  currentDefinition?: WidgetDefinition;
  currentState?: WidgetState;
  region?: { width: number; height: number };
  initialIntent?: string;
  thinking?: boolean;
};
export class WidgetGenerationError extends Error {
  constructor(message: string, public status = 422) {
    super(message);
  }
}
export const generateWidget = async (
  config: AIConfig,
  input: WidgetGenerationInput,
  parentSignal: AbortSignal,
  transport: typeof fetch = fetch,
  diagnosticContext: { turnId?: string; toolCallId?: string } = {},
  onProgress?: (progress: WidgetGenerationProgress) => void,
) => {
  if (
    !input ||
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    input.prompt.length > 12000 ||
    (input.context !== undefined &&
      (!Array.isArray(input.context) || input.context.length > 50)) ||
    (input.initialIntent !== undefined &&
      (typeof input.initialIntent !== "string" ||
        input.initialIntent.length > 12000)) ||
    (input.thinking !== undefined && typeof input.thinking !== "boolean") ||
    (input.region !== undefined &&
      (!Number.isFinite(input.region.width) ||
        !Number.isFinite(input.region.height) ||
        input.region.width <= 0 ||
        input.region.height <= 0 ||
        input.region.width > 20000 ||
        input.region.height > 20000)) ||
    JSON.stringify(input).length > 512 * 1024
  ) {
    throw new WidgetGenerationError("请输入要求，或减少上下文", 400);
  }
  if (input.currentDefinition) {
    validateDefinition(input.currentDefinition);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", cancel, { once: true });
  if (parentSignal.aborted) {
    cancel();
  }
  const timeout = setTimeout(
    () => controller.abort(new Error("组件生成超时")),
    120000,
  );
  const signal = controller.signal;
  const headers = {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  };
  const generationId = randomUUID();
  const startedAt = Date.now();
  const log = (event: string, details: Record<string, unknown> = {}) => {
    // Deliberately exclude instructions, state, model output, credentials and upstream URL.
    // eslint-disable-next-line no-console
    console.info(
      JSON.stringify({
        event: `widget_generation.${event}`,
        generationId,
        ...diagnosticContext,
        elapsedMs: Date.now() - startedAt,
        ...details,
      }),
    );
  };
  log("started");
  const sequence = { value: 0 };
  try {
    const messages: { role: string; content: string }[] = [
      {
        role: "system",
        content: [
          "You design interactive widgets by composing an existing component library. Return ONLY a complete JSON WidgetDefinition, no markdown. Never emit JS, HTML, CSS strings or external URLs.",
          "Use version:2, title, datasets (read-only JSON dictionaries/lists), initialState (editable state), computations (expression DAG), root (node tree). Every node has a unique id and type.",
          "Architecture uses diagram nodes: children are explicit pressable/card nodes or group containers; direction LR/TB; relations:[{id,from,to,label,directed:true}]. Endpoints reference explicit leaf node IDs, never group or nested content IDs. Graph cycles are allowed; max 60 nodes and 100 relations. Use selected bindings and dictionary lookup explanations for linked learning. Do not force calculators or data tools into card grids.",
          "Respect the provided region size, use readable text and responsive layout; never shrink text to fit. Return only the latest revised design, using currentDefinition/currentState as the base and initialIntent as context.",
          "Expressions are exactly {literal:JSONValue}, {ref:'variable.or.item.field'}, {op:'operation',args:[expressions]}. Bindings support text,visible,disabled,selected,background,color,borderColor.",
          "Reference scope is FLAT: use the actual keys declared in initialState, datasets or computations, NEVER prefixes state., initialState., datasets. or computations. For example datasets:{facts:{pod:'Pod explanation'}}, initialState:{selected:'pod'}, computations:{explanation:{op:'lookup',args:[{ref:'facts'},{ref:'selected'}]}}; display with data:{ref:'explanation'}. String constants must use {literal:'pod'}, not {ref:'pod'}. Do not invent formatting operations: use only the registered Operations below.",
          "Actions: {type:'set',target:'stateKey',value:expression}, toggle/reset/step, or {type:'batch',actions:[actions]}. Pressable containers may have children. No onClick or function code.",
          "Repeat: {id,type:'repeat',items:expression,itemKey:'id',children:[template]}; item/index available inside. Primitive lists may omit itemKey. Use stable keys, not indices.",
          "Styles: background/color/borderColor are six-digit hex; padding/gap 0-32, radius 0-24, fontSize 12-32, align start/center/end, weight normal/medium/bold. Grid columns 1-6; responsive runtime handles narrow sizes.",
          "Computations: sample(start,end,count,expr using x) -> XY pairs; map/filter(array,expr using item/index); lookup(object,key); get(array,index); matmul,transpose,scale(matrix,scalar),softmax(vector or rows),transform2d(points,matrix). Charts consume XY pairs. Never use literal strings as expressions.",
          "Keep output concise; max 300 nodes, 600 expanded nodes, 20x20 matrices, 2000 plot points. Ensure all refs and input bind keys exist. Numeric controls require numeric initialState; select needs options; slider needs min/max; repeat needs items and children.",
          `Catalog: ${JSON.stringify(CATALOG)}`,
          `Authoritative JSON Schema (only these properties and expression operations are supported; do not invent CSS properties or operations): ${JSON.stringify(
            widgetSchema,
          )}`,
          `The ONLY allowed style keys are: ${Object.keys(
            widgetSchema.definitions.node.properties.style.properties,
          ).join(
            ", ",
          )}. No other style property is accepted, including justifyContent and lineHeight.`,
          "In particular, style is a whitelist, not CSS: use radius, not borderRadius; weight, not fontWeight. Do not emit width, height, display, flex, margin, boxShadow or textAlign in style. Use the registered layout nodes and their allowed properties instead. These are generation instructions, not permission to silently discard unsupported output.",
          `Icons: ${Object.keys(ICONS).join(",")}`,
          `Operations: ${OPERATIONS.join(",")}`,
          `Example: ${JSON.stringify(
            /矩阵|attention|softmax/i.test(input.prompt)
              ? { ...EXAMPLES.attention, version: 2 }
              : /kubernetes|k8s|架构|卡片/i.test(input.prompt)
              ? ARCHITECTURE
              : /流程|flow/i.test(input.prompt)
              ? WORKFLOW
              : /场景|分段|多行|scenario/i.test(input.prompt)
              ? SCENARIO
              : { ...EXAMPLES.calculator, version: 2 },
          )}`,
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          prompt: input.prompt,
          context: input.context || [],
          currentDefinition: input.currentDefinition,
          currentState: input.currentState,
          region: input.region,
          initialIntent: input.initialIntent,
        }),
      },
    ];
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      log("attempt_started", { attempt: attempt + 1 });
      let content = "";
      let finish: string | undefined;
      let lastPreviewAt = 0;
      const progress = (
        phase: WidgetGenerationProgress["phase"],
        preview = false,
      ) => {
        if (!onProgress) {
          return;
        }
        const partial = preview ? previewFromJSONPrefix(content) : null;
        onProgress({
          generationId,
          attempt: attempt + 1,
          sequence: ++sequence.value,
          phase,
          ...(partial || { completedNodes: 0 }),
        });
      };
      progress(attempt ? "repairing" : "waiting");
      const response = await transport(
        `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            model: config.model,
            messages,
            stream: Boolean(onProgress),
            max_tokens: 8192,
            temperature: 0.2,
            chat_template_kwargs: { enable_thinking: input.thinking === true },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`模型服务返回错误 ${response.status}`);
      }
      if (signal.aborted) {
        throw signal.reason;
      }
      if (
        onProgress &&
        response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        if (!response.body) {
          throw new Error("组件生成流为空");
        }
        for await (const frame of readSSE(response.body)) {
          if (signal.aborted) {
            throw signal.reason;
          }
          if (frame.data === "[DONE]") {
            break;
          }
          const chunk = JSON.parse(frame.data);
          if (chunk.error) {
            throw new Error(
              `组件生成流失败：${String(
                chunk.error.message || "上游错误",
              ).slice(0, 300)}`,
            );
          }
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) {
            finish = choice.finish_reason;
          }
          if (typeof choice?.delta?.content === "string") {
            content += choice.delta.content;
            if (content.length > 262144) {
              throw new Error("组件定义过大");
            }
            if (Date.now() - lastPreviewAt >= 150) {
              progress("generating", true);
              lastPreviewAt = Date.now();
            }
          }
        }
        if (finish !== "stop") {
          throw new Error(
            finish === "length"
              ? "生成内容超过模型输出上限，请减少组件内容"
              : "组件生成连接提前结束，未完成内容不能导入",
          );
        }
      } else {
        const result = (await response.json()) as {
          choices?: {
            message?: { content?: string };
            finish_reason?: string;
          }[];
        };
        content = result.choices?.[0]?.message?.content || "";
        if (result.choices?.[0]?.finish_reason === "length") {
          throw new Error("生成内容超过模型输出上限，请减少组件内容");
        }
      }
      progress("validating", true);
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
        layoutWidget(computed.tree, input.region?.width || 700);
        log("succeeded", { attempt: attempt + 1 });
        return {
          definition,
          explanation: input.currentDefinition
            ? "组件已根据要求修改，请试用后应用。"
            : "组件已生成，请试用后放入笔记。",
        };
      } catch (error) {
        lastError = (error as Error).message;
        log("validation_failed", {
          attempt: attempt + 1,
          category:
            error instanceof WidgetDefinitionError
              ? "schema"
              : error instanceof SyntaxError
              ? "json"
              : "runtime",
          ...(error instanceof WidgetDefinitionError && {
            issues: error.issues,
          }),
        });
        messages.push(
          { role: "assistant", content: content.slice(0, 100000) },
          {
            role: "user",
            content: `Repair the complete JSON once using the authoritative Schema in the system instructions. Fix each listed path, property and constraint. Preserve the requested functionality with supported components and expressions; never invent a replacement operation. Validation errors:\n${lastError}`,
          },
        );
      }
    }

    throw new WidgetGenerationError(`组件校验未通过: ${lastError}`);
  } catch (error) {
    log("failed", { cancelled: signal.aborted });
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    parentSignal.removeEventListener("abort", cancel);
  }
};

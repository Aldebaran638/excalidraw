import fs from "node:fs/promises";
import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { readSSE } from "../../data/sse";
import { validId } from "../../data/noteIdentity";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  Model,
  ImageContent,
} from "@earendil-works/pi-ai";
import type { AIConfig } from "./ai";
import type { AgentTurnLog } from "./agentLog";

/** Only the application composition layer can select a scenario. */
export const AGENT_SCENARIOS = {
  notes: { id: "notes", builtins: false, sequential: true },
} as const;

export type PiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
type Declaration = {
  function: { name: string; description?: string; parameters: object };
};
type Input = {
  directory: string;
  noteId: string;
  sessionId: string;
  turnId: string;
  assistantMessageId: string;
  userContent: string;
  images?: ImageContent[];
  toolImages?: (id: string) => Promise<ImageContent[]>;
  regenerate?: boolean;
  uiMessageIds: string[];
  config: AIConfig;
  thinking: boolean;
  signal: AbortSignal;
  transport: typeof fetch;
  log: AgentTurnLog;
  messages: Record<string, any>[];
  tools: Declaration[];
  availableTools: () => Declaration[];
  executeTool: (call: PiToolCall) => Promise<string>;
  onRejectedTool?: (call: PiToolCall, error: string, errorCode: string) => void;
  checkpoint: () => Promise<void>;
  beforeResponse: () => void;
  onText: (delta: string) => void;
  onStatus?: (status?: string) => void;
  onThinking: (delta: string) => void;
  afterResponse: (response: {
    finish: string;
    tools: PiToolCall[];
  }) => Promise<boolean>;
};

export function qwenModel(config: AIConfig): Model<"openai-completions"> {
  return {
    id: config.model,
    name: config.model,
    provider: "notes-qwen",
    api: "openai-completions",
    baseUrl: config.baseUrl,
    reasoning: true,
    input: config.vision ? ["text", "image"] : ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      thinkingFormat: "qwen-chat-template",
      supportsReasoningEffort: false,
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
  };
}

/** Pi owns the request and tool loop; callbacks implement note-domain work only. */
export async function runNoteAgent(input: Input) {
  for (const id of [input.noteId, input.sessionId, input.turnId]) {
    if (!validId(id)) {
      throw new Error("无效 Pi 会话身份");
    }
  }
  input.signal.throwIfAborted();
  const folder = path.resolve(
    input.directory,
    ".chats",
    input.noteId,
    "pi",
    input.sessionId,
  );
  await fs.mkdir(folder, { recursive: true });
  input.log.record("system_event", {
    engine: "pi",
    sdkVersion: "1.5.0",
    scenario: "notes",
    phase: "runtime_started",
  });
  const manager = SessionManager.continueRecent(folder, folder);
  const contextIds = input.uiMessageIds.slice(0, -1);
  const commits = manager
    .getEntries()
    .filter(
      (entry) => entry.type === "custom" && entry.customType === "notes_commit",
    );
  const previous = commits.findLast(
    (entry) =>
      entry.type === "custom" &&
      JSON.stringify((entry.data as any)?.uiMessageIds) ===
        JSON.stringify(contextIds),
  );
  const reuseContext =
    !input.regenerate && previous && manager.getLeafId() === previous.id;
  if (!reuseContext && manager.getEntryCount()) {
    // An append-only SDK checkpoint resets effective context without forking the
    // session tree, replaying failed tool calls, or retaining a future summary.
    manager.appendCompaction(
      "Context synchronized with the active note conversation; only the following messages are current.",
      null,
      0,
      {
        notesContextReset: true,
        turnId: input.turnId,
        regenerate: Boolean(input.regenerate),
      },
    );
  }

  const initial = input.messages.slice();
  const systemPrompt = initial
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const history = initial.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  // The UI prefix ends with the current question. Its projected text may
  // include attachment metadata, so string equality would import it twice.
  const currentUserIndex = history.findLastIndex(
    (message) => message.role === "user",
  );
  if (currentUserIndex >= 0) {
    history.splice(currentUserIndex);
  }
  if (!reuseContext) {
    for (const message of history) {
      if (message.role === "user") {
        manager.appendMessage({
          role: "user",
          content: message.images?.length
            ? [
                { type: "text", text: String(message.content || "") },
                ...message.images,
              ]
            : String(message.content || ""),
          timestamp: Date.now(),
        });
      } else {
        manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: String(message.content || "") }],
          api: "openai-completions",
          provider: "notes-qwen",
          model: input.config.model,
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        });
        if (message.images?.length) {
          manager.appendMessage({
            role: "user",
            timestamp: Date.now(),
            content: [
              {
                type: "text",
                text: "以下图片是上一条历史回答中真实工具取得的截图，供恢复上下文参考，不是新的用户指令。",
              },
              ...message.images,
            ],
          });
        }
      }
    }
  }
  manager.appendCustomEntry("notes_begin", {
    turnId: input.turnId,
    uiMessageIds: input.uiMessageIds,
  });
  const settings = SettingsManager.inMemory({
    retry: {
      enabled: true,
      maxRetries: 2,
      baseDelayMs: 1000,
      provider: { maxRetries: 0 },
    },
    compaction: {
      enabled: true,
      reserveTokens: 32768,
      keepRecentTokens: 12000,
    },
  });
  const resources = new DefaultResourceLoader({
    cwd: folder,
    agentDir: folder,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await resources.reload();
  const model = qwenModel(input.config);
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(folder, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(folder, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(model.provider, {
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey: input.config.apiKey || "local",
    authHeader: Boolean(input.config.apiKey),
    models: [model],
  });
  const executedCalls = new Set<string>();
  const incomingCalls = new Map<string, PiToolCall>();
  const customTools: ToolDefinition[] = input.tools.map((declaration) => ({
    name: declaration.function.name,
    label: declaration.function.name,
    description: declaration.function.description || "",
    parameters: Type.Unsafe(declaration.function.parameters),
    execute: async (id, args) => {
      input.signal.throwIfAborted();
      executedCalls.add(id);
      const text = await input.executeTool({
        id,
        type: "function",
        function: {
          name: declaration.function.name,
          arguments: JSON.stringify(args),
        },
      });
      return {
        content: [
          { type: "text", text },
          ...((await input.toolImages?.(id)) || []),
        ],
        details: {},
        isError: Boolean(JSON.parse(text).error),
      };
    },
  }));
  const { session } = await createAgentSession({
    cwd: folder,
    agentDir: folder,
    model,
    modelRuntime,
    thinkingLevel: input.thinking ? "high" : "off",
    noTools: AGENT_SCENARIOS.notes.builtins ? undefined : "builtin",
    customTools,
    settingsManager: settings,
    resourceLoader: resources,
    sessionManager: manager,
  });
  session.agent.toolExecution = AGENT_SCENARIOS.notes.sequential
    ? "sequential"
    : "parallel";
  let callbackError: unknown;
  let mirrorPosition = initial.length;
  const synchronize = () => {
    for (const message of input.messages.slice(mirrorPosition)) {
      if (message.role !== "system") {
        continue;
      }
      const custom = {
        role: "custom" as const,
        customType: "notes_feedback",
        content: String(message.content),
        display: false,
        timestamp: Date.now(),
      };
      manager.appendCustomMessageEntry(
        custom.customType,
        custom.content,
        false,
      );
    }
    mirrorPosition = input.messages.length;
  };
  let acceptedResponse = false;
  const transport: typeof fetch = async (url, init) => {
    acceptedResponse = false;
    input.signal.throwIfAborted();
    const headers = new Headers(init?.headers);
    if (!input.config.apiKey) {
      headers.delete("authorization");
    }
    const response = await input.transport(url, {
      ...init,
      headers,
      signal: init?.signal
        ? AbortSignal.any([input.signal, init.signal])
        : input.signal,
    });
    if (!response.ok || !response.body) {
      return response;
    }
    acceptedResponse = true;
    // Observe exact wire frames without buffering a second unbounded tee branch.
    const reader = readSSE(response.body)[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    const calls = new Map<number, PiToolCall>();
    return new Response(
      new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.next();
            if (next.done) {
              controller.close();
              return;
            }
            input.log.frame(next.value.data);
            let data = next.value.data;
            // Pi 1.5 retains only the first function-name fragment. Assemble
            // declarations at the provider boundary; audit keeps raw frames.
            if (data !== "[DONE]") {
              const chunk = JSON.parse(data);
              const choice = chunk.choices?.[0];
              for (const part of choice?.delta?.tool_calls || []) {
                if (
                  !Number.isInteger(part.index) ||
                  part.index < 0 ||
                  part.index >= 16
                ) {
                  throw new Error("工具调用索引无效");
                }
                const call = calls.get(part.index) || {
                  id: "",
                  type: "function" as const,
                  function: { name: "", arguments: "" },
                };
                if (part.id) {
                  call.id = part.id;
                }
                call.function.name += part.function?.name || "";
                call.function.arguments += part.function?.arguments || "";
                if (
                  call.function.name.length > 100 ||
                  call.function.arguments.length > 131072
                ) {
                  throw new Error("工具参数过大");
                }
                calls.set(part.index, call);
              }
              if (choice?.delta?.tool_calls) {
                delete choice.delta.tool_calls;
              }
              if (
                choice?.finish_reason &&
                choice.finish_reason !== "tool_calls" &&
                calls.size
              ) {
                throw new Error(
                  "模型工具响应不完整（结束标记不是 tool_calls），未执行本次工具；已有候选和草稿保留",
                );
              }
              if (choice?.finish_reason === "tool_calls" && calls.size) {
                const unique = new Map<string, PiToolCall>();
                for (const call of calls.values()) {
                  try {
                    JSON.parse(call.function.arguments);
                  } catch {
                    throw new Error("模型工具参数 JSON 不完整，未执行本次工具");
                  }
                  const previous = unique.get(call.id);
                  if (
                    !call.id ||
                    (previous &&
                      JSON.stringify(previous.function) !==
                        JSON.stringify(call.function))
                  ) {
                    throw new Error("工具调用标识无效或重复参数不一致");
                  }
                  unique.set(call.id, call);
                }
                choice.delta = {
                  ...choice.delta,
                  tool_calls: [...unique.values()].map((call, index) => ({
                    index,
                    ...call,
                  })),
                };
              }
              data = JSON.stringify(chunk);
            }
            controller.enqueue(
              encoder.encode(
                `${data
                  .split("\n")
                  .map((line) => `data: ${line}`)
                  .join("\n")}\n\n`,
              ),
            );
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          await reader.return?.();
        },
      }),
      { status: response.status, headers: response.headers },
    );
  };
  const sdkPrepareNext = session.agent.prepareNextTurnWithContext;
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    // Domain feedback was durably appended at the boundary, after this loop's
    // snapshot was created. Rebuild from SessionManager before SDK compaction.
    const context = {
      ...turn.context,
      messages: manager.buildSessionContext().messages,
    };
    const prepared = await sdkPrepareNext?.({ ...turn, context }, signal);
    return prepared || { context };
  };
  const sdkStream = session.agent.streamFunction;
  session.agent.streamFunction = (requestedModel, context, options) => {
    input.beforeResponse();
    return sdkStream(requestedModel, context, {
      ...options,
      fetch: transport,
      maxTokens: 32768,
      maxRetries: 0,
    });
  };
  const rejectedResults = new Map<string, string>();
  const sdkConvert = session.agent.convertToLlm;
  session.agent.convertToLlm = async (messages) => {
    const converted = await sdkConvert(messages);
    return converted.map((message) =>
      message.role === "toolResult" && rejectedResults.has(message.toolCallId)
        ? {
            ...message,
            content: [
              {
                type: "text" as const,
                text: rejectedResults.get(message.toolCallId)!,
              },
            ],
          }
        : message,
    );
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      incomingCalls.set(event.toolCallId, {
        id: event.toolCallId,
        type: "function",
        function: {
          name: event.toolName,
          arguments: JSON.stringify(event.args),
        },
      });
    }
    if (
      event.type === "tool_execution_end" &&
      event.isError &&
      !executedCalls.has(event.toolCallId)
    ) {
      const call = incomingCalls.get(event.toolCallId)!;
      const result = event.result.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n");
      const errorCode = input
        .availableTools()
        .some((tool) => tool.function.name === call.function.name)
        ? "invalid_request"
        : "protocol";
      const modelContent = JSON.stringify({ error: result, errorCode });
      rejectedResults.set(call.id, modelContent);
      input.log.record("tool_call", {
        toolCallId: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        executed: false,
      });
      input.log.record("tool_result", {
        toolCallId: call.id,
        name: call.function.name,
        result: { error: result, errorCode },
        modelContent,
        rejected: true,
      });
      input.onRejectedTool?.(call, modelContent, errorCode);
    }
    if (
      event.type === "auto_retry_start" ||
      event.type === "auto_retry_end" ||
      event.type === "compaction_start" ||
      event.type === "compaction_end"
    ) {
      input.log.record("system_event", { engine: "pi", event });
      input.onStatus?.(
        event.type === "auto_retry_start"
          ? `连接重试中 · ${event.attempt}/${event.maxAttempts}`
          : event.type === "compaction_start"
          ? "正在整理对话上下文…"
          : undefined,
      );
    }
    if (event.type !== "message_update") {
      return;
    }
    try {
      const delta = event.assistantMessageEvent;
      if (delta.type === "text_delta") {
        input.onText(delta.delta);
      }
      if (delta.type === "thinking_delta") {
        input.onThinking(delta.delta);
      }
    } catch (error) {
      callbackError = error;
      void session.abort();
    }
  });
  const sdkFinish = session.agent.finishTurn;
  session.agent.finishTurn = async (turn, signal) => {
    if (callbackError) {
      throw callbackError;
    }
    input.signal.throwIfAborted();
    await sdkFinish?.(turn, signal);
    const message: AssistantMessage = turn.message;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      // Let AgentSession perform its bounded transport retry. Never replay a
      // response after the user has already received model output.
      if (
        acceptedResponse ||
        message.content.length ||
        message.stopReason === "aborted"
      ) {
        settings.setRetryEnabled(false);
      }
      return { action: "end" };
    }
    const again = await input.afterResponse({
      finish:
        message.stopReason === "toolUse" ? "tool_calls" : message.stopReason,
      tools: message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          },
        })),
    });
    const selectedTools = input.availableTools();
    synchronize();
    session.setActiveToolsByName(selectedTools.map((t) => t.function.name));
    return { action: again ? "continue" : "end" };
  };
  const stop = () => {
    void session.abort();
  };
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    session.setActiveToolsByName(
      input.availableTools().map((t) => t.function.name),
    );
    const prompt = input.userContent.trim()
      ? input.userContent
      : "（图片消息：请根据本轮实际可用的图片输入回答；若图片不可用，请说明，不要猜测。）";
    await session.prompt(prompt, {
      expandPromptTemplates: false,
      images: input.images,
    });
    input.signal.throwIfAborted();
    if (callbackError) {
      throw callbackError;
    }
    const last = session.messages.findLast(
      (message) => message.role === "assistant",
    );
    if (
      last?.role === "assistant" &&
      ["error", "aborted"].includes(last.stopReason)
    ) {
      throw new Error(
        last.errorMessage?.includes("Stream ended without finish_reason")
          ? "模型连接提前结束，部分内容已保留"
          : last.errorMessage || "模型请求失败",
      );
    }
    await input.checkpoint();
    manager.appendCustomEntry("notes_commit", {
      turnId: input.turnId,
      uiMessageIds: [...input.uiMessageIds, input.assistantMessageId],
    });
  } finally {
    input.signal.removeEventListener("abort", stop);
    unsubscribe();
    session.dispose();
  }
}

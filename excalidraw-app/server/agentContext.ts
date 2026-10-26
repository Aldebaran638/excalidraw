type Message = Record<string, any>;

/** Compact model-only memory, never saved history. Retire complete call/result
 * groups together: fake arguments under a real function name become bad few-shot
 * examples. Recent and in-flight native calls remain byte-for-byte intact. */
export function compactAgentContext(messages: Message[], limit: number) {
  if (JSON.stringify(messages).length < limit * 0.8) {
    return;
  }
  const results = new Map<string, Message>();
  for (const message of messages) {
    if (message.role === "tool") {
      results.set(message.tool_call_id, message);
    }
  }
  const recent = new Set(Array.from(results.keys()).slice(-3));
  const retired = new Set<string>();
  const compacted: Message[] = [];
  for (const message of messages) {
    const calls = message.role === "assistant" && message.tool_calls;
    if (
      calls?.length &&
      calls.every((call: any) => results.has(call.id) && !recent.has(call.id))
    ) {
      const receipts = calls.map((call: any) => {
        retired.add(call.id);
        const receipt: Record<string, unknown> = { tool: call.function.name };
        const result = results.get(call.id)!;
        try {
          const value = JSON.parse(result.content);
          for (const key of [
            "error",
            "errorCode",
            "revision",
            "readonly",
            "sourceHash",
            "artifactId",
            "version",
            "summary",
            "nextLine",
            "nextColumn",
            "startLine",
            "endLine",
            "totalLines",
          ]) {
            if (value[key] !== undefined) {
              receipt[key] =
                typeof value[key] === "string"
                  ? value[key].slice(0, 500)
                  : value[key];
            }
          }
        } catch {
          receipt.summary = String(result.content).slice(0, 500);
        }
        return receipt;
      });
      compacted.push({
        role: "assistant",
        content: `Earlier executed operations (receipts only, not callable arguments; re-read the current hash before editing): ${JSON.stringify(
          receipts,
        )}`,
      });
    } else if (message.role !== "tool" || !retired.has(message.tool_call_id)) {
      compacted.push(message);
    }
  }
  messages.splice(0, messages.length, ...compacted);
}

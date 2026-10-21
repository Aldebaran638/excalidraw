import { afterEach, describe, expect, it, vi } from "vitest";

import { EXAMPLES } from "../../packages/interactive-widgets/examples";
import {
  validateDefinition,
  WidgetDefinitionError,
  widgetSchema,
} from "../../packages/interactive-widgets/schema";
import { generateWidget } from "../server/widgetGeneration";

afterEach(() => vi.restoreAllMocks());
const config = {
  baseUrl: "http://fixture/v1",
  model: "qwen3.8-27b",
  apiKey: "secret-key",
};
const reply = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) } }],
    }),
  );
describe("widget generation constraints and diagnostics", () => {
  it("reports exact nested fields, allowed properties, required keys and expression constraints without changing the definition", () => {
    const bad = structuredClone(EXAMPLES.calculator) as any;
    bad.root.children[0].style = { borderRadius: 10, textAlign: "center" };
    bad.computations.displayTime = { op: "madeUpOperation", args: [] };
    delete bad.root.children[0].type;
    const before = JSON.stringify(bad);
    try {
      validateDefinition(bad);
      throw new Error("Expected schema rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WidgetDefinitionError);
      const message = (error as Error).message;
      expect(message).toContain("/root/children/0/style");
      expect(message).toContain('不支持属性 "borderRadius"');
      expect(message).toContain('不支持属性 "textAlign"');
      expect(message).toContain("radius");
      expect(message).toContain('缺少必填属性 "type"');
      expect(message).toContain("/computations/displayTime/op");
      expect(message).toContain("allowedValues");
      expect(message).not.toContain('不支持属性 "op"');
    }
    expect(JSON.stringify(bad)).toBe(before);
  });
  it("sends the actual schema on the first request and repairs with actionable errors, logging no prompt, state or output", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const bad = structuredClone(EXAMPLES.calculator) as any;
    bad.root.style = { borderRadius: 8 };
    bad.root.children[0].text = "private-output-marker";
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(bad))
      .mockResolvedValueOnce(reply(EXAMPLES.calculator));
    const result = await generateWidget(
      config,
      {
        prompt: "private-prompt-marker",
        currentState: { secret: "private-state-marker" },
      },
      new AbortController().signal,
      upstream,
      { turnId: "test-turn", toolCallId: "test-call" },
    );
    expect(result.definition).toEqual(EXAMPLES.calculator);
    expect(upstream).toHaveBeenCalledTimes(2);
    const first = JSON.parse(upstream.mock.calls[0][1]!.body as string);
    expect(first.messages[0].content).toContain(JSON.stringify(widgetSchema));
    const repaired = JSON.parse(upstream.mock.calls[1][1]!.body as string);
    expect(repaired.messages.at(-1).content).toContain(
      '不支持属性 "borderRadius"',
    );
    expect(repaired.messages.at(-1).content).toContain("允许属性");
    const events = log.mock.calls.map(([line]) => JSON.parse(line));
    expect(events.map((event) => event.event)).toContain(
      "widget_generation.validation_failed",
    );
    expect(events.at(-1).event).toBe("widget_generation.succeeded");
    expect(new Set(events.map((event) => event.generationId)).size).toBe(1);
    expect(
      events.every(
        (event) =>
          event.turnId === "test-turn" && event.toolCallId === "test-call",
      ),
    ).toBe(true);
    const logs = JSON.stringify(events);
    for (const secret of [
      "private-output-marker",
      "private-prompt-marker",
      "private-state-marker",
      "secret-key",
      "http://fixture",
    ]) {
      expect(logs).not.toContain(secret);
    }
  });
});

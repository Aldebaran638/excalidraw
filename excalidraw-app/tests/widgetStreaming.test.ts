import { describe, expect, it, vi } from "vitest";

import { EXAMPLES } from "../../packages/interactive-widgets/examples";
import { previewFromJSONPrefix } from "../../packages/interactive-widgets/streamPreview";
import { generateWidget } from "../server/agent/widgetGeneration";
import { validateDefinition } from "../../packages/interactive-widgets/schema";

import type { WidgetGenerationProgress } from "../../packages/interactive-widgets/streamPreview";

const definition = () => structuredClone(EXAMPLES.calculator);
const sse = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: finish }],
  })}\n\n`;
describe("streaming widget generation", () => {
  it("renders closed nodes before the document is finished, with safe placeholders and no actions or calculations", () => {
    const doc = definition();
    doc.root.children![0].text = '中文 \\ 路径 "引号" 🚀';
    const text = JSON.stringify(doc);
    let visibleBeforeEnd = false;
    for (let index = 0; index <= text.length; index++) {
      const preview = previewFromJSONPrefix(text.slice(0, index));
      if (!preview) {
        continue;
      }
      validateDefinition(preview.document.definition);
      expect(preview.document.definition.computations).toEqual({});
      expect(JSON.stringify(preview.document)).not.toContain('"action":');
      if (index < text.length && JSON.stringify(preview).includes("引号")) {
        visibleBeforeEnd = true;
      }
    }
    expect(visibleBeforeEnd).toBe(true);
    expect(
      previewFromJSONPrefix(
        '{"root":{"id":"root","type":"column","children":[{"id":"title","type":"title","text":"unfinished',
      ),
    ).toBeNull();
    expect(previewFromJSONPrefix('{"__proto__":{},"root":{}}')).toBeNull();
    expect(() => previewFromJSONPrefix("x".repeat(262145))).toThrow("过大");
  });
  it("streams a valid preview while the upstream is still open and only then accepts the complete original definition", async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
      },
    });
    const transport = vi.fn(async (_url, options) => {
      expect(JSON.parse(options!.body as string).stream).toBe(true);
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;
    const events: WidgetGenerationProgress[] = [];
    let finished = false;
    const result = generateWidget(
      { baseUrl: "http://fixture/v1", model: "fixture" },
      { prompt: "生成计算器" },
      new AbortController().signal,
      transport,
      {},
      (event) => events.push(event),
    ).then((value) => {
      finished = true;
      return value;
    });
    const text = JSON.stringify(definition());
    const cut = text.indexOf('"id":"inputs"');
    upstream.enqueue(new TextEncoder().encode(sse(text.slice(0, cut))));
    await vi.waitFor(() =>
      expect(events.some((event) => event.document)).toBe(true),
    );
    expect(finished).toBe(false);
    upstream.enqueue(
      new TextEncoder().encode(
        `${sse(text.slice(cut), "stop")}data: [DONE]\n\n`,
      ),
    );
    upstream.close();
    expect((await result).definition).toEqual(definition());
    expect(events.at(-1)?.phase).toBe("validating");
    expect(
      events.every(
        (event, index) => !index || event.sequence > events[index - 1].sequence,
      ),
    ).toBe(true);
  });
  it("starts a fresh repair preview and refuses a truncated stream", async () => {
    const events: WidgetGenerationProgress[] = [];
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(sse('{"bad":true}', "stop"), {
          headers: { "Content-Type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(sse(JSON.stringify(definition()), "stop"), {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    await generateWidget(
      { baseUrl: "http://fixture/v1", model: "fixture" },
      { prompt: "生成" },
      new AbortController().signal,
      transport,
      {},
      (event) => events.push(event),
    );
    const repair = events.find((event) => event.phase === "repairing");
    expect(repair?.attempt).toBe(2);
    expect(repair?.document).toBeUndefined();
    await expect(
      generateWidget(
        { baseUrl: "http://fixture/v1", model: "fixture" },
        { prompt: "生成" },
        new AbortController().signal,
        vi.fn(
          async () =>
            new Response(sse(JSON.stringify(definition())), {
              headers: { "Content-Type": "text/event-stream" },
            }),
        ) as typeof fetch,
        {},
        () => {},
      ),
    ).rejects.toThrow("提前结束");
  });
});

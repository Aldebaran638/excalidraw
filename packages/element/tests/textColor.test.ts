import { describe, expect, it } from "vitest";

import {
  applyTextColorRange,
  clearTextColorRanges,
  getTextColorRanges,
  getTextColorSegments,
  remapTextColorRanges,
} from "../src/textColor";

import type { ExcalidrawTextElement } from "../src/types";

const textElement = (customData?: Record<string, unknown>) =>
  ({
    text: "Hello world",
    customData,
  } as ExcalidrawTextElement);

describe("inline text colors", () => {
  it("applies a color to a UTF-16 selection and preserves adjacent ranges", () => {
    const element = applyTextColorRange(textElement(), 6, 11, "#ff0000");

    expect(getTextColorRanges(element)).toEqual([
      { start: 6, end: 11, color: "#ff0000" },
    ]);

    const updated = applyTextColorRange(element, 0, 5, "#00ff00");
    expect(getTextColorRanges(updated)).toEqual([
      { start: 0, end: 5, color: "#00ff00" },
      { start: 6, end: 11, color: "#ff0000" },
    ]);
  });

  it("splits an existing range when recoloring a substring", () => {
    const element = applyTextColorRange(textElement(), 0, 11, "#ff0000");
    const updated = applyTextColorRange(element, 2, 8, "#0000ff");

    expect(getTextColorRanges(updated)).toEqual([
      { start: 0, end: 2, color: "#ff0000" },
      { start: 2, end: 8, color: "#0000ff" },
      { start: 8, end: 11, color: "#ff0000" },
    ]);
  });

  it("clears inline data without touching other custom data", () => {
    const element = textElement({
      richText: [{ start: 0, end: 2, color: "#f00" }],
      source: "test",
    });
    const cleared = clearTextColorRanges(element);

    expect(cleared.customData).toEqual({ source: "test" });
  });

  it("keeps colors aligned when text is inserted", () => {
    const element = {
      ...textElement(),
      originalText: "Hello world",
      customData: { richText: [{ start: 6, end: 11, color: "#f00" }] },
    } as ExcalidrawTextElement;
    const customData = remapTextColorRanges(element, "Hello beautiful world");

    expect(customData?.richText).toEqual([
      { start: 16, end: 21, color: "#f00" },
    ]);
  });

  it("splits rendered lines using UTF-16 source offsets", () => {
    expect(
      getTextColorSegments(
        "Hello world",
        0,
        [
          { start: 0, end: 5, color: "#0f0" },
          { start: 6, end: 11, color: "#f00" },
        ],
        "#000",
      ),
    ).toEqual([
      { text: "Hello", color: "#0f0" },
      { text: " ", color: "#000" },
      { text: "world", color: "#f00" },
    ]);
  });
});

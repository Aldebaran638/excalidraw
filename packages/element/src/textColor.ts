import type { ExcalidrawTextElement } from "./types";

/** A UTF-16 range in a text element that should use a different color. */
export type TextColorRange = Readonly<{
  start: number;
  end: number;
  color: string;
}>;

export type TextColorSegment = Readonly<{
  text: string;
  color: string;
}>;

const RICH_TEXT_KEY = "richText";

const isTextColorRange = (value: unknown): value is TextColorRange => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const range = value as Partial<TextColorRange>;
  return (
    typeof range.start === "number" &&
    typeof range.end === "number" &&
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end > range.start &&
    typeof range.color === "string" &&
    range.color.length > 0
  );
};

/**
 * Reads the optional inline color data. Invalid or stale data is ignored so
 * that files created by an older/custom build remain safe to render.
 */
export const getTextColorRanges = (
  element: Pick<ExcalidrawTextElement, "customData" | "text"> &
    Partial<Pick<ExcalidrawTextElement, "originalText">>,
): readonly TextColorRange[] => {
  const ranges = element.customData?.[RICH_TEXT_KEY];
  if (!Array.isArray(ranges)) {
    return [];
  }

  const textLength = element.originalText?.length ?? element.text.length;
  return ranges
    .filter(isTextColorRange)
    .map((range) => ({
      start: Math.min(range.start, textLength),
      end: Math.min(range.end, textLength),
      color: range.color,
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
};

const normalizeRanges = (ranges: readonly TextColorRange[]) => {
  const normalized: TextColorRange[] = [];
  for (const range of [...ranges].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    const previous = normalized[normalized.length - 1];
    if (
      previous &&
      previous.end >= range.start &&
      previous.color === range.color
    ) {
      normalized[normalized.length - 1] = {
        ...previous,
        end: Math.max(previous.end, range.end),
      };
    } else {
      normalized.push(range);
    }
  }
  return normalized;
};

/** Splits a rendered line into contiguous color runs. */
export const getTextColorSegments = (
  text: string,
  textStart: number,
  ranges: readonly TextColorRange[],
  defaultColor: string,
): readonly TextColorSegment[] => {
  if (!text) {
    return [];
  }
  const boundaries = new Set<number>([0, text.length]);
  for (const range of ranges) {
    const start = Math.max(0, range.start - textStart);
    const end = Math.min(text.length, range.end - textStart);
    if (end > start) {
      boundaries.add(start);
      boundaries.add(end);
    }
  }

  const sortedBoundaries = [...boundaries].sort((a, b) => a - b);
  const segments: TextColorSegment[] = [];
  for (let index = 0; index < sortedBoundaries.length - 1; index++) {
    const start = sortedBoundaries[index];
    const end = sortedBoundaries[index + 1];
    const globalStart = textStart + start;
    const matchingRanges = ranges.filter(
      (range) => range.start <= globalStart && range.end > globalStart,
    );
    const color =
      matchingRanges[matchingRanges.length - 1]?.color || defaultColor;
    const previous = segments[segments.length - 1];
    if (previous?.color === color) {
      segments[segments.length - 1] = {
        ...previous,
        text: previous.text + text.slice(start, end),
      };
    } else {
      segments.push({ text: text.slice(start, end), color });
    }
  }
  return segments;
};

/**
 * Applies a color to a selected substring, preserving all unaffected ranges.
 * Selection offsets use the same UTF-16 convention as HTMLTextAreaElement.
 */
export const applyTextColorRange = (
  element: ExcalidrawTextElement,
  start: number,
  end: number,
  color: string,
): ExcalidrawTextElement => {
  const textLength = element.originalText?.length ?? element.text.length;
  const clampedStart = Math.max(0, Math.min(start, textLength));
  const selectionEnd = Math.max(clampedStart, Math.min(end, textLength));
  if (clampedStart === selectionEnd || !color) {
    return element;
  }

  const nextRanges: TextColorRange[] = [];
  for (const range of getTextColorRanges(element)) {
    if (range.end <= clampedStart || range.start >= selectionEnd) {
      nextRanges.push(range);
      continue;
    }
    if (range.start < clampedStart) {
      nextRanges.push({ ...range, end: clampedStart });
    }
    if (range.end > selectionEnd) {
      nextRanges.push({ ...range, start: selectionEnd });
    }
  }
  nextRanges.push({ start: clampedStart, end: selectionEnd, color });

  const ranges = normalizeRanges(nextRanges);
  return {
    ...element,
    customData: {
      ...(element.customData || {}),
      [RICH_TEXT_KEY]: ranges,
    },
  };
};

/** Keeps existing colors aligned when text is inserted or deleted in the editor. */
export const remapTextColorRanges = (
  element: ExcalidrawTextElement,
  nextOriginalText: string,
) => {
  const ranges = getTextColorRanges(element);
  if (!ranges.length) {
    return element.customData;
  }

  const previousText = element.originalText || element.text;
  let prefix = 0;
  while (
    prefix < previousText.length &&
    prefix < nextOriginalText.length &&
    previousText[prefix] === nextOriginalText[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < previousText.length - prefix &&
    suffix < nextOriginalText.length - prefix &&
    previousText[previousText.length - 1 - suffix] ===
      nextOriginalText[nextOriginalText.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldChangedEnd = previousText.length - suffix;
  const newChangedEnd = nextOriginalText.length - suffix;
  const delta = newChangedEnd - oldChangedEnd;
  const nextRanges: TextColorRange[] = [];

  for (const range of ranges) {
    if (range.end <= prefix) {
      nextRanges.push(range);
    } else if (range.start >= oldChangedEnd) {
      nextRanges.push({
        ...range,
        start: range.start + delta,
        end: range.end + delta,
      });
    } else {
      const start = range.start < prefix ? range.start : prefix;
      const end = range.end > oldChangedEnd ? range.end + delta : newChangedEnd;
      if (end > start) {
        nextRanges.push({ start, end, color: range.color });
      }
    }
  }

  const customData = { ...(element.customData || {}) };
  if (nextRanges.length) {
    customData[RICH_TEXT_KEY] = normalizeRanges(nextRanges);
  } else {
    delete customData[RICH_TEXT_KEY];
  }
  return Object.keys(customData).length ? customData : undefined;
};

/** Clears inline colors when the whole text element color is changed. */
export const clearTextColorRanges = (
  element: ExcalidrawTextElement,
): ExcalidrawTextElement => {
  if (!element.customData?.[RICH_TEXT_KEY]) {
    return element;
  }
  const customData = { ...element.customData };
  delete customData[RICH_TEXT_KEY];
  return {
    ...element,
    customData: Object.keys(customData).length ? customData : undefined,
  };
};

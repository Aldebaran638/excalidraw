import {
  createMatrixElements,
  isLineElement,
  parseMatrixInput,
} from "@excalidraw/element";

import { normalizeRepositoryNoteName } from "../data/repositoryNotes";

describe("repository matrix tool", () => {
  it("parses spaces, commas, new lines, and semicolons", () => {
    expect(parseMatrixInput("[1, 2; 3, 4]")).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseMatrixInput("a b\nc d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps characters and quoted strings as cell values", () => {
    expect(parseMatrixInput('"hello world", "x, y"\nα β')).toEqual([
      ["hello world", "x, y"],
      ["α", "β"],
    ]);
    expect(parseMatrixInput("'left \\'right'\tplain")).toEqual([
      ["left 'right", "plain"],
    ]);
  });

  it("rejects unterminated quotes and empty cells", () => {
    expect(() => parseMatrixInput('"hello world')).toThrow(
      "Close every quoted matrix cell",
    );
    expect(() => parseMatrixInput("a,,b")).toThrow(
      "Matrix cells cannot be empty",
    );
  });

  it("rejects rows with different column counts", () => {
    expect(() => parseMatrixInput("1 2\n3")).toThrow(
      "Every matrix row must have the same number of values",
    );
  });

  it("creates grouped matrix cells and brackets", () => {
    const elements = createMatrixElements(
      [
        ["1", "2"],
        ["3", "4"],
      ],
      { x: 200, y: 100 },
    );

    expect(elements).toHaveLength(6);
    expect(new Set(elements.flatMap((element) => element.groupIds)).size).toBe(
      1,
    );
    expect(elements.filter((element) => element.type === "text")).toHaveLength(
      4,
    );
    const brackets = elements.filter(isLineElement);
    expect(brackets).toHaveLength(2);
    expect(brackets.every((bracket) => bracket.width > 10)).toBe(true);
    expect(brackets.every((bracket) => bracket.height > 0)).toBe(true);
    expect(
      brackets.every(
        (bracket) => bracket.points[0][0] === 0 && bracket.points[0][1] === 0,
      ),
    ).toBe(true);
  });

  it("normalizes repository note file names", () => {
    expect(normalizeRepositoryNoteName(" algebra ")).toBe("algebra.excalidraw");
    expect(normalizeRepositoryNoteName("algebra.excalidraw")).toBe(
      "algebra.excalidraw",
    );
  });
});

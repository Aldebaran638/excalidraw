import { FONT_FAMILY, randomId } from "@excalidraw/common";
import { pointFrom } from "@excalidraw/math";

import { convertToExcalidrawElements } from "./transform";

import type { ExcalidrawElementSkeleton } from "./transform";

const MAX_MATRIX_ROWS = 20;
const MAX_MATRIX_COLUMNS = 20;
const MAX_CELL_LENGTH = 40;
const ROW_HEIGHT = 42;
const MIN_COLUMN_WIDTH = 56;
const MAX_COLUMN_WIDTH = 560;
const BRACKET_WIDTH = 18;
const MATRIX_PADDING = 14;

const splitMatrixRows = (input: string) => {
  const rows: string[] = [];
  let row = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const character of input) {
    if (quote) {
      row += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      row += character;
    } else if (character === ";" || character === "\n" || character === "\r") {
      if (row.trim()) {
        rows.push(row);
      }
      row = "";
    } else {
      row += character;
    }
  }
  if (row.trim()) {
    rows.push(row);
  }
  return rows;
};

const stripRowBrackets = (row: string) => {
  const trimmed = row.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
};

/** Splits a row while preserving quoted string cells. */
const parseMatrixRow = (row: string) => {
  const cells: string[] = [];
  let cell = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let wasQuoted = false;
  let lastWasComma = false;
  const pushCell = (strict = false) => {
    const value = wasQuoted ? cell : cell.trim();
    if (!value) {
      if (strict || cell.length > 0 || wasQuoted) {
        throw new Error("Matrix cells cannot be empty");
      }
      return;
    }
    cells.push(value);
    cell = "";
    wasQuoted = false;
    lastWasComma = false;
  };
  for (const character of stripRowBrackets(row)) {
    if (quote) {
      if (escaped) {
        cell += character;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
        wasQuoted = true;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      lastWasComma = false;
      continue;
    }
    if (character === ",") {
      pushCell(true);
      lastWasComma = true;
      continue;
    }
    if (/\s/.test(character)) {
      pushCell();
      continue;
    }
    cell += character;
    lastWasComma = false;
  }
  if (quote) {
    throw new Error("Close every quoted matrix cell");
  }
  if (lastWasComma) {
    throw new Error("Matrix cells cannot be empty");
  }
  pushCell();
  return cells;
};

export const parseMatrixInput = (input: string): string[][] => {
  let normalized = input.trim();
  if (!normalized) {
    throw new Error("Enter at least one matrix value");
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1).trim();
  }
  const rows = splitMatrixRows(normalized).map(parseMatrixRow);
  if (!rows.length || !rows[0]?.length) {
    throw new Error("Enter at least one matrix value");
  }
  if (rows.length > MAX_MATRIX_ROWS) {
    throw new Error(`A matrix can have at most ${MAX_MATRIX_ROWS} rows`);
  }
  const columnCount = rows[0].length;
  if (columnCount > MAX_MATRIX_COLUMNS) {
    throw new Error(`A matrix can have at most ${MAX_MATRIX_COLUMNS} columns`);
  }
  if (rows.some((matrixRow) => matrixRow.length !== columnCount)) {
    throw new Error("Every matrix row must have the same number of values");
  }
  if (
    rows.some((matrixRow) =>
      matrixRow.some((cell) => cell.length > MAX_CELL_LENGTH),
    )
  ) {
    throw new Error(
      `Each matrix value can contain at most ${MAX_CELL_LENGTH} characters`,
    );
  }
  return rows;
};

/** Creates a resizable matrix from native line and text elements. */
export const createMatrixElements = (
  matrix: readonly (readonly string[])[],
  center: { x: number; y: number },
) => {
  const groupId = randomId();
  const columnWidths = matrix[0].map((_, columnIndex) => {
    const maxCharacters = Math.max(
      ...matrix.map((row) => Array.from(row[columnIndex]).length),
    );
    return Math.min(
      MAX_COLUMN_WIDTH,
      Math.max(MIN_COLUMN_WIDTH, maxCharacters * 13 + 24),
    );
  });
  const contentWidth = columnWidths.reduce((total, width) => total + width, 0);
  const contentHeight = matrix.length * ROW_HEIGHT;
  const totalWidth = contentWidth + (BRACKET_WIDTH + MATRIX_PADDING) * 2;
  const originX = center.x - totalWidth / 2;
  const originY = center.y - contentHeight / 2;
  const leftBracketX = originX + BRACKET_WIDTH;
  const contentX = leftBracketX + MATRIX_PADDING;
  const rightBracketX = contentX + contentWidth + MATRIX_PADDING;
  const skeletons: ExcalidrawElementSkeleton[] = [
    {
      type: "line",
      x: leftBracketX,
      y: originY,
      width: BRACKET_WIDTH,
      height: contentHeight,
      points: [
        pointFrom(0, 0),
        pointFrom(-BRACKET_WIDTH, 0),
        pointFrom(-BRACKET_WIDTH, contentHeight),
        pointFrom(0, contentHeight),
      ],
      groupIds: [groupId],
      roughness: 0,
      strokeWidth: 2,
    },
    {
      type: "line",
      x: rightBracketX,
      y: originY,
      width: BRACKET_WIDTH,
      height: contentHeight,
      points: [
        pointFrom(0, 0),
        pointFrom(BRACKET_WIDTH, 0),
        pointFrom(BRACKET_WIDTH, contentHeight),
        pointFrom(0, contentHeight),
      ],
      groupIds: [groupId],
      roughness: 0,
      strokeWidth: 2,
    },
  ];
  matrix.forEach((row, rowIndex) => {
    let cellX = contentX;
    row.forEach((cell, columnIndex) => {
      skeletons.push({
        type: "text",
        text: cell,
        x: cellX + columnWidths[columnIndex] / 2,
        y: originY + rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2,
        fontFamily: FONT_FAMILY.Cascadia,
        fontSize: 20,
        textAlign: "center",
        verticalAlign: "middle",
        groupIds: [groupId],
      });
      cellX += columnWidths[columnIndex];
    });
  });
  return convertToExcalidrawElements(skeletons, { regenerateIds: true });
};

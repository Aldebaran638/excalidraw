import { useMemo, useRef, useState } from "react";

import { parseMatrixInput } from "@excalidraw/element";

import { t } from "../i18n";

import { Dialog } from "./Dialog";
import { FilledButton } from "./FilledButton";
import { abacusIcon } from "./icons";

import "./MatrixDialog.scss";

const DEFAULT_MATRIX = "1  0  0\n0  1  0\n0  0  1";

const MATRIX_EXAMPLES = [
  { label: "numbers", value: DEFAULT_MATRIX },
  { label: "characters", value: "a b c\nd e f" },
  {
    label: "strings",
    value: '"hello world", "x, y"\n"matrix", "tool"',
  },
] as const;

export const MatrixDialog = (props: {
  onClose: () => void;
  onInsert: (matrix: string[][]) => void;
}) => {
  const [input, setInput] = useState(DEFAULT_MATRIX);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const parsedInput = useMemo(() => {
    try {
      return { matrix: parseMatrixInput(input), error: null };
    } catch (err) {
      return {
        matrix: null,
        error:
          err instanceof Error ? err.message : t("matrixDialog.parseError"),
      };
    }
  }, [input]);
  const preview = parsedInput.matrix;

  const insert = () => {
    try {
      props.onInsert(parseMatrixInput(input));
      props.onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("matrixDialog.parseError"),
      );
      inputRef.current?.focus();
    }
  };

  return (
    <Dialog
      className="MatrixDialog"
      title={t("matrixDialog.title")}
      onCloseRequest={props.onClose}
      size="small"
    >
      <div className="MatrixDialog__content">
        <label className="MatrixDialog__label" htmlFor="matrix-input">
          {t("matrixDialog.values")}
        </label>
        <div
          className="MatrixDialog__examples"
          aria-label={t("matrixDialog.quickFill")}
        >
          <span className="MatrixDialog__examplesLabel">
            {t("matrixDialog.quickFill")}
          </span>
          {MATRIX_EXAMPLES.map((example) => (
            <button
              key={example.label}
              type="button"
              className="MatrixDialog__example"
              onClick={() => {
                setInput(example.value);
                setError(null);
                inputRef.current?.focus();
              }}
            >
              {t(`matrixDialog.examples.${example.label}`)}
            </button>
          ))}
        </div>
        <textarea
          ref={inputRef}
          id="matrix-input"
          className="MatrixDialog__input"
          aria-describedby="matrix-input-hint matrix-input-status"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab" && !event.shiftKey) {
              event.preventDefault();
              const textarea = event.currentTarget;
              textarea.setRangeText(
                "\t",
                textarea.selectionStart,
                textarea.selectionEnd,
                "end",
              );
              setInput(textarea.value);
              setError(null);
              return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              insert();
            }
          }}
          rows={6}
          autoFocus
          spellCheck={false}
          placeholder={'"hello world", "x, y"\n"matrix", "tool"'}
        />
        <p className="MatrixDialog__hint" id="matrix-input-hint">
          {t("matrixDialog.hint")}
        </p>
        <p
          className={`MatrixDialog__status${
            preview ? "" : " MatrixDialog__status--error"
          }`}
          id="matrix-input-status"
          role="status"
          aria-live="polite"
        >
          {preview
            ? t("matrixDialog.dimensions", {
                rows: preview.length,
                columns: preview[0].length,
              })
            : input.trim()
            ? parsedInput.error
            : t("matrixDialog.empty")}
        </p>
        {preview && (
          <div
            className="MatrixDialog__preview"
            aria-label={t("matrixDialog.preview")}
          >
            <span className="MatrixDialog__bracket">[</span>
            <span
              className="MatrixDialog__previewGrid"
              style={{
                gridTemplateColumns: `repeat(${preview[0].length}, 1fr)`,
              }}
            >
              {preview.flatMap((row, rowIndex) =>
                row.map((cell, columnIndex) => (
                  <code key={`${rowIndex}-${columnIndex}`}>{cell}</code>
                )),
              )}
            </span>
            <span className="MatrixDialog__bracket">]</span>
          </div>
        )}
        {error && (
          <p className="MatrixDialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="MatrixDialog__actions">
          <FilledButton
            label={t("buttons.cancel")}
            variant="outlined"
            color="muted"
            onClick={props.onClose}
          />
          <FilledButton
            label={t("matrixDialog.insert")}
            icon={abacusIcon}
            onClick={insert}
            disabled={!input.trim() || !preview}
          />
        </div>
      </div>
    </Dialog>
  );
};

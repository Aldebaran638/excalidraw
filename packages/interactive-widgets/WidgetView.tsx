import { useEffect, useRef, useState } from "react";

import { renderFormula } from "./formula";
import computeWorkerUrl from "./compute.worker?worker&url";

import { ICONS, isContainer } from "./catalog";
import { applyAction } from "./compute";
import { chartPoints, formatValue, nodeText } from "./layout";

import "./widgets.scss";

import type { ReactNode } from "react";
import type { layoutWidget } from "./layout";
import type { ResolvedNode, Value, WidgetDocument, WidgetState } from "./types";

type Layout = ReturnType<typeof layoutWidget>;
export const WidgetView = ({
  document: doc,
  width,
  onCommit,
  onDraft,
  onExit,
  onLayout,
  onScroll,
  registerDraft,
  initialScroll = 0,
}: {
  document: WidgetDocument;
  width: number;
  onCommit: (state: WidgetState) => void;
  onDraft?: (dirty: boolean) => void;
  onExit?: () => void;
  onLayout?: (height: number) => void;
  onScroll?: (scroll: number) => void;
  initialScroll?: number;
  registerDraft?: (flush: () => void) => () => void;
}) => {
  const root = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(doc.state);
  const draftRef = useRef(draft);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [error, setError] = useState("");
  const [play, setPlay] = useState<string | null>(null);
  const callbacks = useRef({ onCommit, onLayout, onDraft, registerDraft });
  callbacks.current = { onCommit, onLayout, onDraft, registerDraft };
  const startScroll = useRef(initialScroll);
  const [measuredWidth, setMeasuredWidth] = useState(width);
  useEffect(() => {
    const node = root.current;
    const ownerWindow = node?.ownerDocument.defaultView as
      | (Window & typeof globalThis)
      | null;
    if (!node || !ownerWindow) {
      return;
    }
    const measure = () => {
      if (node.clientWidth > 0) {
        setMeasuredWidth(Math.min(width, node.clientWidth));
      }
    };
    const observer = new ownerWindow.ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [width]);
  const persist = (state = draftRef.current) => {
    setDraft(state);
    draftRef.current = state;
    onDraft?.(false);
    onCommit(state);
  };
  useEffect(() => {
    setDraft(doc.state);
    draftRef.current = doc.state;
  }, [doc.state, doc.definition]);
  useEffect(() => {
    const ownerWindow = root.current?.ownerDocument.defaultView as
      | (Window & typeof globalThis)
      | null;
    if (!ownerWindow) {
      return;
    }
    let worker: Worker | null = null;
    let timeout: number | undefined;
    const start = ownerWindow.setTimeout(() => {
      worker = new ownerWindow.Worker(computeWorkerUrl, { type: "module" });
      worker.onmessage = (event) => {
        if (event.data.ready) {
          worker?.postMessage({
            definition: doc.definition,
            state: draft,
            width: measuredWidth,
            requestId: 1,
          });
          timeout = ownerWindow.setTimeout(() => {
            worker?.terminate();
            setError("计算超时，请简化组件或重置输入");
          }, 1000);
          return;
        }
        ownerWindow.clearTimeout(timeout);
        if (event.data.error) {
          setError(event.data.error);
        } else {
          setError("");
          setLayout(event.data.layout);
          callbacks.current.onLayout?.(event.data.layout.height);
        }
      };
      worker.onerror = () => {
        ownerWindow.clearTimeout(timeout);
        setError("组件计算失败");
      };
    }, 16);
    return () => {
      ownerWindow.clearTimeout(start);
      ownerWindow.clearTimeout(timeout);
      worker?.terminate();
    };
  }, [doc.definition, draft, measuredWidth]);
  useEffect(() => {
    if (!play) {
      return;
    }
    const ownerWindow = root.current?.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }
    const interval = ownerWindow.setInterval(() => {
      const next = {
        ...draftRef.current,
        [play]: (Number(draftRef.current[play]) + 1) % 100,
      };
      draftRef.current = next;
      setDraft(next);
    }, 500);
    return () => ownerWindow.clearInterval(interval);
  }, [play]);
  useEffect(() => {
    if (root.current) {
      root.current.scrollTop = startScroll.current;
    }
  }, []);
  useEffect(
    () => () => {
      callbacks.current.onDraft?.(false);
    },
    [],
  );
  useEffect(
    () =>
      callbacks.current.registerDraft?.(() =>
        callbacks.current.onCommit(draftRef.current),
      ),
    [],
  );
  const change = (key: string, value: Value, immediate = false) => {
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next;
    setDraft(next);
    onDraft?.(true);
    if (immediate) {
      persist(next);
    }
  };
  const act = (node: ResolvedNode) => {
    if (!node.action || node.resolved.disabled) {
      return;
    }
    try {
      persist(
        applyAction(doc.definition, draftRef.current, node.action, node.locals),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const content = (node: ResolvedNode, bw: number, bh: number) => {
    const bound = node.bind ? draft[node.bind] : undefined;
    const value = node.value ?? bound;
    const disabled = Boolean(node.resolved.disabled);
    if (node.error) {
      return <span role="alert">{node.error}</span>;
    }
    if (isContainer(node.type)) {
      return formatValue(node.resolved.text ?? node.text ?? node.label ?? "");
    }
    if (node.type === "icon") {
      return <span aria-label={node.icon}>{ICONS[node.icon || "info"]}</span>;
    }
    if (node.type === "divider" || node.type === "spacer") {
      return null;
    }
    if (node.type === "button") {
      return (
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            act(node);
          }}
        >
          {node.label || nodeText(node) || "操作"}
        </button>
      );
    }
    if (node.type === "formula") {
      const html = renderFormula(
        nodeText(node),
        Math.max(1, bw - 8),
        Math.max(1, bh - 8),
      );
      return (
        <span
          aria-label={nodeText(node)}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    if (node.type === "number" || node.type === "input") {
      return (
        <label>
          {node.label}
          <input
            aria-label={node.label || node.bind}
            disabled={disabled}
            type={node.type === "number" ? "number" : "text"}
            value={String(bound ?? "")}
            min={node.min}
            max={node.max}
            step={node.step || "any"}
            onChange={(e) => {
              if (node.type === "number") {
                if (
                  e.target.value !== "" &&
                  Number.isFinite(Number(e.target.value))
                ) {
                  change(node.bind!, Number(e.target.value));
                }
              } else {
                change(node.bind!, e.target.value);
              }
            }}
            onBlur={() => persist()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                persist();
                e.currentTarget.blur();
              }
            }}
          />
        </label>
      );
    }
    if (node.type === "slider") {
      return (
        <label>
          {node.label}: {formatValue(bound)}
          <input
            aria-label={node.label || node.bind}
            disabled={disabled}
            type="range"
            min={node.min ?? 0}
            max={node.max ?? 100}
            step={node.step ?? 1}
            value={Number(bound)}
            onChange={(e) => change(node.bind!, Number(e.target.value))}
            onPointerUp={() => persist()}
            onKeyUp={() => persist()}
            onBlur={() => persist()}
          />
        </label>
      );
    }
    if (node.type === "select") {
      return (
        <label>
          {node.label}
          <select
            aria-label={node.label || node.bind}
            disabled={disabled}
            value={String(bound)}
            onChange={(e) => change(node.bind!, e.target.value, true)}
          >
            {node.options?.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      );
    }
    if (node.type === "toggle") {
      return (
        <label>
          <input
            aria-label={node.label || node.bind}
            type="checkbox"
            disabled={disabled}
            checked={Boolean(bound)}
            onChange={(e) => change(node.bind!, e.target.checked, true)}
          />
          {node.label}
        </label>
      );
    }
    if (node.type === "player") {
      return (
        <div>
          {node.label} · {Number(bound)}
          <div className="iw-controls">
            <button
              type="button"
              onClick={() => {
                if (play) {
                  setPlay(null);
                  persist();
                } else {
                  setPlay(node.bind!);
                }
              }}
            >
              {play === node.bind ? "暂停" : "播放"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPlay(null);
                change(node.bind!, Number(bound) + 1, true);
              }}
            >
              下一步
            </button>
            <button
              type="button"
              onClick={() => {
                setPlay(null);
                change(node.bind!, 0, true);
              }}
            >
              重置
            </button>
          </div>
        </div>
      );
    }
    if (["table", "matrix", "heatmap"].includes(node.type)) {
      const rows = Array.isArray(value) ? value.slice(0, 20) : [];
      return (
        <div className="iw-table">
          <span>{node.label}</span>
          <table>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {(Array.isArray(row) ? row : [row])
                    .slice(0, 20)
                    .map((v, j) => (
                      <td
                        key={j}
                        style={
                          node.type === "heatmap"
                            ? {
                                background: `rgba(90,90,200,${Math.max(
                                  0.05,
                                  Math.min(0.85, Math.abs(Number(v)) || 0),
                                )})`,
                              }
                            : undefined
                        }
                      >
                        {node.bind ? (
                          <input
                            aria-label={`${node.label || node.bind} ${i + 1},${
                              j + 1
                            }`}
                            value={formatValue(v)}
                            onChange={(e) => {
                              const copied = structuredClone(
                                draftRef.current[node.bind!] as Value[][],
                              );
                              const text = e.target.value;
                              copied[i][j] =
                                text.trim() !== "" &&
                                Number.isFinite(Number(text))
                                  ? Number(text)
                                  : text;
                              change(node.bind!, copied);
                            }}
                            onBlur={() => persist()}
                          />
                        ) : (
                          formatValue(v)
                        )}
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    if (node.type === "chart" || node.type === "geometry") {
      const points = chartPoints(value, bw, bh - 28);
      return (
        <div>
          {node.label}
          <svg
            width="100%"
            height={Math.max(50, bh - 28)}
            viewBox={`0 0 ${bw} ${bh - 28}`}
            role="img"
            aria-label={node.label || "图表"}
          >
            <path
              d={`M24 0V${bh - 52}H${bw - 12}`}
              fill="none"
              stroke="currentColor"
              opacity=".35"
            />
            {node.chartType === "bar" ? (
              points.map(([x, y], i) => (
                <rect
                  key={i}
                  x={x - 4}
                  y={y}
                  width={8}
                  height={Math.max(0, bh - 52 - y)}
                  fill="currentColor"
                />
              ))
            ) : node.chartType === "scatter" ? (
              points.map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r={3} fill="currentColor" />
              ))
            ) : (
              <polyline
                points={points.map((p) => p.join(",")).join(" ")}
                stroke="currentColor"
                fill={
                  node.type === "geometry" ? "rgba(99,102,241,.12)" : "none"
                }
                strokeWidth={2}
              />
            )}
          </svg>
        </div>
      );
    }
    return (
      <div>
        {node.label && (
          <strong>
            {node.label}
            <br />
          </strong>
        )}
        {nodeText(node)}
      </div>
    );
  };
  return (
    <div
      ref={root}
      className="iw-view"
      data-widget-interactive="true"
      onScroll={(e) => onScroll?.(e.currentTarget.scrollTop)}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          if (play) {
            persist();
          }
          setPlay(null);
          onExit?.();
          root.current?.closest<HTMLElement>(".excalidraw")?.focus();
        }
      }}
    >
      {error ? (
        <div className="iw-error" role="alert">
          {error}
          <button
            onClick={() => {
              setPlay(null);
              persist(structuredClone(doc.definition.initialState));
            }}
          >
            重置输入
          </button>
        </div>
      ) : null}
      {!layout && !error ? (
        <div className="iw-loading">正在准备组件…</div>
      ) : null}
      {layout && (
        <div
          style={{
            position: "relative",
            width: layout.width,
            height: layout.height,
          }}
        >
          {(() => {
            const renderBox = (
              { node, x, y, width: bw, height: bh }: Layout["boxes"][number],
              parentX = 0,
              parentY = 0,
            ): ReactNode => {
              const clickable = node.type === "pressable";
              const style = node.style || {};
              const background = String(
                node.resolved.background ||
                  style.background ||
                  (["card", "pressable"].includes(node.type)
                    ? "var(--iw-card)"
                    : "transparent"),
              );
              return (
                <div
                  key={node.instanceId}
                  className={`iw-node iw-${node.type}`}
                  style={{
                    left: x - parentX,
                    top: y - parentY,
                    width: bw,
                    height: bh,
                    padding: isContainer(node.type) ? style.padding ?? 12 : 4,
                    background,
                    color: String(
                      node.resolved.color || style.color || "inherit",
                    ),
                    borderColor: String(
                      node.resolved.borderColor ||
                        style.borderColor ||
                        (node.resolved.selected
                          ? "#6366f1"
                          : "var(--iw-border)"),
                    ),
                    borderRadius: style.radius ?? 10,
                    fontSize:
                      style.fontSize ??
                      (node.type === "title"
                        ? 22
                        : node.type === "caption"
                        ? 12
                        : 14),
                    fontWeight:
                      style.weight === "bold"
                        ? 700
                        : style.weight === "medium"
                        ? 500
                        : undefined,
                    textAlign:
                      style.align === "center"
                        ? "center"
                        : style.align === "end"
                        ? "right"
                        : undefined,
                  }}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={
                    clickable ? node.label || node.text || node.id : undefined
                  }
                  aria-pressed={
                    clickable ? Boolean(node.resolved.selected) : undefined
                  }
                  onClick={
                    clickable
                      ? (e) => {
                          e.stopPropagation();
                          act(node);
                        }
                      : undefined
                  }
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            act(node);
                          }
                        }
                      : undefined
                  }
                >
                  {content(node, bw, bh)}
                  {node.children.map((child) => {
                    const box = layout.boxes.find(
                      (b) => b.node.instanceId === child.instanceId,
                    );
                    return box ? renderBox(box, x, y) : null;
                  })}
                </div>
              );
            };
            return layout.boxes[0] ? renderBox(layout.boxes[0]) : null;
          })()}
        </div>
      )}
    </div>
  );
};

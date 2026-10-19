import { useCallback, useEffect, useId, useRef, useState } from "react";

import { renderFormula } from "./formula";
import computeWorkerUrl from "./compute.worker?worker&url";

import { ICONS, isContainer } from "./catalog";
import { applyAction } from "./compute";
import {
  chartPoints,
  formatValue,
  nodeText,
  segmentedGeometry,
} from "./layout";
import { iconSvg } from "./icons";
import { layoutKey, rememberLayout } from "./layoutCache";

import "./widgets.scss";

import type { WidgetRuntimeState } from "./runtimeState";
import type { ReactNode } from "react";
import type { layoutWidget } from "./layout";
import type { LayoutBox } from "./types";
import type {
  ResolvedNode,
  Value,
  WidgetDocument,
  WidgetState,
  WidgetScrollState,
} from "./types";

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
  runtime,
}: {
  document: WidgetDocument;
  width: number;
  onCommit: (state: WidgetState) => void;
  onDraft?: (dirty: boolean) => void;
  onExit?: () => void;
  onLayout?: (height: number) => void;
  onScroll?: (scroll: number, regions: WidgetScrollState) => void;
  initialScroll?: number;
  runtime?: WidgetRuntimeState;
  registerDraft?: (flush: () => void) => () => void;
}) => {
  const root = useRef<HTMLDivElement>(null);
  const markerId = `iw-arrow-${useId().replace(/:/g, "")}`;
  const [workerGeneration, setWorkerGeneration] = useState(0);
  const [draft, setLocalDraft] = useState(runtime?.state || doc.state);
  const setDraft = useCallback(
    (state: WidgetState) => {
      setLocalDraft(state);
      runtime?.set(state);
    },
    [runtime],
  );
  const draftRef = useRef(draft);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [layoutDefinition, setLayoutDefinition] = useState(doc.definition);
  const [error, setError] = useState("");
  const [play, setPlay] = useState<string | null>(null);
  const callbacks = useRef({ onCommit, onLayout, onDraft, registerDraft });
  callbacks.current = { onCommit, onLayout, onDraft, registerDraft };
  const startScroll = useRef(initialScroll);
  const [measuredWidth, setMeasuredWidth] = useState(width);
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const latestJob = useRef({
    definition: doc.definition,
    state: draft,
    width: measuredWidth,
  });
  latestJob.current = {
    definition: doc.definition,
    state: draft,
    width: measuredWidth,
  };
  const postJob = useRef<(() => void) | null>(null);
  useEffect(
    () =>
      runtime?.subscribe((state) => {
        draftRef.current = state;
        setLocalDraft(state);
      }),
    [runtime],
  );
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
    // A second surface must join the existing draft, not reset it on mount.
    runtime?.acceptDocument(doc.state);
    const state = runtime?.state || doc.state;
    setLocalDraft(state);
    draftRef.current = state;
  }, [doc.state, doc.definition, runtime]);
  useEffect(() => {
    const ownerWindow = root.current?.ownerDocument.defaultView as
      | (Window & typeof globalThis)
      | null;
    if (!ownerWindow) {
      return;
    }
    let worker: Worker | null = null;
    let timeout: number | undefined;
    let ready = false;
    let busy = false;
    let dirty = true;
    let sentKey = "";
    let sentDefinition = latestJob.current.definition;
    const send = () => {
      dirty = true;
      if (!ready || busy || !worker) {
        return;
      }
      dirty = false;
      busy = true;
      sentKey = layoutKey(
        latestJob.current.definition,
        latestJob.current.state,
        latestJob.current.width,
      );
      sentDefinition = latestJob.current.definition;
      worker.postMessage({
        ...latestJob.current,
        requestId: ++requestRef.current,
      });
      timeout = ownerWindow.setTimeout(() => {
        worker?.terminate();
        ready = false;
        busy = false;
        setError("计算超时，请简化组件或重置输入");
      }, 1000);
    };
    postJob.current = send;
    const start = ownerWindow.setTimeout(() => {
      worker = new ownerWindow.Worker(computeWorkerUrl, { type: "module" });
      workerRef.current = worker;
      worker.onmessage = (event) => {
        if (event.data.ready) {
          ownerWindow.clearTimeout(timeout);
          ready = true;
          send();
          return;
        }
        ownerWindow.clearTimeout(timeout);
        busy = false;
        if (event.data.layout) {
          rememberLayout(sentKey, event.data.layout);
        }
        if (dirty) {
          send();
          return;
        }
        if (event.data.error) {
          setError(event.data.error);
        } else {
          setError("");
          setLayout(event.data.layout);
          setLayoutDefinition(sentDefinition);
          callbacks.current.onLayout?.(
            event.data.layout.height + (doc.version === 2 ? 28 : 0),
          );
        }
      };
      worker.onerror = () => {
        ownerWindow.clearTimeout(timeout);
        setError("组件计算失败");
      };
      timeout = ownerWindow.setTimeout(() => {
        worker?.terminate();
        setError("计算服务未能启动，请重新打开组件");
      }, 30000);
    }, 16);
    return () => {
      ownerWindow.clearTimeout(start);
      ownerWindow.clearTimeout(timeout);
      worker?.terminate();
      workerRef.current = null;
      postJob.current = null;
    };
  }, [workerGeneration, doc.version]);
  useEffect(() => {
    postJob.current?.();
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
  }, [play, setDraft]);
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
  const recordScroll = () => {
    const pane = root.current;
    if (!pane) {
      return;
    }
    const regions: WidgetScrollState = {};
    pane
      .querySelectorAll<HTMLElement>("[data-widget-scroll]")
      .forEach((node) => {
        regions[node.dataset.widgetScroll!] = {
          top: node.scrollTop,
          left: node.scrollLeft,
        };
      });
    onScroll?.(pane.scrollTop, regions);
  };
  const content = (
    node: ResolvedNode,
    bw: number,
    bh: number,
    lines?: string[],
    segments?: LayoutBox["segments"],
  ) => {
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
      return doc.version === 2 ? (
        <span
          aria-label={node.icon}
          dangerouslySetInnerHTML={{ __html: iconSvg(node.icon || "info") }}
        />
      ) : (
        <span aria-label={node.icon}>{ICONS[node.icon || "info"]}</span>
      );
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
    if (node.type === "textarea") {
      return (
        <label>
          {node.label}
          <textarea
            aria-label={node.label || node.bind}
            disabled={disabled}
            value={String(bound ?? "")}
            data-widget-scroll={node.instanceId}
            onScroll={recordScroll}
            onChange={(e) => change(node.bind!, e.target.value)}
            onBlur={() => persist()}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                (e.ctrlKey || e.metaKey) &&
                !e.nativeEvent.isComposing
              ) {
                persist();
                e.currentTarget.blur();
              }
            }}
          />
        </label>
      );
    }
    if (node.type === "segmented") {
      const options = node.options!;
      const geometry = segmentedGeometry(bw, options.length);
      return (
        <div
          role="radiogroup"
          aria-label={node.label || node.bind}
          aria-disabled={disabled}
        >
          <div className="iw-segmented-label">{node.label}</div>
          <div
            className="iw-segments"
            style={{
              gridTemplateColumns: `repeat(${geometry.columns}, minmax(0, 1fr))`,
            }}
          >
            {options.map((option, index) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={bound === option}
                disabled={disabled}
                title={option}
                tabIndex={bound === option ? 0 : -1}
                onClick={() => change(node.bind!, option, true)}
                onKeyDown={(e) => {
                  const delta = ["ArrowRight", "ArrowDown"].includes(e.key)
                    ? 1
                    : ["ArrowLeft", "ArrowUp"].includes(e.key)
                    ? -1
                    : 0;
                  if (delta || e.key === "Home" || e.key === "End") {
                    e.preventDefault();
                    e.stopPropagation();
                    const next =
                      e.key === "Home"
                        ? 0
                        : e.key === "End"
                        ? options.length - 1
                        : (index + delta + options.length) % options.length;
                    change(node.bind!, options[next], true);
                    (
                      e.currentTarget.parentElement?.children[
                        next
                      ] as HTMLButtonElement
                    )?.focus();
                  }
                }}
              >
                <span>
                  {segments?.[index]?.lines.map((line, i) => (
                    <span className="iw-segment-line" key={i}>
                      {line}
                    </span>
                  )) || option}
                </span>
              </button>
            ))}
          </div>
        </div>
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
        <div style={{ height: "100%" }}>
          <span style={{ display: "block", height: 24 }}>{node.label}</span>
          <div
            className="iw-table"
            data-widget-scroll={node.instanceId}
            onScroll={recordScroll}
            style={{ height: "calc(100% - 24px)" }}
          >
            <table
              style={{
                tableLayout: "fixed",
                width: Math.max(
                  bw - 8,
                  Math.max(
                    1,
                    ...rows.map((row) => (Array.isArray(row) ? row.length : 1)),
                  ) * (node.bind ? 80 : 55),
                ),
              }}
            >
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} style={{ height: 44 }}>
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
                              aria-label={`${node.label || node.bind} ${
                                i + 1
                              },${j + 1}`}
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
        {lines && !node.label
          ? lines.map((line, index) => (
              <div
                key={index}
                style={{
                  lineHeight: `${
                    (node.style?.fontSize ||
                      (node.type === "title"
                        ? 22
                        : node.type === "caption"
                        ? 12
                        : 14)) + 7
                  }px`,
                  whiteSpace: "pre",
                }}
              >
                {line || "\u00a0"}
              </div>
            ))
          : nodeText(node)}
      </div>
    );
  };
  return (
    <div
      ref={root}
      className="iw-view"
      data-widget-interactive="true"
      onScroll={recordScroll}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => {
        if (e.ctrlKey || e.metaKey) {
          return;
        }
        let node = e.target as HTMLElement | null;
        while (node && root.current?.contains(node)) {
          if (
            (node.scrollHeight > node.clientHeight &&
              ((e.deltaY > 0 &&
                node.scrollTop + node.clientHeight < node.scrollHeight) ||
                (e.deltaY < 0 && node.scrollTop > 0))) ||
            (node.scrollWidth > node.clientWidth && e.deltaX !== 0)
          ) {
            e.stopPropagation();
            return;
          }
          node = node.parentElement;
        }
      }}
      onKeyDown={(e) => {
        const input = (e.target as HTMLElement).closest(
          "input,textarea,select",
        );
        if (
          !input &&
          e.key === " " &&
          root.current?.closest('[data-embeddable-interaction="controls"]')
        ) {
          return;
        }
        if (
          !input &&
          (e.ctrlKey || e.metaKey) &&
          ["z", "y"].includes(e.key.toLowerCase())
        ) {
          return;
        }
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
      {doc.version === 2 && (
        <div className="iw-drag-handle" aria-label="拖动标题栏移动组件">
          ⠿ {doc.definition.title}
        </div>
      )}
      {error ? (
        <div className="iw-error" role="alert">
          {error}
          <button
            onClick={() => {
              setPlay(null);
              setWorkerGeneration((value) => value + 1);
              persist(structuredClone(doc.definition.initialState));
            }}
          >
            重置输入
          </button>
        </div>
      ) : null}
      {(!layout || layoutDefinition !== doc.definition) && !error ? (
        <div className="iw-loading">正在准备组件…</div>
      ) : null}
      {layout && layoutDefinition === doc.definition && (
        <div
          data-embeddable-control="true"
          style={{
            position: "relative",
            width: layout.width,
            height: layout.height,
          }}
        >
          <svg
            className="iw-relations"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
          >
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="context-stroke" />
              </marker>
            </defs>
            {layout.edges.map((edge) => (
              <g key={edge.id} className={edge.selected ? "is-selected" : ""}>
                <path
                  d={edge.path}
                  markerEnd={edge.directed ? `url(#${markerId})` : undefined}
                />
                <text x={edge.x} y={edge.y - 5} textAnchor="middle">
                  {edge.label}
                </text>
              </g>
            ))}
          </svg>
          {(() => {
            const renderBox = (
              {
                node,
                x,
                y,
                width: bw,
                height: bh,
                lines,
                segments,
              }: Layout["boxes"][number],
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
                  data-embeddable-control={
                    clickable ||
                    [
                      "number",
                      "input",
                      "textarea",
                      "slider",
                      "select",
                      "segmented",
                      "toggle",
                      "button",
                      "matrix",
                      "table",
                      "player",
                    ].includes(node.type)
                      ? "true"
                      : undefined
                  }
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
                            if (
                              e.key === " " &&
                              root.current?.closest(
                                '[data-embeddable-interaction="controls"]',
                              )
                            ) {
                              return;
                            }
                            e.preventDefault();
                            e.stopPropagation();
                            act(node);
                          }
                        }
                      : undefined
                  }
                >
                  {content(node, bw, bh, lines, segments)}
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

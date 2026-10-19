export type Value =
  | string
  | number
  | boolean
  | null
  | Value[]
  | { [key: string]: Value };
export type WidgetState = Record<string, Value>;
export type WidgetScrollState = Record<string, { top: number; left: number }>;
export type Expression =
  | { literal: Value }
  | { ref: string }
  | { op: string; args: Expression[] };
export type WidgetAction = {
  type: "set" | "toggle" | "reset" | "step" | "batch";
  target?: string;
  value?: Expression;
  actions?: WidgetAction[];
};
export type WidgetStyle = {
  background?: string;
  color?: string;
  borderColor?: string;
  padding?: number;
  gap?: number;
  radius?: number;
  fontSize?: number;
  align?: "start" | "center" | "end";
  weight?: "normal" | "medium" | "bold";
};
export type WidgetNode = {
  id: string;
  type: string;
  label?: string;
  text?: string;
  bind?: string;
  data?: Expression;
  children?: WidgetNode[];
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  chartType?: "line" | "scatter" | "bar";
  action?: WidgetAction;
  style?: WidgetStyle;
  columns?: number;
  icon?: string;
  bindings?: Partial<
    Record<
      | "text"
      | "visible"
      | "disabled"
      | "selected"
      | "background"
      | "color"
      | "borderColor",
      Expression
    >
  >;
  items?: Expression;
  itemKey?: string;
  direction?: "LR" | "TB";
  relations?: {
    id: string;
    from: string;
    to: string;
    label?: string;
    directed?: boolean;
  }[];
};
export type WidgetDefinition = {
  version: 1 | 2;
  title: string;
  root: WidgetNode;
  datasets?: Record<string, Value>;
  initialState: WidgetState;
  computations: Record<string, Expression>;
};
export type WidgetDocument = {
  version: 1 | 2;
  catalogVersion: 1 | 2;
  definition: WidgetDefinition;
  state: WidgetState;
  prompt: string;
};
export type ResolvedNode = Omit<WidgetNode, "children"> & {
  instanceId: string;
  locals: WidgetState;
  value?: Value;
  resolved: Record<string, Value>;
  error?: string;
  children: ResolvedNode[];
};
export type LayoutBox = {
  node: ResolvedNode;
  x: number;
  y: number;
  width: number;
  height: number;
  lines?: string[];
  segments?: { x: number; y: number; width: number; lines: string[] }[];
};
export const WIDGET_LINK_PREFIX = "https://widgets.excalidraw.local/";
export const LIMITS = {
  nodes: 300,
  expanded: 600,
  matrix: 20,
  points: 2000,
  operations: 50000,
};
export const INPUT_TYPES = [
  "number",
  "input",
  "textarea",
  "slider",
  "select",
  "segmented",
  "toggle",
  "player",
];

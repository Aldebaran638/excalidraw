import type {
  WidgetDefinition,
  WidgetDocument,
  WidgetState,
} from "../../packages/interactive-widgets/types";

export type ChatWidgetRef = {
  artifactId: string;
  version: number;
  title: string;
  targetElementId?: string;
};
export type ChatWidgetTarget = {
  elementId: string;
  baseDefinition: WidgetDefinition;
  baseDocument?: WidgetDocument;
};
export type ChatWorkspace =
  | { kind: "html"; artifactId: string; version: number }
  | { kind: "artifact"; artifactId: string; version: number }
  | { kind: "element"; elementId: string };
export type ChatWidgetVersion = {
  artifactId: string;
  noteId: string;
  sessionId: string;
  version: number;
  revision: number;
  parentVersion?: number;
  createdAt: number;
  turnId: string;
  toolCallId: string;
  document: WidgetDocument;
  region: { width: number; height: number };
  target?: ChatWidgetTarget;
  summary: string;
};
export type ChatWidgetData = ChatWidgetVersion & {
  versions: { version: number; title: string }[];
};
export type ChatWidgetSource = {
  noteId: string;
  sessionId: string;
  artifactId: string;
  version: number;
};
export type ChatWidgetHost = {
  elements: () => { id: string; title: string }[];
  read: (elementId: string) => WidgetDocument | null;
  placements: (source: ChatWidgetSource) => string[];
  place: (
    data: ChatWidgetVersion,
    document: WidgetDocument,
    isCurrent: () => boolean,
    onPlaced: (id: string | null) => void,
  ) => void;
  apply: (
    data: ChatWidgetVersion,
    document: WidgetDocument,
    trialInputs: boolean,
  ) => void;
};
export const widgetRef = (data: ChatWidgetVersion): ChatWidgetRef => ({
  artifactId: data.artifactId,
  version: data.version,
  title: data.document.definition.title,
  ...(data.target ? { targetElementId: data.target.elementId } : {}),
});
export const definitionKey = (definition: WidgetDefinition): string => {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [
              key,
              stable((value as Record<string, unknown>)[key]),
            ]),
        )
      : value;
  return JSON.stringify(stable(definition));
};
export const sameState = (a: WidgetState, b: WidgetState) =>
  JSON.stringify(a) === JSON.stringify(b);

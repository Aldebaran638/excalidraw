/** HTML is a chat artifact, not a canvas WidgetDocument. */
export type HtmlRef = { artifactId: string; version: number; kind: "html" };
export type HtmlState = {
  forms: Record<string, { type: string; value: string; checked?: boolean }>;
  custom: Record<string, unknown>;
};
export type HtmlArtifact = HtmlRef & {
  formatVersion?: 1;
  runtimeVersion?: number;
  noteId: string;
  sessionId: string;
  title: string;
  source: string;
  complete: boolean;
  revision: number;
  state: HtmlState;
  createdAt: number;
};
export const isHtmlState = (value: unknown): value is HtmlState => {
  try {
    if (!value || typeof value !== "object") {
      return false;
    }
    const state = value as HtmlState;
    if (
      !state.forms ||
      !state.custom ||
      Array.isArray(state.forms) ||
      Array.isArray(state.custom) ||
      typeof state.forms !== "object" ||
      typeof state.custom !== "object"
    ) {
      return false;
    }
    if (JSON.stringify(state).length > 65536) {
      return false;
    }
    return Object.entries(state.forms).every(
      ([id, field]) =>
        !["__proto__", "prototype", "constructor"].includes(id) &&
        field &&
        typeof field.type === "string" &&
        typeof field.value === "string" &&
        (field.checked === undefined || typeof field.checked === "boolean"),
    );
  } catch {
    return false;
  }
};
export type ChatBlock =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "tool"; activityId: string }
  | {
      id: string;
      type: "html";
      ref: HtmlRef;
      source?: string;
      complete: boolean;
      saved?: boolean;
      initialState?: HtmlState;
      runtimeVersion?: number;
    };

/** Markdown fence framing only. HTML tokenization belongs to the browser parser.
 * Keep ambiguous fence prefixes, but immediately emit ordinary text/code. */
export class HtmlFenceStream {
  private pending = "";
  private start = true;
  private mode: "text" | "html" | "code" = "text";
  private marker = "";
  private length = 0;
  constructor(
    private output: (
      kind: "text" | "html" | "open" | "close",
      text: string,
    ) => void,
  ) {}
  push(text: string) {
    this.pending += text;
    this.drain(false);
  }
  finish() {
    this.drain(true);
  }
  private drain(final: boolean) {
    while (this.pending) {
      const end = this.pending.indexOf("\n");
      if (this.start) {
        const line = end < 0 ? this.pending : this.pending.slice(0, end + 1);
        const trimmed = line.replace(/^ {0,3}/, "");
        const possible =
          /^ {0,3}$/.test(line) ||
          trimmed.startsWith("`") ||
          trimmed.startsWith("~");
        if (possible && end < 0 && !final) {
          return;
        }
        const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line);
        if (opening && this.mode === "text") {
          this.marker = opening[1][0];
          this.length = opening[1].length;
          this.mode =
            opening[2].trim().toLowerCase() === "html" ? "html" : "code";
          this.output(
            this.mode === "html" ? "open" : "text",
            this.mode === "html" ? "" : line,
          );
          this.pending = this.pending.slice(line.length);
          this.start = true;
          continue;
        }
        const closing =
          this.mode !== "text" &&
          line.trim().length >= this.length &&
          [...line.trim()].every((character) => character === this.marker);
        if (closing) {
          this.output(
            this.mode === "html" ? "close" : "text",
            this.mode === "html" ? "" : line,
          );
          this.mode = "text";
          this.pending = this.pending.slice(line.length);
          this.start = true;
          continue;
        }
      }
      const take = end < 0 ? this.pending.length : end + 1;
      this.output(
        this.mode === "html" ? "html" : "text",
        this.pending.slice(0, take),
      );
      this.pending = this.pending.slice(take);
      this.start = end >= 0;
    }
  }
}

export const HTML_GUIDE = `生成交互应用时直接输出一个 html 围栏代码块，不调用 create_widget_draft/revise_widget_draft。每个代码块是一份完整自包含 HTML，可含内联 CSS 与 JavaScript。不要输出组件树 JSON，不引用 CDN、外部图片或网络接口。不要自动拆分任务或追加生成；直接完成用户本轮要求。
默认适配约320px聊天宽度，使用响应式布局、可读字号和44px触控目标。宿主提供系统字体及 .card/.row/.col/.button/.muted 基础样式，语义颜色 --surface/--text/--muted/--accent/--border；也可以自行编写CSS。使用内联SVG图标，不加载远程资源。
HTML 按接收顺序逐步插入，script必须放在它依赖的DOM之后；完整脚本只执行一次。完成前不要依赖load/DOMContentLoaded。控件使用稳定id。持久状态使用 window.NoteApp.get(key,defaultValue) 和 NoteApp.set(key,jsonValue)，不得使用localStorage、父页面或网络；普通有id输入的值由宿主恢复。示例：<button id="count">增加</button><script>let n=NoteApp.get('count',0);const b=document.getElementById('count');function render(){b.textContent='次数 '+n}b.onclick=()=>{NoteApp.set('count',++n);render()};render();</script>。
用户选中HTML作品时，基于提供的源码和状态修改，返回完整新版HTML；没有明确目标则新建。不要宣称已运行或已保存，状态由宿主显示。`;

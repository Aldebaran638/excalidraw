/** HTML applications share the same source format in chat and on the canvas. */
import { validId } from "./noteIdentity";
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
  sourceHash?: string;
  parentVersion?: number;
  editBase?: HtmlRef;
  changes?: { before: string; after: string }[];
  recovery?: {
    base?:
      | { kind: "html"; artifactId: string; version: number }
      | { kind: "element"; elementId: string };
    baseHash?: string;
    error: string;
    code: string;
  };
  target?: {
    elementId: string;
    appId: string;
    version: number;
    sourceHash: string;
  };
};

export type CanvasHtmlApp = {
  pendingSource?: boolean;
  formatVersion: 1;
  appId: string;
  version: number;
  sourceHash: string;
  sourceSnapshot: string;
  runtimeVersion: number;
  title: string;
  state: HtmlState;
};

export const readCanvasHtmlApp = (value: unknown): CanvasHtmlApp | null => {
  const app = value as CanvasHtmlApp;
  return app &&
    app.formatVersion === 1 &&
    validId(app.appId) &&
    Number.isSafeInteger(app.version) &&
    app.version > 0 &&
    /^[a-f0-9]{64}$/.test(app.sourceHash) &&
    typeof app.sourceSnapshot === "string" &&
    app.sourceSnapshot.length <= 262144 &&
    typeof app.title === "string" &&
    app.title.length <= 100 &&
    Number.isSafeInteger(app.runtimeVersion) &&
    app.runtimeVersion > 0 &&
    isHtmlState(app.state)
    ? app
    : null;
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
      error?: string;
      draftSaved?: boolean;
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

export const HTML_GUIDE = `未引用现有应用且需要新建交互应用时，直接输出一个 html 围栏代码块，不调用 create_widget_draft/revise_widget_draft。已引用应用时须使用源码读取及局部编辑工具，不能用整份 HTML 代替修改。不要输出或虚构“HTML作品引用”，作品身份和卡片由宿主分配；成功与否以工具结果为准。每个代码块是一份完整自包含 HTML，可含内联 CSS 与 JavaScript。不要输出组件树 JSON，不引用 CDN、外部图片或网络接口。不要自动拆分任务或追加生成；直接完成用户本轮要求。
流式构建重要约定：尽早输出带稳定id的根容器、图标或标题，随后马上安装最小状态和事件委托；再输出其他布局、控件与细节。不要把全部JavaScript堆在最后导致已经出现的控件无法使用。同一次回答可在后续完整script中更新以前的节点；这不是多轮生成。
特别注意嵌套：事件委托只处理rootId容器内部控件。必须保持根容器打开，让后续控件仍嵌套其中；不能提前关闭根容器，然后把输入框/按钮生成为它的兄弟节点。正确的小例子：<div id="app"><h2 id="app-title">计数</h2><script>(()=>{NoteApp.on('increase','app','click','#increase',()=>{const n=NoteApp.get('count',0)+1;NoteApp.set('count',n);NoteApp.patch('total',{text:String(n)})})})()</script><output id="total">0</output><button id="increase">增加</button><script>(()=>{NoteApp.patch('total',{text:String(NoteApp.get('count',0))});NoteApp.patch('app-title',{text:'点击试试'});})()</script></div>。这是代码组织示例，不要求照用业务或布局。
运行时v2提供通用方法（不是固定组件库）：NoteApp.once(rootId,setup)只初始化一次，setup可返回清理函数；NoteApp.on(key,rootId,eventName,selector,handler)按key委托事件，handler(event,target)，重复key不叠加监听；NoteApp.interval(key,callback,ms)同key只保留一个定时器，NoteApp.clearInterval(key)清理。业务状态放在NoteApp.get/set，不存在时采用默认值，不要在后续script里强行恢复默认值。计时保存绝对截止时间deadline，tick只更新界面，不每秒保存剩余秒数。查询尚未收到的DOM须判空。
回改旧区域使用NoteApp.patch(targetId,{text,style,attrs,appendHtml,remove})，各字段可省略。例：NoteApp.patch('app-title',{text:'新的标题'});NoteApp.patch('app-root',{style:{'--accent':'#3b9a74',gap:'16px'}})。attrs只支持class/title/role/aria-*/data-*。不得覆盖input/textarea/select值、可编辑正文、用户焦点和初始化区域；不要通过原始DOM绕开保护。appendHtml只追加无script/事件属性的标记，逻辑在随后完整script中安装；remove:true须单独使用。所有脚本用IIFE独立作用域，避免重复声明。patch失败会保留用户操作，不要自动请求模型修复。
默认适配约320px聊天宽度，使用响应式布局、可读字号和44px触控目标。宿主提供系统字体及 .card/.row/.col/.button/.muted 基础样式，语义颜色 --surface/--text/--muted/--accent/--border；也可以自行编写CSS。使用内联SVG图标，不加载远程资源。
HTML 按接收顺序逐步插入，script必须放在它依赖的DOM之后；完整脚本只执行一次。完成前不要依赖load/DOMContentLoaded。控件使用稳定id。持久状态使用 window.NoteApp.get(key,defaultValue) 和 NoteApp.set(key,jsonValue)，不得使用localStorage、父页面或网络；普通有id输入的值由宿主恢复。示例：<button id="count">增加</button><script>let n=NoteApp.get('count',0);const b=document.getElementById('count');function render(){b.textContent='次数 '+n}b.onclick=()=>{NoteApp.set('count',++n);render()};render();</script>。
状态恢复必须：首次脚本也不得无条件NoteApp.set默认值，否则刷新会覆盖已保存状态。用const initial=NoteApp.get('state',{deadline:null,mode:'work'})读取，只有用户操作改变值时才set。get返回JSON副本，修改副本后必须set提交。输入有id时宿主恢复值，初始化时不得强制重设输入值。倒计时到期才提交步骤变化。
用户选中HTML作品时，先调用read_app_source读取带行号的源码，再用edit_app_source和当前sourceHash提交唯一匹配的局部替换；不要重新输出完整HTML覆盖目标。只有用户明确要求新建时才输出新作品。候选由用户确认，不要宣称已应用或已运行，保存和运行状态由宿主显示。`;

/** Shared by the iframe bootstrap and the model guide. Not parent CSS. */
export const HTML_ENVIRONMENT_VERSION = 1;
export const HTML_THEME_TOKENS = {
  "--surface": "light-dark(#fff,#232329)",
  "--text": "light-dark(#1b1b1f,#f0f0f3)",
  "--muted": "light-dark(#666,#bbb)",
  "--accent": "#6965db",
  "--border": "light-dark(#e6e6eb,#45454b)",
};
export const HTML_THEME_CSS = `:root{color-scheme:light dark;${Object.entries(
  HTML_THEME_TOKENS,
)
  .map(([key, value]) => `${key}:${value}`)
  .join(";")}}`;
export const HTML_ENVIRONMENT_GUIDE = `运行环境契约 v${HTML_ENVIRONMENT_VERSION}：应用在 sandbox=allow-scripts、无同源权限的独立 iframe 内运行；:root、html、body、* 不会跨 iframe 污染宿主页面。父页面 CSS 不会自动继承。
iframe 默认注入的语义变量仅为 ${Object.keys(HTML_THEME_TOKENS).join(
  ", ",
)}；默认系统字体、body padding 16px、表单 min-height 44px，以及 .card/.row/.col/.muted 基础样式。生成样式可以覆盖 iframe 内的默认样式。不要假定 --font-sans、--card-bg 或其他宿主变量存在；不要写 --accent:var(--accent) 等自引用，使用不同名字的局部变量。
NoteApp.get/set 保存自定义状态；普通表单按稳定 ID 和类型恢复。运行时 v2 支持 once、on、interval、clearInterval、patch，请遵循下文示例；once 的 setup 可以返回清理函数，页面卸载统一清理；不承诺恢复任意闭包或焦点。资源必须自包含，不依赖 CDN、外部字体、网络、父页面 DOM 或不存在的宿主 API。`;

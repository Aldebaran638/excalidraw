/** Application-only, version-pinned dependencies. Never loaded in the host UI. */
export const APP_LIBRARIES = {
  react: { version: "19.0.0", file: "react.js" },
  d3: { version: "7.9.0", file: "d3.js" },
  mermaid: { version: "11.12.2", file: "mermaid.js" },
} as const;
export type AppLibrary = keyof typeof APP_LIBRARIES;
export const isAppLibrary = (name: unknown): name is AppLibrary =>
  typeof name === "string" &&
  Object.prototype.hasOwnProperty.call(APP_LIBRARIES, name);

// Pinned CDN authoring syntax is mirrored locally at the identical version.
// React uses NoteApp.load rather than mixing older UMD React with React 19.
export const APP_CDN_SCRIPTS = [
  "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js",
  "https://cdn.jsdelivr.net/npm/mermaid@11.12.2/dist/mermaid.min.js",
] as const;
export const APP_LIBRARY_GUIDE = `可用库：await NoteApp.load('react') 返回 {React,ReactDOM}（React/ReactDOM 19.0.0，使用ReactDOM.createRoot与React.createElement；没有JSX转译器，不要直接写JSX）；await NoteApp.load('d3') 返回 D3 7.9.0；await NoteApp.load('mermaid') 返回 Mermaid 11.12.2。这些库由本地打包提供，推荐此方式，首次加载也不依赖网络。每个iframe每个库只安装一次，调用顺序受控。示例：<div id="app"></div><script>(async()=>{const {React,ReactDOM}=await NoteApp.load('react');ReactDOM.createRoot(document.getElementById('app')).render(React.createElement('h2',null,'你好'))})()</script>。
需要布局复杂的知识架构时可以用D3绘制SVG，或mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral'})后await mermaid.render('唯一ID',图定义)，把返回svg放入当前iframe，再用DOM事件处理节点解释；不要把用户输入当作代码。详细交互与自定义数据用HTML/SVG也可以，不强制用库。
也允许以下固定版本的CDN经典script地址：${APP_CDN_SCRIPTS.join(
  "；",
)}。宿主会按顺序从本地同版本镜像加载这些script，不依赖外网；不要用动态import或自行插入远程script绕开加载器。React使用NoteApp.load('react')。不能使用未列出的URL、latest、外部字体或任意网络接口。脚本放在应用代码之前，依赖未就绪须await。所有库只在隔离iframe执行；主页面React不是应用的React。`;

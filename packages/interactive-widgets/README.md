# Interactive widgets

组件定义、校验、计算、布局和渲染集中在本包；画布宿主仍然是一个原生 `embeddable`，内部不是另一套 Excalidraw 元素。Qwen 和笔记同步不属于本包。

## v2 文档与运行时

- `customData.aiWidget` 保存定义、持久交互状态和生成指令。读取兼容 v1；只有确认应用 AI 设计时才升级到 v2。
- `catalog.ts`、`schema.ts` 和模型提示共享目录。只支持声明式表达式和动作，不执行 HTML、JavaScript、DIL 或远程资源。
- `compute.worker.ts` 常驻处理计算和布局，合并连续变更并忽略过期结果；计算预算一秒，Worker 启动等待与计算超时分开。
- `runtimeState.ts` 让画布和 Dialog 共用一个临时状态源；持久提交仍由宿主进入原生历史和保存队列。
- `layout.ts` 使用 Dagre 的纯布局模块，处理嵌套分组和关系；图的环不等于计算依赖的环。Worker 用实际字体测量断行，`layoutCache.ts` 将同一布局交给 DOM 和可信静态 SVG。
- 本地 SVG 图标路径由 `icons.ts` 注册。SVG 不包含脚本或 `foreignObject`；表格、矩阵和正文滚动仅影响导出缓存，不写笔记。

## 宿主边界

`useAIWidgets` 负责创作会话、候选、区域和 AI 请求。新建草稿使用临时覆盖层，修改候选不修改场景；确认应用才进入一次原生历史。`widgetDrafts.ts` 使用宿主 Window 的 IndexedDB，防抖 500ms，保留七天、最多二十份。

核心 `embeddableControls.ts` 只处理通用控件命中、局部滚动和手势；不知道 Qwen、组件目录或 Kubernetes。普通网页嵌入仍使用原来的激活和校验行为。

“场景联动”离线示例展示分段选择、多行输入、条件显示和数据查询。`segmented` 支持 2–6 个短选项、方向键/Home/End，窄宽时换行；`textarea` 普通 Enter 换行、失焦或 Ctrl/Cmd+Enter 提交。分段几何与文字断行由共享布局提供给 DOM/SVG，输入不执行副作用。用户提供的 ChatGPT UI 清单仅作设计参考，不意味着这些平台组件已接入；DIL、任意 HTML/JS、地图与设备控制不在此运行时内。

## 验证

```sh
yarn test:typecheck
yarn vitest run packages/interactive-widgets/widgets.test.ts packages/excalidraw/tests/embeddableControls.test.tsx excalidraw-app/tests/services.test.ts --minWorkers=1 --maxWorkers=2
BROWSER_EXECUTABLE=/path/to/chromium APP_URL=http://127.0.0.1:3009 yarn test:widgets:browser
TEST_REAL_QWEN=true BROWSER_EXECUTABLE=/path/to/chromium APP_URL=http://127.0.0.1:3009 yarn test:widgets:browser
yarn build:production
```

浏览器验收只使用唯一命名的临时笔记。对独立生产笔记目录测试时设置 `TEST_NOTES_DIR`，让清理命中该目录；不会删除普通命名的用户笔记。开发环境在 WSL 挂载目录下需要轮询时可显式设置 `VITE_APP_USE_POLLING=true`。日常使用宜运行固定生产构建，避免开发热更新影响打开的画布。

Qwen 的 `/models` 可用不代表 `/chat/completions` 可用。生成失败保留原组件、指令和有效候选，不自动应用或切换上游；真实模型验收需独立检查聊天接口。

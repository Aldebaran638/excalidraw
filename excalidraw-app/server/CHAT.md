# 笔记聊天

聊天属于应用层，不在核心画布放入聊天业务。`repositoryMetadata.noteId` 是笔记的持久身份；会话及消息使用独立 ID，存于 `notes/.chats/<noteId>/`。打开旧笔记不补写元数据，首次创建聊天才通过原有串行保存队列建立身份。

一个笔记目录由一个服务实例写入；不要让开发、生产或多个副本同时写同一个 `.chats` 目录。验收使用独立目录和端口，不能覆盖日常使用的服务。生产 Compose 原有 `notes/` 挂载已经包含聊天目录。聊天可能包含私密内容，不自动提交或推送聊天记录。

`chatStore` 负责原子持久化及重启恢复，`chatTools` 仅查询发送时快照，`chat` 管理 Qwen 工具循环及 SSE。浏览器 `NoteChatController` 独立于侧栏生命周期，负责后台请求、输入草稿和会话隔离；流式更新只通知聊天界面，不写画布历史。服务端保存失败时保留浏览器文字并明确提示，旧文件响应不能覆盖暂存内容。

模型初始上下文只有问题、预算内历史、笔记名称及工具说明；不会附带完整笔记或图片二进制。工具仅能访问本轮当前画布快照，无任意路径、跨笔记、网络或修改能力。历史文件完整保留，但模型最多使用最近 20 轮，并受输入预算约束。

Qwen 地址、模型和可选密钥复用现有服务端环境变量。配置转发地址必须显式设置，不自动切换。上游错误会保留为消息状态，重试复用原用户消息，不自动重新发送。

输入区提供“思考已开启／已关闭”切换，按笔记在当前浏览器持久保存，对下一次发送或手动重试生效。服务端将布尔值传给 `chat_template_kwargs.enable_thinking`；缺省仍关闭。上游的 `reasoning_content` 使用独立 SSE 事件和消息字段保存，默认折叠展示，不混入正式回答、复制内容或后续历史提示。Markdown 表格通过安全 token 渲染，窄屏只在表格区域滚动，不执行原始 HTML。

相关检查：

```sh
corepack yarn test:typecheck
corepack yarn vitest run excalidraw-app/tests/chat.test.ts excalidraw-app/tests/noteChats.test.ts excalidraw-app/tests/services.test.ts excalidraw-app/tests/repositoryNotes.test.ts --minWorkers=1 --maxWorkers=2 --testTimeout=30000
APP_URL=http://127.0.0.1:3009 TEST_NOTES_DIR=/path/to/isolated-test-notes BROWSER_EXECUTABLE=/path/to/chromium corepack yarn test:chat:browser
```

浏览器验收会创建并删除唯一命名的测试笔记；会话留在独立测试目录，方便检查。必须先启动指向同一测试目录的服务。真实 Qwen 测试不等于模拟接口测试；模型暂时不可用时如实保留失败结果，不改用其他模型伪装通过。

预览统一使用 3009，日常服务保留 3001；启动和固定数据视觉验收见 [本地预览服务](../../dev-docs/local-preview.md)。

## 组件创作与定向修改

- 在聊天中要求创建组件，或通过组件“更多 → 在聊天中修改”和输入区的引用入口指定画布目标。输入框上方始终显示当前创作目标。
- `create_widget_draft`、`revise_widget_draft` 只产生候选；`read_chat_widget` 只读取本会话作品。它们不能直接写画布、读取其他会话或执行任意代码。不设置每轮组件生成数量配额，允许同轮生成多个候选、连续修改及失败后重试。每次生成内部最多修复一次，所有调用共用原聊天 180 秒、8 次工具往返及 16 次工具调用安全上限。
- 原面板与聊天共用 `generateWidget`；生成器最多占用 120 秒，继承父请求取消和思考设置。工具只返回作品引用，完整定义不进入普通聊天历史。
- 首次生成即提供共享 JSON Schema；校验反馈使用 JSON Pointer 定位，包含非法属性名、允许属性、缺失字段及枚举约束。最多展示 50 项校验问题并注明剩余数量，不静默删字段、不放宽运行时校验。修复仍限一次。
- 工具活动保留最多 16,000 字符的错误详情，可在聊天中展开查看；简短状态不代替详细诊断。服务标准输出的 `widget_generation.*` JSON 日志记录 generationId、聊天 turnId/toolCallId、尝试次数、耗时和校验问题；不记录指令、交互状态、模型原文、密钥或上游 URL。
- 定义保存在 `.chats/<noteId>/artifacts/<sessionId>/<artifactId>/vN.json`，`meta.json` 保存版本索引。消息固定引用版本，不覆盖旧定义；试用输入按版本使用 revision 校验、队列和原子替换保存，不写画布文件或历史。
- `GET /api/notes/:noteId/chats/:sessionId/artifacts/:artifactId?version=N` 读取版本和索引；同一路径 `PATCH` 接受 `{revision,state}`。SSE 的 `widget_start/widget_ready/widget_error` 表示组件阶段，只有候选落盘后发送 ready。
- 画布和放大视图复用 `WidgetView`，聊天卡片和放大试用共享一个运行时状态源。暂未确认的输入在关闭试用视图时提交；动画帧、布局和滚动不写入聊天。
- 导入必须手动拖框，Esc 取消。画布命令共用原生 embeddable、快照和历史；`customData.aiWidgetChatSource` 只记录来源，不建立自动双向同步。导入后将该实例设为当前目标，后续修改仍需确认。
- 应用前检查目标及基准定义，输入或几何变化不构成定义冲突；保留最新兼容输入和当前几何。目标定义已变化时阻止覆盖，候选仍可作为新组件导入。

`chat-widget-browser.cjs` 是明确的模拟模型完整流程验收，需要在独立预览容器内启动 `chat-widget-fixture.cjs`，上游设置为容器自身 `http://127.0.0.1:3304/v1`、模型 `fixture-widgets`。3304 不发布到宿主机；验收后重建容器以停止模拟接口，恢复真实 Qwen 配置及原预览数据目录。不要把模拟模型验收结果当作真实 Qwen 验收。

`chat-widget-real.cjs` 直接使用指定的 `qwen3.8-27b` 接口，验证工具驱动的创建、修改、试用输入保留和候选持久化；设置 `BROWSER_EXECUTABLE` 时也打开真实产物进行浏览器显示检查。两种脚本都要求显式的 `/tmp/excalidraw-chat-*` 独立测试目录，只删除自己创建的唯一测试笔记。真实模型离线时保留失败记录，不切换到模拟服务冒充通过。

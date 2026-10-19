# 笔记聊天

聊天属于应用层，不修改核心画布或交互组件运行时。`repositoryMetadata.noteId` 是笔记的持久身份；会话及消息使用独立 ID，存于 `notes/.chats/<noteId>/`。打开旧笔记不补写元数据，首次创建聊天才通过原有串行保存队列建立身份。

一个笔记目录由一个服务实例写入；不要让开发、生产或多个副本同时写同一个 `.chats` 目录。验收使用独立目录和端口，不能覆盖日常使用的服务。生产 Compose 原有 `notes/` 挂载已经包含聊天目录。聊天可能包含私密内容，不自动提交或推送聊天记录。

`chatStore` 负责原子持久化及重启恢复，`chatTools` 仅查询发送时快照，`chat` 管理 Qwen 工具循环及 SSE。浏览器 `NoteChatController` 独立于侧栏生命周期，负责后台请求、输入草稿和会话隔离；流式更新只通知聊天界面，不写画布历史。服务端保存失败时保留浏览器文字并明确提示，旧文件响应不能覆盖暂存内容。

模型初始上下文只有问题、预算内历史、笔记名称及工具说明；不会附带完整笔记或图片二进制。工具仅能访问本轮当前画布快照，无任意路径、跨笔记、网络或修改能力。历史文件完整保留，但模型最多使用最近 20 轮，并受输入预算约束。

Qwen 地址、模型和可选密钥复用现有服务端环境变量。配置转发地址必须显式设置，不自动切换。上游错误会保留为消息状态，重试复用原用户消息，不自动重新发送。

相关检查：

```sh
corepack yarn test:typecheck
corepack yarn vitest run excalidraw-app/tests/chat.test.ts excalidraw-app/tests/noteChats.test.ts excalidraw-app/tests/services.test.ts excalidraw-app/tests/repositoryNotes.test.ts --minWorkers=1 --maxWorkers=2 --testTimeout=30000
APP_URL=http://127.0.0.1:3108 TEST_NOTES_DIR=/path/to/isolated-test-notes BROWSER_EXECUTABLE=/path/to/chromium corepack yarn test:chat:browser
```

浏览器验收会创建并删除唯一命名的测试笔记；会话留在独立测试目录，方便检查。必须先启动指向同一测试目录的服务。真实 Qwen 测试不等于模拟接口测试；模型暂时不可用时如实保留失败结果，不改用其他模型伪装通过。

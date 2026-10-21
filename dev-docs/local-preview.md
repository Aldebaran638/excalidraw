# 本地预览服务

日常服务保留在 **3001**；应用预览固定使用 **3009**，不另开 3002–3008 或其他应用预览端口。

使用 `docker-compose.preview.yml`，明确指定与日常笔记分开的预览数据目录：

```bash
PREVIEW_NOTES_DIR=/absolute/path/to/preview-notes \
QWEN_BASE_URL=http://10.252.221.218:18006/v1 \
docker compose -p excalidraw-preview -f docker-compose.preview.yml up -d --build
```

上面的 Qwen 地址是本机转发入口，只有需要时显式设置；不设置时沿用正式私网地址。默认模型仍为 `qwen3.8-27b`。

- 访问 `http://localhost:3009`。更新预览时复用同一个项目名和数据目录。
- 笔记及 `.chats/` 都在挂载目录里；重建容器不清理数据。需要长期保留的数据不要放在系统临时目录。
- 切换前确认没有正在生成的回答；停止旧预览再启动新预览，不修改 3001。
- 清理废弃服务只停止明确属于本项目的进程和容器，不删除用户笔记、聊天目录或共用 Docker 资源。

## 验收

`test:chat:browser` 使用真实 Qwen；`note-chat-display.cjs` 使用固定数据验收表格、思考开关、模式偏好恢复及明暗/移动布局，不请求模型。

```bash
APP_URL=http://127.0.0.1:3009 \
TEST_NOTES_DIR=/tmp/excalidraw-chat-your-isolated-test-directory \
BROWSER_EXECUTABLE=/absolute/path/to/chrome \
node excalidraw-app/tests/note-chat-display.cjs
```

先将预览挂载到该独立测试目录，再运行验收；不要将自动化验收指向日常或正在使用的预览笔记。验收后挂回原来的预览目录。单元测试的临时端口和按需运行的上游模拟接口不是额外的应用预览服务，测试结束后应释放。

# 本地预览服务

Excalidraw 正式服务使用 **3010**，挂载项目原有 `notes/`；开发预览固定使用 **3009**，挂载 `.local-data/preview/notes/`。两个目录及其中的聊天、应用源码保持独立，不自动复制或同步。**3001 当前属于其他项目，不能停止或覆盖。** 不另开 3002–3008 或其他应用预览端口。

## 正式版本发布

`master` 保留已验收版本，`aldebaran` 用于开发集成；验收后快进合并，已合并的短期分支可以删除，不默认推送远端。

正式版通过 `docker-compose.production.yml` 启动，宿主端口默认 3010，可用 `EXCALIDRAW_PORT` 显式配置。`.env.production.local`（不提交）记录 `EXCALIDRAW_IMAGE` 的已验收镜像标签及实际 Qwen 配置；发布使用不可变提交标签，不依赖开发镜像的 `latest`。

```bash
docker compose -p excalidraw-production --env-file .env.production.local \
  -f docker-compose.production.yml up -d --no-build
```

发布前备份正式数据；更新仅替换应用镜像。回退时将 `EXCALIDRAW_IMAGE` 改为上一份发布镜像，再执行相同命令，不自动回退笔记数据。3009 继续运行且保持原数据挂载。

使用 `docker-compose.preview.yml`，固定挂载项目的 `.local-data/preview/notes/`，不通过环境变量切换验收数据目录：

```bash
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

验收始终使用固定 3009 和固定数据目录，样例必须唯一命名，只清理本次创建的记录。历史脚本若要求临时应用数据目录，应先改为此规则再运行；不能切换挂载或新建第二套应用环境。单元测试的临时目录、临时端口及上游模拟接口仍可使用，结束后释放。

## 聊天组件流式验收

上述旧 JSON 组件脚本仅作历史参考，当前新建和修改统一使用 HTML 应用与 Pi 工具。运行旧脚本前须核对其兼容性及数据清理行为。当前浏览器回归可使用 `html-canvas-drag.cjs` 和 `html-canvas-transparency.cjs`，两者仅创建并清理自己的唯一命名样例，不调用模型。

真实 Qwen 验收严格串行，每次只运行一个请求／Agent 循环，不与修复或重放测试重叠。只在 3009 验收，不能把正式版 3010 用作自动化样例目录；模拟模型通过与真实模型结果分别报告。

## Pi 运行依赖

开发与生产使用 Node 24（仓库 `.nvmrc`），构建及运行镜像统一为 Debian Bookworm，保留 Pi SDK 的包资源和动态导入。`yarn build:server` 将锁定的 SDK 运行依赖闭包复制到 `server-dist/node_modules/`，生产镜像直接携带该目录，不在启动时联网安装。服务端测试使用 `yarn vitest run --config vitest.server.config.mts <测试文件>`，浏览器测试继续使用原配置。

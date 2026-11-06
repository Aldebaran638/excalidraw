# Agent 服务端

Agent 专属代码集中在本目录，与笔记应用集成运行。应用通过 `index.ts` 导出的 `createChatService`、`createAIHandler` 和 `aiConfigFromEnv` 接入；HTTP 路由仍由上级 `services.ts` 统一挂载，生产入口和 Vite 共用同一组服务。

## 模块归属

| 模块 | 职责 |
| --- | --- |
| `chat.ts` | 聊天 API、笔记工具与候选业务、场景恢复和请求生命周期 |
| `agentPolicy.ts` | 任务与权限判断、领域完成检查 |
| `piRuntime.ts`、`piProjection.ts` | Pi SDK 会话、Qwen 适配、串行工具循环与持久界面投影恢复 |
| `ai.ts` | 模型配置与连接检测；新聊天由 Pi 驱动 |
| `chatTools.ts` | 当前笔记读取与应用源码工具的目录、参数和快照处理 |
| `agentPreview.ts`、`agentDom.ts` | 本轮预览反馈及源码／实际 DOM 对照 |
| `agentProgress.ts`、`toolLoopBudget.ts` | 无进展检测、正常与恢复预算 |
| `agentLog.ts` | 按笔记、会话、轮次持久记录真实通信 |
| `widgetGeneration.ts`、`chatArtifacts.ts` | 旧 JSON 组件兼容代码，不作为新的创作入口 |

新增 Agent 专属模块放在本目录。应用组装依赖公开入口；Agent 内部可以直接引用同目录模块，测试也可直接测试内部模块。不在原路径留下转发文件，避免长期维护两套入口。

## 共享层边界

以下模块由 Agent 和其他服务共同使用，继续位于上级目录：

- `notes.ts`、`chatStore.ts`、`fileIO.ts`：笔记读写／同步、笔记身份检查、会话原子持久化与瞬态文件读取恢复。
- `appApi.ts`、`chatHtmlStore.ts`：画布与聊天使用的 HTML 应用 API、源码版本及状态存储。
- `appSource.ts`、`sourceErrors.ts`、`styleDiagnostics.ts`：源码哈希、分页／搜索、原子替换、校验及诊断。
- `main.ts`、`services.ts`、`clientInfo.ts`：应用 HTTP 启动、服务组装、构建及协议信息。

共享层不依赖本目录中的编排或模型通信实现。浏览器共用的数据类型与运行协议仍位于 `excalidraw-app/data/`，本次不移动前端、画布核心或共享运行时。

## Pi 场景

`notes` 场景禁用内置文件／终端工具和自动资源发现，显式注册笔记读取与应用源码工具。Pi 管理模型上下文及工具循环；源码校验、候选保存、真实浏览器检查及用户确认继续归业务层。旧手写请求循环、压缩与传输重试已移除。

会话数据为 `.chats/<noteId>/pi/<sessionId>/` 下的 Pi JSONL；`notes_begin`／`notes_commit` 将活动分支与界面消息 ID 关联。历史编辑回到对应父分支，旧会话按有效记录导入，不伪造旧工具轨迹。投影 outbox 用原子写入保留尚未写回聊天的消息，重启恢复不重发模型请求。

Pi 1.5.0 的工具名称分片限制由 Qwen 适配边界处理；原始分片先记入通信日志，适配后由 Pi 校验、执行。停止与已输出部分内容后的断流不自动重放。

## 兼容与数据

Pi 迁移保持既有 API 路径、环境变量、笔记与作品格式及数据目录兼容；只增加独立 Pi 会话／投影文件及可选运行状态事件，不批量改写旧会话。正常／恢复工具预算和场景完成检查继续由业务层管理，通用模型循环与压缩交给 SDK。当前源码保存在 `notes/.apps/<noteId>/`，会话、作品和通信日志保存在 `notes/.chats/<noteId>/`。旧 JSON 作品继续按现有规则只读兼容；正式画布修改仍需用户确认。

开发与生产均使用固定 3009 和项目的 `.local-data/preview/notes/`；3001 保持不变。验收样例只能新增唯一命名的记录并清理自己的记录，不替换挂载目录。真实 Qwen 验收严格串行；纯目录重构优先用现有模拟集成测试验证行为，无需额外消耗模型请求。

## 维护与检查

- 相关回归位于 `excalidraw-app/tests/`，导入路径更新到 `../server/agent/…`，保留原有行为断言。
- 检查类型、相关 lint、聊天／读取工具／编辑／修复／日志／笔记同步的现有测试，以及生产构建。
- 架构及实际验收记录见 [笔记 Agent 架构](../../../docs/note-agent-architecture.md)，预览约束见 [本地预览服务](../../../dev-docs/local-preview.md)。

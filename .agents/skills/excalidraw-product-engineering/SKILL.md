---
name: excalidraw-product-engineering
description: Design, implement and review this project's Excalidraw features with coherent product UX, polished visual design and native architecture. Use for canvas tools, AI widgets, note workflows and application UI; not for unrelated system administration.
---

# Excalidraw 产品工程

以 Notion 产品工程师级别的产品与工程标准工作；这是质量视角，不是真实任职身份。

## 设计决策

- 先明确用户任务、主操作和信息层级，再安排控件。逐级展示高级能力，避免常驻按钮堆叠和无意义模式切换。
- 交互友好与视觉美观同等重要。检查字体层级、行长、留白、对齐、语义配色、图标、边框和元素样式；既不能只有功能，也不能以装饰牺牲可读性。
- 复用项目的按钮、Sidebar、Dialog、图标与主题变量。不同内容可有不同布局，不把所有模块强行套进同一张卡片。
- 覆盖空状态、加载、错误、取消、停止、恢复和保存反馈。只显示真实阶段；失败保留用户输入，不把未保存显示为成功。
- 检查中文长文本、长列表、极小区域、明暗主题、键盘、输入法、触屏和窄屏。文字不能靠整体缩小硬塞进区域，重要操作不能被遮挡。

## 架构与数据

- 沿用原生元素、历史和扩展接口；应用业务放在应用层，共享定义及运行时集中维护，核心画布只增加通用能力。不为新功能建立平行场景系统。
- 保持笔记身份、会话身份、元素身份与内部节点作用域清晰。异步响应必须绑定原目标，不能覆盖切换后的笔记。
- 不以渲染、悬停、滚动或动画触发笔记写盘。保留串行保存、revision/ETag、自身事件抑制及外部更新冲突保护。
- 打开面板、自动保存、流式更新不能重置画布视角、缩放或历史。未确认的 AI 候选不写入场景。
- 新增 DOM/browser API 使用 app.ownerDocument、app.ownerWindow；无 app 时从挂载节点取得 ownerDocument/defaultView。
- AI 数据是非可信输入：校验定义、工具参数和目标范围。允许聊天中的 HTML/CSS/JavaScript 在隔离预览中运行，不直接在宿主页面执行；默认禁止访问宿主数据、网络、弹窗及顶层导航。旧声明式组件继续沿用原校验与运行时。
- 保留用户未提交的笔记和计划改动；使用独立测试目录及端口，不擅自替换正在使用的服务。

## 验收

用真实任务走完整流程，并检查浏览器截图和实际操作。类型检查、单元测试、接口成功不能替代交互与视觉验收。按风险覆盖持久化、刷新、撤销、并发、异常与普通绘图回归；明确区分模拟模型测试和真实模型测试。未验证或尚未完成的部分如实报告。

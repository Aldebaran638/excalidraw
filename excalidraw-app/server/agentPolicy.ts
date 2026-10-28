import type {
  AppTaskTarget,
  ChatAgentTask,
  ChatMessage,
} from "../data/chatTypes";

export type AgentTask = ChatAgentTask["kind"];

/** Only the immediately preceding turn on this exact app can authorize a
 * corrective follow-up. Older files use real saved outputs, never prose. */
export function followsAppTask(
  history: readonly ChatMessage[],
  target?: AppTaskTarget,
) {
  const previous = history.at(-1);
  if (!target || previous?.role !== "assistant") {
    return false;
  }
  if (previous.agentTask) {
    if (previous.agentTask.kind === "chat") {
      return false;
    }
    if (previous.agentTask.target) {
      const prior = previous.agentTask.target;
      return target.kind === "element"
        ? prior.kind === "element" &&
            prior.elementId === target.elementId &&
            prior.appId === target.appId
        : prior.kind === "html" && prior.artifactId === target.artifactId;
    }
  }
  return Boolean(
    previous.blocks?.some((block) =>
      target.kind === "html"
        ? block.type === "html" &&
          block.saved &&
          block.ref.artifactId === target.artifactId
        : block.type === "edit_result" &&
          block.application?.elementId === target.elementId &&
          block.application.appId === target.appId &&
          previous.activities?.some(
            (activity) =>
              activity.name === "edit_app_source" &&
              activity.status === "complete",
          ),
    ),
  );
}

export const permitsSourceEdit = (task: AgentTask, repairing: boolean) =>
  task !== "chat" || repairing;

/** Routing is deliberately conservative: a referenced app is not permission to
 * edit it when the user merely asks a question. No extra classification call. */
export function agentTask(
  instruction: string,
  hasTarget: boolean,
  followsApp = false,
): AgentTask {
  if (
    /^\s*(?:请|先|请先|请你)?(?:解释|介绍|讲解|讲一下|说明|分析|为什么|如何|怎么|explain\b|describe\b|why\b|how\b)/i.test(
      instruction,
    ) &&
    !/(?:并|然后|再|顺便|直接|[,，。；;]\s*)(?:帮我|请)?(?:修复|修改|调整|添加|生成|创建)|\b(?:and|then|also)\s+(?:fix|edit|change|create|build)\b/i.test(
      instruction,
    )
  ) {
    return "chat";
  }
  if (
    /(?:不需要|无需|不用|不要)(?:修改|改动|编辑|改代码|改源码|生成|创建|新建)|只(?:需要|需|要)?(?:解释|回答|讨论)|仅(?:解释|回答|讨论)|只读|do not (?:edit|change|generate|create)/i.test(
      instruction,
    )
  ) {
    return "chat";
  }
  const action =
    /修改|调整|优化|增加|添加|加上|改成|改为|改一下|换成|换为|变成|变为|去掉|移除|删掉|删除|缩小|扩大|收窄|继续完善|重新生成|修复|修正|美化|重构|重新设计|崩溃|不好用|不工作|不生效|没反应|\b(?:edit|update|fix|change|add|redesign)\b/i;
  if (
    hasTarget &&
    /新建|另外(?:创建|生成|做)|再生成|生成一个新的|create a new/i.test(
      instruction,
    ) &&
    /组件|应用|架构|流程|图|app|widget|diagram/i.test(instruction)
  ) {
    return "create";
  }
  if (hasTarget && action.test(instruction)) {
    return "edit";
  }
  if (
    hasTarget &&
    followsApp &&
    /(?:你|您)?理解错了|(?:我|你|您)(?:说|想要?|要|指)的(?:是|不是)|我的意思是|不是这个(?:意思|效果)|不对[，,。]|不是.{0,40}(?:而是|是要)|\b(?:i meant|that's not what|you misunderstood|not what i (?:meant|wanted))\b/i.test(
      instruction,
    ) &&
    !/[?？]\s*$|为什么|为何|如何理解|怎么理解|解释一下|是什么意思|是不是|是否/.test(
      instruction,
    )
  ) {
    return "edit";
  }
  if (
    /生成|创建|制作|实现|搭建|做(?:一|个)|画|绘制|\b(?:create|build|generate|make)\b/i.test(
      instruction,
    ) &&
    /组件|应用|架构|流程|可视化|交互|计数器|计算器|番茄钟|矩阵|图谱|图表|拓扑|\b(?:app|widget|diagram|calculator|counter)\b/i.test(
      instruction,
    )
  ) {
    return "create";
  }
  return "chat";
}

export const AGENT_SOURCE_READ_LIMIT = 192000;
export function needsNoteTools(
  task: AgentTask,
  instruction: string,
  hasElements: boolean,
) {
  if (!hasElements) {
    return false;
  }
  if (task === "chat") {
    return true;
  }
  // Do not remove note-based creation/editing while keeping unrelated canvas
  // content out of the ordinary source-only workflow.
  return /(?:根据|依据|参照|结合|基于|读取|参考|使用|从).{0,40}(?:笔记|画布|矩阵|表格|组件|应用)|(?:笔记|画布)(?:里|中|上)(?:的)?|(?:笔记|画布)的(?:内容|数据)|(?:based on|from|using|read).{0,40}(?:notes?|canvas|selected matrix|table|widget)/i.test(
    instruction,
  );
}
export const AGENT_RECOVERY_LIMIT = 3;

/** Only real saved outputs can satisfy a creation/edit task. */
export class AgentCompletion {
  attempts = 0;
  constructor(readonly task: AgentTask) {}
  recover(hasSavedOutput: boolean) {
    if (
      this.task === "chat" ||
      hasSavedOutput ||
      this.attempts >= AGENT_RECOVERY_LIMIT
    ) {
      return false;
    }
    this.attempts++;
    return true;
  }
}

export const AGENT_GUIDE = `完成任务而非只描述计划。新建复杂知识应用时，用数据数组驱动节点、关系、说明和搜索；将详细知识放在可点击的解释区，避免手写成百个重复卡片。结构要有分组和真实关联、清晰图例与响应式布局，不能用一张纯文字清单冒充架构图。SVG绘图前按分组和索引自动计算布局，不手写每个节点的固定x/y：先为每组分配不相交区域，再按该组实际节点数量计算行列和区域宽高。绘制和连线共用这一份坐标来源；viewBox从所有节点的x+width、y+height加外边距计算，不能使用缺失坐标或把节点裁在图外。新增节点后必须重新计算全图布局而不是把它塞到已有节点上。优先一次完成核心功能和足够详细的内容，再装饰；不为了视觉重复生成大量代码。可使用运行环境列出的常用库。
复杂图默认保持文字至少14px、可点击节点至少44px高；聊天中用固定可读宽度的SVG和局部滚动，不要将900px大图按width:100%整体压缩到300px，也不要默认fit缩放使文字只有几像素。容器可以滚动，宿主尺寸不可自动扩大。
修改时先搜索定位相关区域，再读取相关源码与哈希，然后真实调用 edit_app_source；不要从第一行反复通读，不要抄入行号前缀。可以在一次编辑中提交多个互不重叠的替换；长文本、缩进或唯一匹配容易出错时，优先使用刚读取的startLine/endLine/newText完整行替换，保留未改的行，不要混用oldText与行范围。失败时根据真实错误调整后继续，不要求用户重试，不声称未发生的成功。没有问题或用户只询问时可以直接解释，不要为了使用工具而修改源码。
系统会在同一轮有界恢复缺失产物、未执行修改、错误协议和长度截断，共用当前时间和工具预算；用户停止、连接断开、存储失败时不能继续。若库已加载，使用其真实API，不要调用不存在的NoteApp能力。应用创建后及修改后请保证原来的交互、稳定ID和持久状态继续可用。`;

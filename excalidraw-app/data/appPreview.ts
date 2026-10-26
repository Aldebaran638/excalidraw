export type AppPreviewReport = {
  ids: string[];
  nodes: number;
  relations: number;
  errors: string[];
  nodeKeys?: string[];
  title?: string | null;
  stateKey?: string;
};

/** Cache coherence only, never a source-integrity or authorization hash. */
export function previewStateKey(state: unknown) {
  const text = JSON.stringify(state) || "";
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Only used in a disposable verification iframe, NEVER the user's instance.
 * These synthetic selection probes test the diagram's advertised click contract,
 * not real keyboard/touch accessibility or arbitrary business correctness. */
export async function inspectNodeInteractions(doc: Document) {
  const win = doc.defaultView!;
  const explanation = doc.getElementById("explanation");
  if (!explanation) {
    return [];
  }
  const errors: string[] = [];
  const wait = () =>
    new Promise<void>((resolve) => win.setTimeout(resolve, 30));
  const nodes = Array.from(doc.querySelectorAll("[data-node]"))
    .filter((node) => node.getBoundingClientRect().height > 0)
    .slice(0, 60);
  for (const [index, node] of nodes.entries()) {
    if (!node.getBoundingClientRect().height) {
      continue;
    }
    const before = explanation.textContent?.trim() || "";
    let updated = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      node.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await wait();
      const after = explanation.textContent?.trim() || "";
      if (
        after.length > 12 &&
        after !== before &&
        !/^(?:👆\s*)?点击[^。]{0,60}(?:节点|查看)/.test(after)
      ) {
        updated = true;
        break;
      }
    }
    if (
      index === 0 &&
      !updated &&
      before.length > 12 &&
      !/^(?:👆\s*)?点击[^。]{0,60}(?:节点|查看)/.test(before)
    ) {
      // The initial selection may already be this node. Visit another node
      // first, then return: unchanged text alone is not a broken interaction.
      if (nodes.length > 1) {
        nodes.push(node);
      }
      continue;
    }
    if (!updated) {
      errors.push(
        `隔离副本中点击data-node=${node
          .getAttribute("data-node")
          ?.slice(
            0,
            80,
          )}后，#explanation没有可观察的解释更新。请核对节点数据、解释查询及事件绑定，新增节点必须进入真实数据模型，不能只画外观；保留原节点和状态`,
      );
    }
    if (errors.length >= 4) {
      break;
    }
  }
  return errors;
}

/** Serialized into the opaque iframe; never reads host data. */
export function inspectSvgGeometry(doc: Document) {
  const errors: string[] = [];
  for (const node of Array.from(doc.querySelectorAll("svg,svg *"))) {
    for (const name of [
      "x",
      "y",
      "x1",
      "x2",
      "y1",
      "y2",
      "cx",
      "cy",
      "r",
      "rx",
      "ry",
      "width",
      "height",
      "d",
      "points",
      "transform",
      "viewBox",
    ]) {
      const value = node.getAttribute(name);
      if (value && /undefined|NaN|Infinity|\bnull\b/.test(value)) {
        errors.push(
          `SVG节点${
            node.id || node.getAttribute("data-node") || node.tagName
          }的${name}包含无效坐标${value.slice(
            0,
            100,
          )}；请计算有限坐标，不能用默认回退掩盖重叠`,
        );
        if (errors.length >= 4) {
          return errors;
        }
      }
    }
  }
  // Inspect independent selectable nodes, not labels/edges or nested groups.
  const nodes = Array.from(doc.querySelectorAll("[data-node]"))
    .slice(0, 200)
    .map((node) => ({ node, rect: node.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 1 && rect.height > 1);
  const tinyNodes = nodes.filter(
    ({ node, rect }) =>
      node.closest("svg") &&
      rect.height < 28 &&
      !nodes.some((other) => other.node !== node && node.contains(other.node)),
  );
  if (tinyNodes.length) {
    const svg = tinyNodes[0].node.closest("svg")!;
    const style = doc.defaultView?.getComputedStyle(svg);
    errors.push(
      `知识图有${tinyNodes.length}个节点被缩到不足28px高。SVG实际CSS width=${style?.width}, max-width=${style?.maxWidth}。运行时默认svg的max-width:100%会继续压缩它，仅改width/height无效。请为知识图设置max-width:none、flex-shrink:0及自然宽高px，外层overflow:auto；节点至少44px高、文字14px，不用fit缩放，不扩大宿主区域`,
    );
  }
  for (const { node, rect } of nodes) {
    const svg = node.closest("svg");
    if (!svg) {
      continue;
    }
    let parent: Element | null = node.parentElement;
    let transformed = false;
    while (parent && parent !== svg) {
      if (parent.hasAttribute("transform")) {
        transformed = true;
      }
      parent = parent.parentElement;
    }
    // A transformed wrapper may be a user-controlled pan/zoom viewport.
    if (
      transformed ||
      doc.defaultView?.getComputedStyle(svg).overflow === "visible"
    ) {
      continue;
    }
    const bounds = svg.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (
      bounds.width > 1 &&
      bounds.height > 1 &&
      (x < bounds.left - 1 ||
        x > bounds.right + 1 ||
        y < bounds.top - 1 ||
        y > bounds.bottom + 1)
    ) {
      errors.push(
        `知识节点${node
          .getAttribute("data-node")
          ?.slice(
            0,
            80,
          )}被SVG视口裁掉，无法正常点击；请扩大viewBox或重排节点坐标，使节点及其连线位于可视边界内`,
      );
      if (errors.length >= 4) {
        return errors;
      }
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (
        a.node.contains(b.node) ||
        b.node.contains(a.node) ||
        a.node.getAttribute("data-node") === b.node.getAttribute("data-node")
      ) {
        continue;
      }
      const overlapWidth = Math.max(
        0,
        Math.min(a.rect.left + a.rect.width, b.rect.left + b.rect.width) -
          Math.max(a.rect.left, b.rect.left),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(a.rect.top + a.rect.height, b.rect.top + b.rect.height) -
          Math.max(a.rect.top, b.rect.top),
      );
      const substantialOverlap =
        a.node.closest("svg") &&
        b.node.closest("svg") &&
        overlapWidth * overlapHeight >
          Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height) *
            0.55;
      if (
        substantialOverlap ||
        (Math.abs(
          a.rect.left + a.rect.width / 2 - b.rect.left - b.rect.width / 2,
        ) < 1 &&
          Math.abs(
            a.rect.top + a.rect.height / 2 - b.rect.top - b.rect.height / 2,
          ) < 1)
      ) {
        errors.push(
          `知识节点${a.node.getAttribute("data-node")?.slice(0, 80)}与${b.node
            .getAttribute("data-node")
            ?.slice(
              0,
              80,
            )}明显重叠，无法分别点击。请按分组/索引计算不同坐标，并让连线使用更新后的同一坐标来源`,
        );
        if (errors.length >= 4) {
          return errors;
        }
      }
    }
  }
  return errors;
}
export function isPreviewReport(value: unknown): value is AppPreviewReport {
  const report = value as AppPreviewReport;
  return Boolean(
    report &&
      Array.isArray(report.ids) &&
      report.ids.length <= 300 &&
      report.ids.every((id) => typeof id === "string" && id.length <= 200) &&
      Number.isSafeInteger(report.nodes) &&
      report.nodes >= 0 &&
      report.nodes <= 20000 &&
      Number.isSafeInteger(report.relations) &&
      report.relations >= 0 &&
      report.relations <= 20000 &&
      Array.isArray(report.errors) &&
      report.errors.length <= 8 &&
      report.errors.every(
        (error) => typeof error === "string" && error.length <= 500,
      ) &&
      (report.title === undefined ||
        report.title === null ||
        (typeof report.title === "string" && report.title.length <= 300)) &&
      (report.stateKey === undefined ||
        (typeof report.stateKey === "string" &&
          /^[a-f0-9]{8}$/.test(report.stateKey))) &&
      (report.nodeKeys === undefined ||
        (Array.isArray(report.nodeKeys) &&
          report.nodeKeys.length <= 300 &&
          report.nodeKeys.every(
            (key) => typeof key === "string" && key.length <= 200,
          ))),
  );
}

/** Verify explicit observable requirements, not a claim of aesthetic/semantic correctness. */
export function previewProblems(
  instruction: string,
  report: AppPreviewReport,
  baseline?: AppPreviewReport,
) {
  const errors = [...report.errors];
  if (
    baseline?.nodeKeys &&
    report.nodeKeys &&
    /保留(?:全部|所有|原有|现有|原来|原)[^。；;\n]{0,20}(?:节点|步骤)/.test(
      instruction,
    )
  ) {
    const current = new Set(report.nodeKeys);
    const missing = baseline.nodeKeys.filter((key) => !current.has(key));
    if (missing.length) {
      errors.push(
        `用户要求保留原节点，但当前候选缺少${missing.length}个：${missing
          .slice(0, 8)
          .map((key) => key.slice(0, 30))
          .join(
            "、",
          )}。请用revision=baseline搜索/读取修改前源码，恢复这些节点的原始数据、说明与交互；保留本次新增内容，不要只放空壳或重命名ID绕过检查`,
      );
    }
  }
  const requestedTitle =
    /(?:标题(?:改为|改成|设为|设置为|换成|变为|为)|主标题\s*(?:id\s*=\s*app-title)?[，,]?\s*文字为|title\s+(?:to|as))\s*[“"「『']([^”"」』'\n]{1,300})[”"」』']/i.exec(
      instruction,
    )?.[1];
  if (
    requestedTitle &&
    report.title !== undefined &&
    !(report.title || "")
      .replace(/\s+/g, " ")
      .includes(requestedTitle.replace(/\s+/g, " "))
  ) {
    errors.push(
      `用户要求标题“${requestedTitle.slice(0, 150)}”，实际主标题为“${(
        report.title || "未找到可见主标题"
      ).slice(
        0,
        150,
      )}”。请修改真正可见的主标题（使用稳定id=app-title或h1），不能只改注释或回答文字`,
    );
  }
  const seen = new Set<string>();
  for (const id of report.ids) {
    if (id && seen.has(id)) {
      errors.push(
        `预览存在重复ID=${id}，必须保持ID唯一，避免绑定或交互定位错误`,
      );
    }
    seen.add(id);
  }
  const minimum =
    /(?:至少|不少于|at least)\s*(\d+)\s*个?(?:可点击)?(?:知识)?(?:节点|步骤)/i.exec(
      instruction,
    );
  if (
    minimum &&
    Number(minimum[1]) <= 200 &&
    report.nodes < Number(minimum[1])
  ) {
    errors.push(
      `用户要求至少${minimum[1]}个节点，实际预览只有${report.nodes}个，请补全数据和关系`,
    );
  }
  for (const match of instruction.matchAll(
    /\bid\s*=\s*["']?([a-zA-Z][\w-]*)/g,
  )) {
    if (!report.ids.includes(match[1])) {
      errors.push(`预览缺少用户明确要求的id=${match[1]}`);
    }
  }
  if (report.nodeKeys) {
    for (const match of instruction.matchAll(
      /\bdata-node\s*=\s*["']?([\w-]+)/g,
    )) {
      if (!report.nodeKeys.includes(match[1])) {
        errors.push(`预览缺少用户明确要求的data-node=${match[1]}节点`);
      }
    }
  }
  return errors.slice(0, 8);
}

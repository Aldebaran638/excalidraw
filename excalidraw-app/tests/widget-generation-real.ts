/* Explicit real-model check; no notes, chats or canvas are written. */
/* eslint-disable no-console */
import assert from "node:assert/strict";

import { generateWidget } from "../server/agent/widgetGeneration";
import { computeWidget } from "../../packages/interactive-widgets/compute";

const baseUrl = process.env.QWEN_BASE_URL;
assert.ok(baseUrl, "Set the explicit Qwen upstream URL");
const model = "qwen3.8-27b";
const models = await fetch(`${baseUrl}/models`, {
  signal: AbortSignal.timeout(5000),
}).then((response) => response.json());
assert.ok(models.data?.some((entry: { id: string }) => entry.id === model));
for (const prompt of [
  "生成简洁的双数加法计算器，A默认3、B默认4，输入后即时计算，最多8个节点。",
  "生成一个简洁的可点击概念讲解：三个按钮选择Pod、Service、Deployment，下方联动显示对应中文解释，提供重置按钮。最多12个节点。",
]) {
  let partials = 0;
  const result = await generateWidget(
    { baseUrl, model },
    { prompt, region: { width: 700, height: 480 }, thinking: false },
    AbortSignal.timeout(125000),
    fetch,
    {},
    (progress) => {
      if (progress.phase === "generating" && progress.document) {
        partials++;
      }
    },
  );
  assert.ok(partials > 0, "Expected real nodes before generation completion");
  assert.equal(
    Object.keys(
      computeWidget(result.definition, result.definition.initialState).errors,
    ).length,
    0,
  );
  console.log(
    JSON.stringify({
      verified: "real Qwen generation and runtime validation",
      title: result.definition.title,
      model,
      streamedPreviews: partials,
    }),
  );
}

/* Explicit mock upstream, only run INSIDE the isolated acceptance container. */
/* eslint-disable no-console */
const http = require("node:http");
const definition = () => ({
  version: 2,
  title: "聊天计算器",
  initialState: { a: 3, b: 4 },
  computations: { answer: { op: "add", args: [{ ref: "a" }, { ref: "b" }] } },
  root: {
    id: "root",
    type: "column",
    children: [
      { id: "heading", type: "title", text: "聊天计算器" },
      { id: "a", type: "number", bind: "a", label: "A" },
      { id: "b", type: "number", bind: "b", label: "B" },
      { id: "answer", type: "result", label: "结果", data: { ref: "answer" } },
    ],
  },
});
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/v1/models") {
    res.end(JSON.stringify({ data: [{ id: "fixture-widgets" }] }));
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (
      !body.stream ||
      body.messages[0].content.startsWith("You design interactive widgets")
    ) {
      const input = JSON.parse(body.messages[1].content);
      const value = input.currentDefinition || definition();
      if (input.currentDefinition) {
        value.title = "修改后计算器";
        value.root.children[0].text = value.title;
      }
      if (input.prompt.includes("非法")) {
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"version":999}' } }],
          }),
        );
        return;
      }
      if (input.prompt.includes("慢速")) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        const text = JSON.stringify(value);
        const cut = text.indexOf('"id":"a"');
        const frame = (content, finish_reason = null) =>
          `data: ${JSON.stringify({
            choices: [{ delta: { content }, finish_reason }],
          })}\n\n`;
        res.write(frame(text.slice(0, cut)));
        await new Promise((resolve) =>
          setTimeout(resolve, input.prompt.includes("逐步") ? 15000 : 300),
        );
        res.end(`${frame(text.slice(cut), "stop")}data: [DONE]\n\n`);
        return;
      }
      res.end(
        JSON.stringify({
          model: "fixture-widgets",
          choices: [
            {
              message: { content: JSON.stringify(value) },
              finish_reason: "stop",
            },
          ],
        }),
      );
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          model: "fixture-widgets",
          choices: [{ delta, finish_reason }],
        })}\n\n`,
      );
    if (body.messages.at(-1).role === "tool") {
      if (
        body.messages.some(
          (message) =>
            message.role === "user" && message.content.includes("文字失败"),
        )
      ) {
        res.statusCode = 503;
        res.end();
        return;
      }
      send({ content: "组件候选已准备好，请试用后手动确认。" }, "stop");
    } else {
      const workspace = JSON.parse(
        body.messages[0].content.match(/当前创作目标：(.+?)。笔记名称/)[1],
      );
      const prompt = body.messages.at(-1).content;
      if (body.chat_template_kwargs.enable_thinking) {
        send({ reasoning_content: "模拟接口正在准备组件。" });
      }
      send({
        tool_calls: [
          {
            index: 0,
            id: `fixture-${Date.now()}`,
            function: {
              name:
                workspace && !prompt.includes("新建")
                  ? "revise_widget_draft"
                  : "create_widget_draft",
              arguments: JSON.stringify({ prompt }).slice(0, 8),
            },
          },
        ],
      });
      send(
        {
          tool_calls: [
            {
              index: 0,
              function: { arguments: JSON.stringify({ prompt }).slice(8) },
            },
          ],
        },
        "tool_calls",
      );
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
server.listen(3304, "127.0.0.1", () =>
  console.log("Mock widget upstream ready (no real Qwen calls)"),
);

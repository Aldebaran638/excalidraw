// Deterministic test upstream. Never used by the application or as a fallback.
const http = require("node:http");
const server = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "qwen3.8-27b" }] })); return; }
  if (req.url !== "/v1/chat/completions" || req.method !== "POST") { res.writeHead(404).end(); return; }
  try {
    let text = "";
    for await (const chunk of req) { text += chunk; if (text.length > 1024 * 1024) { throw new Error("Request too large"); } }
    const body = JSON.parse(text);
    const input = JSON.parse(body.messages.find(message => message.role === "user").content);
    if (body.model !== "qwen3.8-27b" || body.stream !== false || !input.region || !input.initialIntent) { throw new Error("Unexpected proxy request"); }
    const definition = structuredClone(input.currentDefinition);
    if (!definition) { throw new Error("Fixture only supports modifying the saved flow example"); }
    if (input.prompt.includes("第二") && definition.title !== "请求处理与重试演示") { throw new Error("Second request did not use the latest candidate"); }
    definition.version = 2;
    definition.title = input.prompt.includes("第二") ? "请求处理第二候选" : "请求处理与重试演示";
    setTimeout(() => {
      if (res.destroyed) { return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(definition) }, finish_reason: "stop" }] }));
    }, 500);
  } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(Number(process.env.FIXTURE_PORT || 3304), "127.0.0.1");

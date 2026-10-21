/* Private mock upstream, never an application preview. */
const http = require("node:http");
const source = `<!doctype html><html><head><title>交互计算与演示</title><style>.result{font-size:28px;color:var(--accent)}.selected{outline:2px solid var(--accent)}</style></head><body><main class="col"><h2>交互计算与演示</h2><section class="card"><label for="a">数值 A</label><input id="a" type="number" value="3"><label for="b">数值 B</label><input id="b" type="number" value="4"><output id="sum" class="result"></output></section><section class="card"><h3>待办清单</h3><button id="add">增加事项</button><ul id="todos"></ul></section><section class="card"><h3>架构关系</h3><div class="row"><button id="pod">Pod</button><span>→</span><button id="service">Service</button></div><p id="explanation">点击节点了解关系</p></section><section class="card"><h3>矩阵转置</h3><input id="matrix" value="1,2;3,4"><button id="transpose">转置</button><pre id="matrix-result"></pre></section></main><script>
window.executions=(window.executions||0)+1;
const a=document.getElementById('a'),b=document.getElementById('b');
function sum(){document.getElementById('sum').textContent=Number(a.value)+Number(b.value)}a.oninput=b.oninput=sum;sum();
let count=NoteApp.get('count',0);function todos(){document.getElementById('todos').textContent='事项数量：'+count}document.getElementById('add').onclick=()=>{NoteApp.set('count',++count);todos()};todos();
['pod','service'].forEach(id=>document.getElementById(id).onclick=()=>{document.getElementById('explanation').textContent=id==='pod'?'Pod 运行应用容器':'Service 为 Pod 提供稳定访问入口';document.getElementById(id).classList.toggle('selected')});
document.getElementById('transpose').onclick=()=>{const m=document.getElementById('matrix').value.split(';').map(r=>r.split(','));document.getElementById('matrix-result').textContent=m[0].map((_,i)=>m.map(r=>r[i]).join(',')).join(';')};
</script></body></html>`;
const server = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "fixture-html" }] }));
    return;
  }
  let raw = "";
  for await (const part of req) {
    raw += part;
  }
  JSON.parse(raw);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`,
    );
  emit({ reasoning_content: "先安排可交互布局。" });
  emit({ content: "这是可以直接操作的应用。\n```html\n" });
  const cut = source.indexOf("<script>");
  emit({ content: source.slice(0, cut) });
  const timer = setTimeout(() => {
    emit({ content: source.slice(cut) });
    emit({ content: "\n```\n" });
    emit({ reasoning_content: "界面与交互代码已给出。" });
    emit({ content: "可以修改参数、增加事项，或选择节点。" }, "stop");
    res.end("data: [DONE]\n\n");
  }, 7000);
  res.on("close", () => clearTimeout(timer));
});
server.listen(Number(process.env.FIXTURE_PORT || 3304), "127.0.0.1");

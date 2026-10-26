/* Disposable selection probes must never operate the user's running instance. */
/* eslint-disable no-console */
/* global ProbeRuntime */
const assert = require("node:assert/strict");

const { buildSync } = require("esbuild");
const { chromium } = require("playwright-core");

(async () => {
  const code = buildSync({
    entryPoints: ["excalidraw-app/data/htmlRuntime.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "ProbeRuntime",
  }).outputFiles[0].text;
  const browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.log("runtime", error.message));
    await page.route("**/__selection-probe", (route) =>
      route.fulfill({ contentType: "text/html", body: "<body></body>" }),
    );
    await page.goto("http://127.0.0.1:3009/__selection-probe");
    await page.bringToFront();
    await page.addScriptTag({ content: code });
    await page.evaluate(() => {
      window.events = [];
      window.addEventListener("message", (event) => {
        window.events.push(event.data);
      });
      const source = `<main id="app"><h1 id="app-title" style="color:#192335">知识讲解</h1><input id="task"><button data-node="one">已有节点</button><button data-node="review">新增节点</button><section id="explanation">请先选择一个知识节点查看详细解释</section></main><script>(()=>{
        const data={one:'已有节点的完整解释：机制与场景均已实现。'};
        NoteApp.on('select','app','click','[data-node]',(_,target)=>{
          const detail=data[target.dataset.node];
          document.getElementById('explanation').textContent=detail.trim();
          NoteApp.set('selection',target.dataset.node);
          document.getElementById('task').value='探测副本中的变化';
          document.getElementById('task').focus();
        });
      })()</script>`;
      window.createApp = (name, verify) => {
        const holder = document.createElement("div");
        holder.inert = verify;
        const frame = document.createElement("iframe");
        frame.sandbox = "allow-scripts";
        frame.width = "360";
        frame.height = "480";
        holder.appendChild(frame);
        document.body.appendChild(holder);
        window.addEventListener("message", (event) => {
          if (
            event.source === frame.contentWindow &&
            event.data?.type === "ready"
          ) {
            frame.contentWindow.postMessage(
              { token: name, type: "append", data: source },
              "*",
            );
            frame.contentWindow.postMessage(
              { token: name, type: "finish" },
              "*",
            );
          }
        });
        frame.srcdoc = ProbeRuntime.htmlBootstrap(
          name,
          {
            forms: { task: { type: "text", value: "用户已输入的内容" } },
            custom: {},
          },
          3,
          "",
          name,
          verify,
        );
        return frame;
      };
      window.ordinary = window.createApp("ordinary", false);
    });
    const ordinary = page.frameLocator("iframe");
    await page
      .waitForFunction(
        () =>
          window.events.some(
            (event) => event.token === "ordinary" && event.type === "preview",
          ),
        undefined,
        { timeout: 15000, polling: 100 },
      )
      .catch(async (error) => {
        console.log(
          "bootstrap events",
          await page.evaluate(() =>
            window.events.map((event) => ({
              type: event.type,
              token: event.token,
              data: event.type === "error" ? event.data : undefined,
            })),
          ),
        );
        throw error;
      });
    await page.bringToFront();
    const inputBounds = await ordinary.locator("#task").boundingBox();
    assert.ok(inputBounds?.height);
    await page.mouse.click(inputBounds.x + 10, inputBounds.y + 10);
    await page.evaluate(() => {
      window.verifier = window.createApp("verifier", true);
    });
    await page.waitForFunction(
      () =>
        window.events.some(
          (event) => event.token === "verifier" && event.type === "preview",
        ),
      undefined,
      { timeout: 15000, polling: 100 },
    );
    const result = await page.evaluate(() => ({
      ordinaryStates: window.events.filter(
        (event) => event.token === "ordinary" && event.type === "state",
      ),
      report: window.events.find(
        (event) => event.token === "verifier" && event.type === "preview",
      ).data,
      ordinaryFocused: document.activeElement === window.ordinary,
    }));
    assert.ok(
      result.report.errors.some((error) => /data-node=review/.test(error)),
    );
    assert.ok(
      result.report.errors.some((error) => /dark主题.*对比度/.test(error)),
    );
    assert.equal(result.ordinaryStates.length, 0);
    assert.equal(result.ordinaryFocused, true, "probe stole focus");
    assert.equal(
      await page.frameLocator("iframe").nth(0).locator("#task").inputValue(),
      "用户已输入的内容",
    );
    assert.equal(
      await page
        .frameLocator("iframe")
        .nth(0)
        .locator("#explanation")
        .textContent(),
      "请先选择一个知识节点查看详细解释",
    );
    await page.evaluate(() =>
      window.verifier.contentWindow.postMessage(
        { token: "verifier", type: "dispose" },
        "*",
      ),
    );
    console.log(
      JSON.stringify({
        ok: true,
        missingSelectionDetected: true,
        userInputUntouched: true,
        userFocusUntouched: true,
        ordinaryStateWrites: 0,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

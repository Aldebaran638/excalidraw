/* Shared sandbox capture acceptance. No server or alternate preview port. */
/* eslint-disable no-console */
/* global HTMLRuntime */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");

const { buildSync } = require("esbuild");
const { chromium } = require("playwright-core");
(async () => {
  const bundle = buildSync({
    entryPoints: ["excalidraw-app/data/htmlRuntime.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "HTMLRuntime",
  }).outputFiles[0].text;
  const captureScript = await fs.readFile(
    "node_modules/html-to-image/dist/html-to-image.js",
    "utf8",
  );
  const browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    page.on("console", (message) => console.log("browser", message.text()));
    page.on("pageerror", (error) => console.log("pageerror", String(error)));
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.route("**/__runtime-unit", (route) =>
      route.fulfill({ contentType: "text/html", body: "<body></body>" }),
    );
    await page.goto("http://127.0.0.1:3009/__runtime-unit");
    await page.bringToFront();
    await page.addScriptTag({ content: bundle });
    await page.evaluate((captureScript) => {
      const frame = document.createElement("iframe");
      frame.sandbox = "allow-scripts";
      frame.width = "640";
      frame.height = "480";
      window.appFrame = frame;
      window.events = [];
      window.addEventListener("message", (event) => {
        if (event.source === frame.contentWindow) {
          window.events.push(event.data);
        }
      });
      document.body.append(frame);
      frame.srcdoc = HTMLRuntime.htmlBootstrap(
        "capture-test",
        { forms: {}, custom: {} },
        2,
        captureScript,
      );
    }, captureScript);
    await page.waitForFunction(
      () => window.events.some((event) => event.type === "ready"),
      undefined,
      { polling: 100 },
    );
    console.log("ready");
    await page.evaluate(() => {
      const send = (type, data) =>
        window.appFrame.contentWindow.postMessage(
          { token: "capture-test", type, data },
          "*",
        );
      send(
        "append",
        '<main id="app"><h1>源码应用 · 真实快照</h1><input id="task" value="初始值"><svg width="100" height="60"><rect width="100" height="60" fill="#3366ff"/></svg><canvas id="plot" width="100" height="60"></canvas><div id="scroll" style="height:80px;overflow:auto"><div style="height:200px;background:linear-gradient(white,green)">可滚动矩阵</div></div></main>',
      );
    });
    await page.evaluate(() =>
      window.appFrame.contentWindow.postMessage(
        {
          token: "capture-test",
          type: "append",
          data: '<script>(()=>{const task=document.getElementById("task");task.value="导出当前输入，不是初始值";task.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("scroll").scrollTop=80})()</script>',
        },
        "*",
      ),
    );
    await page.evaluate(() =>
      window.appFrame.contentWindow.postMessage(
        { token: "capture-test", type: "finish" },
        "*",
      ),
    );
    await page.waitForFunction(
      () => window.events.some((event) => event.type === "complete"),
      undefined,
      { polling: 100, timeout: 30000 },
    );
    console.log("parser complete");
    const frame = page.frameLocator("iframe");
    // Snapshot fixtures mutate the live canvas after parser completion. Native
    // pointer/keyboard behavior is covered independently by the app replays;
    // this check must prove current pixels, not an initial or cached image.
    await frame.locator("#plot").evaluate((node) => {
      const ctx = node.getContext("2d");
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(0, 0, 100, 60);
    });
    assert.equal(
      await frame.locator("#task").inputValue(),
      "导出当前输入，不是初始值",
    );
    assert.equal(
      await frame.locator("#scroll").evaluate((node) => node.scrollTop),
      80,
    );
    console.log("live state ready");
    await page.evaluate(() =>
      window.appFrame.contentWindow.postMessage(
        { token: "capture-test", type: "capture", requestId: "one" },
        "*",
      ),
    );
    await page.waitForFunction(
      () => window.events.some((event) => event.type === "capture_result"),
      undefined,
      { polling: 100, timeout: 20000 },
    );
    const result = await page.evaluate(
      () => window.events.find((event) => event.type === "capture_result").data,
    );
    console.log("capture received");
    assert.equal(result.error, undefined, result.error);
    assert.ok(result.png.startsWith("data:image/png;base64,"));
    assert.ok(
      result.png.length > 10000,
      "capture must contain rendered content",
    );
    const color = await page.evaluate(async (png) => {
      const image = new Image();
      image.src = png;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      let blue = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 240 && pixels[i + 1] < 20 && pixels[i + 2] < 20) {
          red++;
        }
        if (pixels[i] < 80 && pixels[i + 1] < 130 && pixels[i + 2] > 240) {
          blue++;
        }
      }
      return { red, blue };
    }, result.png);
    await fs.mkdir(".local-data/acceptance/html-source", { recursive: true });
    await fs.writeFile(
      ".local-data/acceptance/html-source/runtime-capture.png",
      Buffer.from(result.png.split(",")[1], "base64"),
    );
    await page.screenshot({
      path: ".local-data/acceptance/html-source/runtime-screen.png",
    });
    console.log("pixels", color);
    assert.ok(color.red > 5000, "Canvas pixels captured");
    assert.ok(color.blue > 5000, "inline SVG captured");
    console.log(
      "PASS shared runtime capture: current forms, Canvas, SVG, scroll",
      color,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

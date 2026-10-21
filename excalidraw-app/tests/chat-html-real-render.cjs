/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildSync } = require("esbuild");
const puppeteer = require("puppeteer-core");
(async () => {
  const root = process.env.TEST_NOTES_DIR;
  assert.ok(root?.startsWith("/tmp/excalidraw-chat-html-"));
  const artifacts = fs
    .readdirSync(root, { recursive: true })
    .filter((file) => file.endsWith("html-v2.json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8")))
    .sort((a, b) => b.createdAt - a.createdAt);
  const artifact = artifacts[0];
  assert.ok(artifact?.complete);
  const bundle = buildSync({
    entryPoints: ["excalidraw-app/data/htmlRuntime.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "HTMLRuntime",
    minify: true,
  }).outputFiles[0].text;
  const browser = await puppeteer.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 900 });
    await page.setContent("<body><h3>真实 Qwen 生成结果</h3></body>");
    await page.addScriptTag({ content: bundle });
    await page.evaluate((source) => {
      const iframe = document.createElement("iframe");
      iframe.width = "700";
      iframe.height = "750";
      iframe.setAttribute("sandbox", "allow-scripts");
      window.events = [];
      window.addEventListener("message", (event) => {
        if (event.source !== iframe.contentWindow) {
          return;
        }
        window.events.push(event.data);
        if (event.data.type === "ready") {
          iframe.contentWindow.postMessage(
            { token: "real", type: "append", data: source },
            "*",
          );
          iframe.contentWindow.postMessage(
            { token: "real", type: "finish" },
            "*",
          );
        }
      });
      document.body.appendChild(iframe);
      iframe.srcdoc = window.HTMLRuntime.htmlBootstrap("real", {
        forms: {},
        custom: {},
      });
    }, artifact.source);
    await page.waitForFunction(
      () => window.events.some((event) => event.type === "complete"),
      { polling: 100 },
    );
    const frame = page.frames().find((frame) => frame.parentFrame());
    assert.equal(
      await frame.$$eval('input[type="number"]', (nodes) => nodes.length),
      2,
    );
    await frame.$$eval('input[type="number"]', (nodes) =>
      nodes.forEach((node, index) => {
        node.value = index ? "8" : "7";
        node.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    );
    assert.match(await frame.$eval("body", (node) => node.innerText), /15/);
    const clear = await frame.evaluate(() => {
      const node = Array.from(document.querySelectorAll("button")).find(
        (node) => node.textContent.includes("清零"),
      );
      if (!node) {
        return null;
      }
      node.scrollIntoView();
      const r = node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    assert.ok(clear);
    const outer = await (await page.$("iframe")).boundingBox();
    // Synchronize the compositor before opaque-iframe pointer input. This also
    // captures the actual model output for visual acceptance.
    await page.screenshot({
      path: "/tmp/chat-html-real-render.png",
      captureBeyondViewport: false,
    });
    await page.mouse.click(outer.x + clear.x, outer.y + clear.y);
    await frame.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('input[type="number"]')).every(
          (node) => Number(node.value) === 0,
        ),
      { polling: 100, timeout: 5000 },
    );
    assert.deepEqual(
      await page.evaluate(() =>
        window.events.filter((event) => event.type === "error"),
      ),
      [],
    );
    console.log(
      "PASS: actual Qwen v2 source rendered, numeric interaction and real mouse clear button, no runtime errors",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

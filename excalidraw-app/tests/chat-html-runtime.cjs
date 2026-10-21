/* eslint-disable no-console */
const assert = require("node:assert/strict");

const { buildSync } = require("esbuild");
const puppeteer = require("puppeteer-core");
(async () => {
  const bundle = buildSync({
    entryPoints: ["excalidraw-app/data/htmlRuntime.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "HTMLRuntime",
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
    page.on("pageerror", (error) => console.error("pageerror", String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.error("console", message.text());
      }
    });
    await page.setContent("<html><body></body></html>");
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      window.events = [];
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      window.appFrame = iframe;
      window.addEventListener("message", (event) => {
        if (event.source === iframe.contentWindow) {
          window.events.push(event.data);
        }
      });
      document.body.appendChild(iframe);
      iframe.srcdoc = window.HTMLRuntime.htmlBootstrap("test", {
        forms: { name: { type: "text", value: "恢复" } },
        custom: { count: 5 },
      });
    });
    await page
      .waitForFunction(
        () => window.events.some((event) => event.type === "ready"),
        { polling: 100, timeout: 10000 },
      )
      .catch(async (error) => {
        console.error(
          "ready diagnostics",
          await page.evaluate(() => window.events),
        );
        throw error;
      });
    const append = (text) =>
      page.evaluate(
        (text) =>
          window.appFrame.contentWindow.postMessage(
            { token: "test", type: "append", data: text },
            "*",
          ),
        text,
      );
    await append(
      "<input id='name'><button id='b'>计数</button><script>window.execs=(window.execs||0)+1;let n=NoteApp.get('count',0);document.getElementById('b').onclick=()=>{NoteApp.set('count',++n);document.getElementById('b').textContent=n};",
    );
    const frame = page.frames().find((frame) => frame.parentFrame());
    await frame.waitForSelector("#name");
    assert.equal(await frame.$eval("#name", (node) => node.value), "恢复");
    assert.equal(await frame.evaluate(() => window.execs), undefined);
    await frame.$eval("#name", (node) => {
      node.value = "输入保留";
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await append("</script><p id='later'>逐步出现</p>");
    await frame
      .waitForSelector("#later", { timeout: 5000 })
      .catch(async (error) => {
        console.error(
          "parser diagnostics",
          await page.evaluate(() => window.events),
          await frame.content(),
        );
        throw error;
      });
    assert.equal(await frame.$eval("#name", (node) => node.value), "输入保留");
    assert.equal(await frame.evaluate(() => window.execs), 1);
    await frame.$eval("#b", (node) => node.click());
    assert.equal(await frame.$eval("#b", (node) => node.textContent), "6");
    assert.equal(
      await frame.evaluate(() => {
        try {
          return parent.document.body.tagName;
        } catch {
          return "isolated";
        }
      }),
      "isolated",
    );
    assert.equal(
      await frame.evaluate(async () => {
        try {
          await fetch("https://example.com/");
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    await page.evaluate(() =>
      window.appFrame.contentWindow.postMessage(
        { token: "test", type: "finish" },
        "*",
      ),
    );
    await page.waitForFunction(() =>
      window.events.some((event) => event.type === "complete"),
    );
    assert.equal(await frame.evaluate(() => window.execs), 1);
    console.log(
      "PASS: native incremental parser, partial-script buffering, live input, state bridge, CSP and opaque origin",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

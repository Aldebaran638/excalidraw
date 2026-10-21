/* Generic runtime contract acceptance; no domain-specific production renderer. */
/* eslint-disable no-console */
/* global HTMLRuntime, NoteApp */
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
    await page.setContent("<body></body>");
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.sandbox = "allow-scripts";
      window.appFrame = frame;
      window.events = [];
      window.addEventListener("message", (event) => {
        if (event.source === frame.contentWindow) {
          window.events.push(event.data);
        }
      });
      document.body.append(frame);
      frame.srcdoc = HTMLRuntime.htmlBootstrap(
        "v2",
        {
          forms: {},
          custom: { saved: "<内容></script>" },
        },
        2,
      );
    });
    await page.waitForFunction(
      () => window.events.some((e) => e.type === "ready"),
      { polling: 100 },
    );
    const frame = page.frames().find((f) => f.parentFrame());
    const append = (text) =>
      page.evaluate(
        (text) =>
          window.appFrame.contentWindow.postMessage(
            { token: "v2", type: "append", data: text },
            "*",
          ),
        text,
      );
    await append(`<main id="app"><h2 id="title">初始标题</h2><input id="task"><button id="start">启动</button><output id="ticks">0</output></main><script>
      NoteApp.once('app',()=>{window.setups=(window.setups||0)+1;return()=>window.cleaned=true});
      NoteApp.on('start','app','click','#start',()=>{NoteApp.set('deadline',Date.now()+60000)});
      NoteApp.interval('clock',()=>{window.clockTicks=(window.clockTicks||0)+1;document.getElementById('ticks').textContent=window.clockTicks},80);
    </script>`);
    await frame.waitForSelector("#start");
    assert.equal(
      await frame.evaluate(() => NoteApp.get("saved")),
      "<内容></script>",
    );
    await frame.evaluate(() => {
      NoteApp.set("object", { count: 1 });
      const value = NoteApp.get("object");
      value.count = 2;
      if (NoteApp.get("object").count !== 1) {
        throw new Error("get leaked mutable state");
      }
      NoteApp.set("object", value);
    });
    await page.waitForFunction(
      () =>
        window.events.some(
          (e) => e.type === "state" && e.data.custom.object?.count === 2,
        ),
      { polling: 100 },
    );
    await frame.$eval("#task", (n) => {
      n.value = "用户正在编辑";
      n.focus();
      n.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await frame.$eval("#start", (n) => n.click());
    const deadline = await frame.evaluate(() => NoteApp.get("deadline"));
    assert.ok(deadline > Date.now());
    // Incomplete ordinary script must never execute prematurely, even with
    // Chinese text, escaped quotes and '<' in its strings.
    const patch = `<script>(()=>{const message='小番茄 \\"<';NoteApp.patch('title',{text:message});NoteApp.patch('app',{style:{'--accent':'#3b9a74',gap:'18px'},appendHtml:'<p id="detail">继续搭建</p>'});})()</script>`;
    for (let i = 0; i < patch.length; i += 7) {
      await append(patch.slice(i, i + 7));
    }
    await frame.waitForSelector("#detail");
    assert.equal(
      await frame.$eval("#title", (n) => n.textContent),
      '小番茄 "<',
    );
    assert.equal(await frame.$eval("#task", (n) => n.value), "用户正在编辑");
    assert.equal(await frame.evaluate(() => document.activeElement.id), "task");
    assert.equal(await frame.evaluate(() => NoteApp.get("deadline")), deadline);
    assert.equal(
      await frame.evaluate(() => document.readyState),
      "loading",
      "visible and interactive before stream completion",
    );
    const rejected = await frame.evaluate(() => [
      NoteApp.patch("app", { text: "replace entire tree" }),
      NoteApp.patch("task", { attrs: { value: "overwrite" } }),
      NoteApp.patch("task", { remove: true }),
      NoteApp.patch("app", { appendHtml: '<b id="title">duplicate</b>' }),
      NoteApp.patch("missing", { text: "unknown" }),
      NoteApp.patch("app", { appendHtml: "<script>window.bad=true</script>" }),
    ]);
    assert.ok(rejected.every((r) => !r.applied));
    await append(`<script>
      NoteApp.once('app',()=>{window.setups++});
      NoteApp.on('start','app','click','#start',()=>{window.actions=(window.actions||0)+1});
      NoteApp.on('start','app','click','#start',()=>{window.actions=(window.actions||0)+2});
      NoteApp.interval('clock',()=>{window.replacedTicks=(window.replacedTicks||0)+1},80);
    </script>`);
    await frame.waitForFunction(() => window.replacedTicks > 1, {
      polling: 100,
    });
    const oldTicks = await frame.evaluate(() => window.clockTicks);
    await frame.$eval("#start", (n) => n.click());
    assert.equal(await frame.evaluate(() => window.actions), 2);
    assert.equal(await frame.evaluate(() => window.setups), 1);
    await page.evaluate(() =>
      window.appFrame.contentWindow.postMessage(
        { token: "v2", type: "finish" },
        "*",
      ),
    );
    await page.waitForFunction(
      () => window.events.some((e) => e.type === "complete"),
      { polling: 100 },
    );
    assert.equal(await frame.evaluate(() => window.clockTicks), oldTicks);
    assert.equal(await frame.$eval("#task", (n) => n.value), "用户正在编辑");
    await page.evaluate(() =>
      window.appFrame.contentWindow.postMessage(
        { token: "v2", type: "dispose" },
        "*",
      ),
    );
    await frame.waitForFunction(() => window.cleaned, { polling: 100 });
    const ticks = await frame.evaluate(() => window.replacedTicks);
    // Wait through several clock periods without a fixed sleep.
    await frame.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 300)),
    );
    assert.equal(await frame.evaluate(() => window.replacedTicks), ticks);
    await frame.$eval("#start", (n) => n.click());
    assert.equal(await frame.evaluate(() => window.actions), 2);
    assert.equal(await frame.evaluate(() => NoteApp.get("deadline")), deadline);
    console.log(
      "PASS: live input/focus/deadline before stream end, split scripts, state escaping, local patches, protected regions, keyed listeners/timer, disposal",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

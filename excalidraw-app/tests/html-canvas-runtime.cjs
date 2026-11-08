/* Canvas-only presentation must not alter source, form state, or timers. */
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
  const browser = await chromium.launch({
    executablePath:
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error("iframe error", error));
    await page.setContent("<body></body>");
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      window.events = [];
      for (const canvas of [true, false]) {
        const frame = document.createElement("iframe");
        frame.sandbox = "allow-scripts";
        frame.id = canvas ? "canvas" : "chat";
        frame.style.cssText = "width:400px;height:500px";
        document.body.append(frame);
        window.addEventListener("message", (e) => {
          if (e.source === frame.contentWindow) {
            window.events.push({ ...e.data, id: frame.id });
          }
        });
        frame.srcdoc = HTMLRuntime.htmlBootstrap(
          frame.id,
          { forms: {}, custom: {} },
          3,
          "",
          frame.id,
          false,
          canvas,
        );
      }
    });
    await page
      .waitForFunction(
        () => window.events.filter((e) => e.type === "ready").length >= 2,
      )
      .catch(async (error) => {
        console.error(
          "bootstrap events",
          await page.evaluate(() => window.events),
        );
        throw error;
      });
    const source = `<style>html,body{background:#ffffff}#app{min-height:calc(100vh - 32px);background:#ffffff}.card{background:#ffffff}</style><main id="app"><div class="card" id="card"><input id="task"><button id="start">启动</button><output id="ticks"></output></div></main><script>window.bootCount=(window.bootCount||0)+1;window.NoteApp.interval('clock',()=>document.getElementById('ticks').textContent=String(window.clockTicks=(window.clockTicks||0)+1),80);window.NoteApp.on('start','app','click','#start',()=>window.NoteApp.set('deadline',Date.now()+60000));</script>`;
    await page.evaluate((source) => {
      for (const id of ["canvas", "chat"]) {
        document
          .getElementById(id)
          .contentWindow.postMessage(
            { token: id, type: "append", data: source },
            "*",
          );
      }
    }, source);
    // Resolve by DOM handle rather than relying on cross-origin frame ordering.
    const frame = await (
      await page.locator("#canvas").elementHandle()
    ).contentFrame();
    const chat = await (
      await page.locator("#chat").elementHandle()
    ).contentFrame();
    await frame.waitForFunction(
      () =>
        getComputedStyle(document.body).backgroundColor ===
          "rgba(0, 0, 0, 0)" &&
        document.getElementById("app").hasAttribute("data-note-canvas-surface"),
    );
    assert.equal(
      await frame
        .locator("#card")
        .evaluate((n) => getComputedStyle(n).backgroundColor),
      "rgb(255, 255, 255)",
    );
    assert.equal(
      await chat
        .locator("body")
        .evaluate((n) => getComputedStyle(n).backgroundColor),
      "rgb(255, 255, 255)",
    );
    await frame.locator("#task").fill("用户输入：不丢失");
    await frame.locator("#start").click();
    const deadline = await frame.evaluate(() => window.NoteApp.get("deadline"));
    for (const transparent of [false, true, false, true]) {
      await page.evaluate(
        (transparent) =>
          document
            .getElementById("canvas")
            .contentWindow.postMessage(
              { token: "canvas", type: "presentation", data: { transparent } },
              "*",
            ),
        transparent,
      );
      await frame.waitForFunction(
        (transparent) =>
          getComputedStyle(document.body).backgroundColor ===
          (transparent ? "rgba(0, 0, 0, 0)" : "rgb(255, 255, 255)"),
        transparent,
      );
      assert.equal(
        await frame.locator("#task").inputValue(),
        "用户输入：不丢失",
      );
      assert.equal(
        await frame.evaluate(() => window.NoteApp.get("deadline")),
        deadline,
      );
      assert.equal(await frame.evaluate(() => window.bootCount), 1);
    }
    await page.evaluate(() => {
      for (const id of ["canvas", "chat"]) {
        document
          .getElementById(id)
          .contentWindow.postMessage({ token: id, type: "finish" }, "*");
      }
    });
    await page.waitForFunction(
      () => window.events.filter((e) => e.type === "complete").length === 2,
    );
    const library = await fs.readFile(
      "node_modules/html-to-image/dist/html-to-image.js",
      "utf8",
    );
    await page.evaluate(
      (library) =>
        document.getElementById("canvas").contentWindow.postMessage(
          {
            token: "canvas",
            type: "capture",
            requestId: "capture",
            data: { library },
          },
          "*",
        ),
      library,
    );
    await page.waitForFunction(() =>
      window.events.some((e) => e.type === "capture_result"),
    );
    const capture = await page.evaluate(
      () => window.events.find((e) => e.type === "capture_result").data,
    );
    assert.ok(!capture.error, capture.error);
    const alpha = await page.evaluate(async (png) => {
      const img = new Image();
      img.src = png;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return [
        ctx.getImageData(2, 2, 1, 1).data[3],
        ctx.getImageData(100, 100, 1, 1).data[3],
      ];
    }, capture.png);
    assert.deepEqual(alpha, [0, 255]);
    await frame.waitForFunction(() => window.clockTicks > 1);
    console.log(
      "PASS: canvas perimeter transparency, inner cards, unchanged chat, live state/timer, expanded restoration, transparent capture",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

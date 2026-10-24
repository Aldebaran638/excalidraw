/* Runtime-only acceptance on the fixed preview origin; no note/chat writes. */
/* eslint-disable no-console */
/* global HTMLRuntime */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");

const { buildSync } = require("esbuild");
const puppeteer = require("puppeteer-core");
(async () => {
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
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    pipe: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(String(error));
      console.log("pageerror", String(error));
    });
    await page.setViewport({ width: 1000, height: 800 });
    await page.setRequestInterception(true);
    page.on(
      "request",
      (request) =>
        void (request.url().endsWith("/__runtime-unit")
          ? request.respond({
              status: 200,
              contentType: "text/html",
              body: "<body></body>",
            })
          : request.continue()),
    );
    await page.goto("http://127.0.0.1:3009/__runtime-unit");
    await page.bringToFront();
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
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
        "overlay-test",
        { forms: {}, custom: {} },
        2,
      );
    });
    await page.waitForFunction(
      () => window.events.some((event) => event.type === "ready"),
      { polling: 100 },
    );
    const frame = await (await page.$("iframe")).contentFrame();
    const append = async (data) =>
      page.evaluate(
        (data) =>
          window.appFrame.contentWindow.postMessage(
            { token: "overlay-test", type: "append", data },
            "*",
          ),
        data,
      );
    await append(
      '<style>html{scrollbar-gutter:stable}#nested{width:230px;height:130px;overflow:auto;scrollbar-gutter:stable;border:1px solid #ccc}#measure{width:100%;height:40px;background:#eee}#content{width:500px;height:400px;background:linear-gradient(#b9d8ff,#c8b9ff)}</style><h2>不挤占空间的滚动条</h2><div id="measure">内容宽度保持不变</div><div id="nested"><div id="content">矩阵：可横向和纵向滚动</div></div>',
    );
    await frame.waitForFunction(
      () => Boolean(document.getElementById("nested")),
      { polling: 100 },
    );
    const initial = await frame.evaluate(() => ({
      width: document.getElementById("measure").clientWidth,
      viewport: innerWidth,
      client: document.documentElement.clientWidth,
      nested: document.getElementById("nested").clientWidth,
      gutter: getComputedStyle(document.getElementById("nested"))
        .scrollbarGutter,
      native: getComputedStyle(document.documentElement).scrollbarWidth,
    }));
    assert.equal(initial.viewport, initial.client);
    assert.equal(initial.nested, 228);
    assert.equal(initial.gutter, "auto");
    assert.equal(initial.native, "none");
    await append(
      '<div style="height:1600px;background:linear-gradient(white,#e6e3ff)">新增长内容</div>',
    );
    await frame.waitForFunction(
      () => document.documentElement.scrollHeight > innerHeight,
      { polling: 100 },
    );
    assert.equal(
      await frame.$eval("#measure", (node) => node.clientWidth),
      initial.width,
    );
    if (process.env.OVERLAY_STREAMING !== "1") {
      await page.evaluate(() =>
        window.appFrame.contentWindow.postMessage(
          { token: "overlay-test", type: "finish" },
          "*",
        ),
      );
      await page.waitForFunction(
        () => window.events.some((event) => event.type === "complete"),
        { polling: 100 },
      );
    }
    await page.screenshot({ path: "/tmp/overlay-before-interaction.png" });
    const frameBox = await (await page.$("iframe")).boundingBox();
    const origin = { x: frameBox.x + 2, y: frameBox.y + 2 };
    const nested = await frame.$eval("#nested", (node) => {
      const r = node.getBoundingClientRect();
      return {
        x: r.x + node.clientLeft,
        y: r.y + node.clientTop,
        width: node.clientWidth,
        height: node.clientHeight,
      };
    });
    await page.mouse.move(origin.x + nested.x + 70, origin.y + nested.y + 40);
    await frame.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.mouse.move(
      origin.x + nested.x + nested.width - 7,
      origin.y + nested.y + 10,
    );
    await page.mouse.down();
    await page.mouse.move(
      origin.x + nested.x + nested.width - 7,
      origin.y + nested.y + 85,
      { steps: 12 },
    );
    await page.mouse.up();
    assert.ok(
      await frame.$eval("#nested", (node) => node.scrollTop > 100),
      "nested vertical thumb can be dragged",
    );
    await page.mouse.move(
      origin.x + nested.x + 12,
      origin.y + nested.y + nested.height - 7,
    );
    await page.mouse.down();
    await page.mouse.move(
      origin.x + nested.x + 150,
      origin.y + nested.y + nested.height - 7,
      { steps: 12 },
    );
    await page.mouse.up();
    assert.ok(
      await frame.$eval("#nested", (node) => node.scrollLeft > 100),
      "nested horizontal thumb can be dragged",
    );
    await page.keyboard.press("Home");
    assert.equal(
      await frame.$eval("#nested", (node) => node.scrollLeft),
      0,
      "focused scrollbar supports keyboard",
    );
    const beforeWheel = await frame.$eval("#nested", (node) => node.scrollTop);
    await page.mouse.wheel({ deltaY: -80 });
    await frame.waitForFunction(
      (before) => document.getElementById("nested").scrollTop < before,
      { polling: 100 },
      beforeWheel,
    );
    assert.equal(
      await frame.evaluate(() => scrollY),
      0,
      "wheel over nested controls does not scroll the page instead",
    );
    await page.mouse.move(origin.x + 633, origin.y + 15);
    await page.mouse.down();
    await page.mouse.move(origin.x + 633, origin.y + 240, { steps: 12 });
    await page.mouse.up();
    assert.ok(
      await frame.evaluate(() => scrollY > 500),
      "document vertical thumb can be dragged",
    );
    assert.equal(
      await frame.$eval("#measure", (node) => node.clientWidth),
      initial.width,
    );
    await frame.evaluate(() => scrollTo(0, 0));
    await page.mouse.move(origin.x + 500, origin.y + 220);
    await page.mouse.wheel({ deltaY: 180 });
    await frame.waitForFunction(() => scrollY > 0, { polling: 100 });
    await frame.evaluate(() => {
      const n = document.getElementById("content");
      n.style.height = "20px";
      n.style.width = "100px";
    });
    await frame.waitForFunction(
      () =>
        document.getElementById("nested").scrollHeight <=
        document.getElementById("nested").clientHeight,
      { polling: 100 },
    );
    assert.equal(
      await frame.$eval("#measure", (node) => node.clientWidth),
      initial.width,
      "removing overflow does not change width",
    );
    assert.equal(
      await frame.evaluate(() =>
        document.body.querySelector("note-scrollbars"),
      ),
      null,
      "overlay controls stay outside exported application body",
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.events.filter(
            (event) => event.type === "state" || event.type === "state_preview",
          ).length,
      ),
      0,
      "scrolling does not save application state",
    );
    await fs.mkdir(".local-data/acceptance/overlay-scrollbars", {
      recursive: true,
    });
    await page.screenshot({
      path: ".local-data/acceptance/overlay-scrollbars/runtime.png",
    });
    if (process.env.OVERLAY_STREAMING === "1") {
      assert.equal(
        await page.evaluate(() =>
          window.events.some((event) => event.type === "complete"),
        ),
        false,
        "interaction was tested before stream completion",
      );
      await page.evaluate(() =>
        window.appFrame.contentWindow.postMessage(
          { token: "overlay-test", type: "finish" },
          "*",
        ),
      );
      await page.waitForFunction(
        () => window.events.some((event) => event.type === "complete"),
        { polling: 100 },
      );
    }
    await page.evaluate(() =>
      window.appFrame.contentWindow.postMessage(
        { token: "overlay-test", type: "dispose" },
        "*",
      ),
    );
    await frame.waitForFunction(
      () => !document.querySelector("note-scrollbars"),
      { polling: 100 },
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS stable content width, document/nested vertical/horizontal thumb drag, wheel, keyboard, no saves, clean disposal",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

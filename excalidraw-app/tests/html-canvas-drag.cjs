/* Real pointer regression, using only uniquely owned fixtures on fixed 3009. */
/* eslint-disable no-console */
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:3009";
const directory = path.resolve(".local-data/preview/notes");
const output = path.resolve(
  process.env.DRAG_OUTPUT || ".local-data/acceptance/html-blank-drag",
);
const fallback =
  '<main id="pom-card" style="width:360px;height:440px;margin:0 auto;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:24px"><h1 id="heading">可拖动卡片</h1><input id="task" value="保留任务"><button id="start">开始</button><output id="count">0</output><input id="range" type="range"><div id="custom" data-note-interactive style="height:35px;background:#a5d8ff"></div><div id="scroller" style="height:60px;overflow:auto"><div style="height:200px">可以滚动</div></div></main><script>window.bootId=Math.random();window.clicks=0;document.addEventListener(\'click\',()=>window.clicks++);document.getElementById(\'start\').onclick=()=>{document.getElementById(\'count\').textContent=Number(document.getElementById(\'count\').textContent)+1};window.ticks=0;setInterval(()=>window.ticks++,200)</script>';
const near = (a, b) => Math.abs(a - b) < 3;
const json = async (url, init) => {
  const r = await fetch(base + url, init);
  assert.ok(r.ok, `${url}: ${r.status}`);
  return r.json();
};
(async () => {
  const noteId = randomUUID();
  const filename = `__blankdrag-${noteId}.excalidraw`;
  let browser;
  await fs.mkdir(output, { recursive: true });
  try {
    for (let n = 0; n < 60; n++) {
      try {
        await json("/api/health");
        break;
      } catch (e) {
        if (n === 59) {
          throw e;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const source = fallback;
    const note = {
      type: "excalidraw",
      version: 2,
      elements: [],
      files: {},
      appState: { scrollX: 0, scrollY: 0, viewBackgroundColor: "#ffffff" },
      repositoryMetadata: { version: 1, noteId },
    };
    await json(`/api/notes/${filename}`, {
      method: "PUT",
      body: JSON.stringify(note),
    });
    const app = await json(`/api/notes/${noteId}/apps`, {
      method: "POST",
      body: JSON.stringify({
        source,
        state: { forms: {}, custom: {} },
        title: "HTML 应用",
      }),
    });
    const common = {
      type: "rectangle",
      angle: 0,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: null,
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
    };
    const element = {
      ...common,
      type: "embeddable",
      id: randomUUID(),
      x: 240,
      y: 180,
      width: 560,
      height: 620,
      link: "https://apps.excalidraw.local/transparency",
      customData: {
        embeddable: {
          frame: "none",
          snapshotRequired: true,
          contentLocked: true,
          keepAlive: true,
          interaction: "controls",
          snapshot:
            '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="620"/>',
        },
        htmlApp: {
          formatVersion: 1,
          appId: app.artifactId,
          version: 1,
          sourceHash: app.sourceHash,
          sourceSnapshot: source,
          title: "HTML 应用",
          runtimeVersion: 3,
          state: { forms: {}, custom: {} },
        },
      },
    };
    const backdrop = {
      ...common,
      id: randomUUID(),
      x: 140,
      y: 160,
      width: 800,
      height: 700,
      backgroundColor: "#a5d8ff",
    };
    const rectangle = {
      ...common,
      id: randomUUID(),
      x: 50,
      y: 300,
      width: 270,
      height: 130,
      strokeColor: "#1e1e1e",
    };
    note.elements = [backdrop, rectangle, element];
    await json(`/api/notes/${filename}`, {
      method: "PUT",
      body: JSON.stringify(note),
    });
    browser = await chromium.launch({
      executablePath:
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
    if (!process.env.DRAG_TOUCH_ONLY) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 1000 },
      });
      const p = await context.newPage();
      await p.addInitScript(
        ({ filename }) => {
          if (window === window.top) {
            localStorage.setItem("aldebaran.repository-note-name", filename);
            localStorage.setItem("excalidraw-theme", "light");
          }
        },
        { filename },
      );
      await p.goto(base, { waitUntil: "domcontentloaded" });
      const root = p.locator(".canvas-html-app");
      await root.waitFor({ timeout: 120000 });
      await root.locator('[data-app-status="complete"]').waitFor();
      const f = p.frameLocator(".canvas-html-app iframe");
      await f.locator("#task").fill("用户输入保持");
      const boot = await f.locator("body").evaluate(() => window.bootId);
      const position = async () => {
        const b = await root.boundingBox();
        return { x: b.x, y: b.y };
      };
      const blank = async () => {
        const b = await f.locator("#pom-card").boundingBox();
        return { x: b.x + 12, y: b.y + 245 };
      };
      const drag = async (dx, dy, cancel = false) => {
        const a = await blank();
        await p.mouse.move(a.x, a.y);
        await p.mouse.down();
        await p.mouse.move(a.x + dx, a.y + dy, { steps: 12 });
        if (cancel) {
          await p.keyboard.press("Escape");
        }
        await p.mouse.up();
        await p.waitForTimeout(150);
      };
      await p.mouse.click(1050, 850);
      const original = await position();
      await p.mouse.move(...Object.values(await blank()));
      assert.equal(
        await f
          .locator("#pom-card")
          .evaluate((el) => getComputedStyle(el).cursor),
        "move",
      );
      await drag(3, 0);
      assert.ok(
        near((await position()).x, original.x),
        "small movement must not drag",
      );
      await p.mouse.click(1050, 850);
      const clicks = await f.locator("body").evaluate(() => window.clicks);
      await drag(80, 45);
      const moved = await position();
      assert.ok(
        near(moved.x, original.x + 80) && near(moved.y, original.y + 45),
        JSON.stringify({ original, moved }),
      );
      assert.equal(
        await f.locator("body").evaluate(() => window.clicks),
        clicks,
        "drag dispatched a click",
      );
      assert.equal(await f.locator("#task").inputValue(), "用户输入保持");
      assert.equal(await f.locator("body").evaluate(() => window.bootId), boot);
      assert.ok((await f.locator("body").evaluate(() => window.ticks)) > 0);
      await p.locator(".excalidraw").focus();
      await p.keyboard.press("Control+z");
      await p.waitForTimeout(150);
      assert.ok(
        near((await position()).x, original.x),
        "one undo must restore origin",
      );
      await p.keyboard.press("Control+Shift+z");
      await p.waitForTimeout(150);
      assert.ok(near((await position()).x, moved.x), "redo");
      await drag(45, 30, true);
      assert.ok(near((await position()).x, moved.x), "escape must cancel");
      await f.locator("#start").click();
      assert.equal(await f.locator("#count").textContent(), "1");
      for (const selector of ["#start", "#task", "#range", "#custom"]) {
        const b = await f.locator(selector).boundingBox();
        const before = await position();
        await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await p.mouse.down();
        await p.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2 + 10, {
          steps: 5,
        });
        await p.mouse.up();
        assert.ok(
          near((await position()).x, before.x),
          `${selector} must not drag app`,
        );
      }
      const heading = await f.locator("#heading").boundingBox();
      await p.mouse.move(heading.x + 3, heading.y + heading.height / 2);
      await p.mouse.down();
      await p.mouse.move(heading.x + 90, heading.y + heading.height / 2, {
        steps: 10,
      });
      await p.mouse.up();
      assert.ok(
        (await f.locator("body").evaluate(() => getSelection().toString()))
          .length > 0,
        "text selection",
      );
      const scroller = await f.locator("#scroller").boundingBox();
      await p.mouse.move(scroller.x + 20, scroller.y + 20);
      await p.mouse.wheel(0, 45);
      await p.waitForTimeout(200);
      assert.ok(
        (await f.locator("#scroller").evaluate((el) => el.scrollTop)) > 0,
        "scrolling",
      );
      await p.screenshot({ path: path.join(output, "mouse.png") });
      console.log(
        "PASS: real mouse blank drag, threshold, click suppression, native undo/redo, escape, controls, text, scroll, live state",
      );
      // A second viewport zoom exercises physical-pixel thresholds and deltas.
      await p.locator(".zoom-out-button").click();
      const zoomBefore = await position();
      await drag(60, 20);
      assert.ok(
        near((await position()).x, zoomBefore.x + 60),
        "zoomed physical delta",
      );
      const spacePoint = await blank();
      await p.mouse.click(spacePoint.x, spacePoint.y);
      await p.keyboard.down("Space");
      await p.locator('.excalidraw[data-embeddable-space="true"]').waitFor();
      await p.keyboard.up("Space");
      await p
        .locator('.excalidraw[data-embeddable-space="true"]')
        .waitFor({ state: "detached" });
      await context.close();
    }
    const touchContext = await browser.newContext({
      viewport: { width: 1000, height: 1000 },
      hasTouch: true,
      isMobile: true,
    });
    const t = await touchContext.newPage();
    await t.addInitScript(
      ({ filename }) => {
        if (window === window.top) {
          localStorage.setItem("aldebaran.repository-note-name", filename);
        }
      },
      { filename },
    );
    await t.goto(base, { waitUntil: "domcontentloaded" });
    const tr = t.locator(".canvas-html-app");
    await tr.waitFor({ timeout: 120000 });
    await tr.locator('[data-app-status="complete"]').waitFor();
    const tf = t.frameLocator(".canvas-html-app iframe");
    const session = await touchContext.newCDPSession(t);
    let card = await tf.locator("#pom-card").boundingBox();
    let tb = await tr.boundingBox();
    const finger = async (type, x, y) =>
      session.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
      });
    const tx = card.x + 12;
    const ty = card.y + 245;
    await finger("touchStart", tx, ty);
    for (let i = 1; i <= 8; i++) {
      await finger("touchMove", tx + 8 * i, ty + 3 * i);
    }
    await finger("touchEnd", tx + 64, ty + 24);
    await t.waitForTimeout(200);
    let ta = await tr.boundingBox();
    assert.ok(
      near(ta.x, tb.x + 64),
      JSON.stringify({ touchBefore: tb, touchAfter: ta }),
    );
    const scroll = await tf.locator("#scroller").boundingBox();
    tb = await tr.boundingBox();
    await tf.locator("body").evaluate(() => {
      window.__scrollDefaults = [];
      for (const type of ["touchstart", "touchmove"]) {
        document.addEventListener(
          type,
          (event) =>
            window.__scrollDefaults.push({
              type,
              prevented: event.defaultPrevented,
            }),
          false,
        );
      }
    });
    await finger("touchStart", scroll.x + 40, scroll.y + 50);
    for (let i = 1; i <= 10; i++) {
      await finger("touchMove", scroll.x + 40, scroll.y + 50 - i * 12);
      await t.waitForTimeout(25);
    }
    await finger("touchEnd", scroll.x + 40, scroll.y - 70);
    await t.waitForTimeout(200);
    ta = await tr.boundingBox();
    assert.ok(near(ta.x, tb.x) && near(ta.y, tb.y), "touch scroll moved app");
    // Headless Chromium's opaque iframe does not scroll in the baseline without
    // this module either. Assert unchanged native event routing, not fake scroll.
    const defaults = await tf
      .locator("body")
      .evaluate(() => window.__scrollDefaults);
    assert.ok(
      defaults.some((event) => event.type === "touchmove"),
      "trusted touch move missing",
    );
    assert.ok(
      defaults.every((event) => !event.prevented),
      "native touch scrolling intercepted",
    );
    card = await tf.locator("#pom-card").boundingBox();
    const pinchBefore = await tr.boundingBox();
    const px = card.x + 12;
    const py = card.y + 100;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: px, y: py, id: 1 }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: px, y: py, id: 1 },
        { x: px, y: py + 60, id: 2 },
      ],
    });
    for (let i = 1; i <= 5; i++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: px, y: py - i * 2, id: 1 },
          { x: px, y: py + 60 + i * 2, id: 2 },
        ],
      });
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await t.waitForTimeout(200);
    assert.ok(
      (await tr.boundingBox()).width > pinchBefore.width + 5,
      "native pinch did not zoom",
    );
    await t.screenshot({ path: path.join(output, "touch.png") });
    console.log(
      "PASS: zoomed deltas, trusted touch blank drag, unblocked touch scroll events and native pinch",
    );
    await touchContext.close();
    if (process.env.DRAG_SOURCE_FILE) {
      const source = await fs.readFile(process.env.DRAG_SOURCE_FILE, "utf8");
      const actual = await json(`/api/notes/${noteId}/apps`, {
        method: "POST",
        body: JSON.stringify({
          source,
          state: { forms: {}, custom: {} },
          title: "番茄钟拖动验收",
        }),
      });
      const copy = JSON.parse(JSON.stringify(note));
      const el = copy.elements.find((e) => e.id === element.id);
      el.customData.htmlApp = {
        ...el.customData.htmlApp,
        appId: actual.artifactId,
        version: actual.version,
        sourceHash: actual.sourceHash,
        sourceSnapshot: source,
      };
      await json(`/api/notes/${filename}`, {
        method: "PUT",
        body: JSON.stringify(copy),
      });
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 1000 },
      });
      const q = await ctx.newPage();
      await q.addInitScript(
        ({ filename }) => {
          if (window === window.top) {
            localStorage.setItem("aldebaran.repository-note-name", filename);
          }
        },
        { filename },
      );
      await q.goto(base, { waitUntil: "domcontentloaded" });
      const qr = q.locator(".canvas-html-app");
      await qr.waitFor({ timeout: 120000 });
      await qr.locator('[data-app-status="complete"]').waitFor();
      const qf = q.frameLocator(".canvas-html-app iframe");
      await qf.locator("#pom-start").click();
      const startText = await qf.locator("#pom-start").textContent();
      await q.evaluate(() => {
        window.__dragFrame = document.querySelector(".canvas-html-app iframe");
      });
      const before = await qr.boundingBox();
      const card = await qf.locator("#pom-card").boundingBox();
      const x = card.x + 10;
      const y = card.y + card.height / 2;
      await q.mouse.move(x, y);
      await q.mouse.down();
      await q.mouse.move(x + 70, y + 35, { steps: 12 });
      await q.mouse.up();
      await q.waitForTimeout(200);
      const after = await qr.boundingBox();
      assert.ok(near(after.x, before.x + 70), "actual pomodoro padding");
      assert.equal(
        await qf.locator("#pom-start").textContent(),
        startText,
        "timer restarted",
      );
      assert.ok(
        await q.evaluate(
          () =>
            window.__dragFrame ===
            document.querySelector(".canvas-html-app iframe"),
        ),
      );
      await q.screenshot({ path: path.join(output, "actual-pomodoro.png") });
      await ctx.close();
      console.log(
        "PASS: actual pomodoro source copy, card padding and running instance preserved",
      );
    }
  } finally {
    await browser?.close();
    await fs.rm(path.join(directory, filename), { force: true });
    for (const kind of [".apps", ".chats"]) {
      await fs.rm(path.join(directory, kind, noteId), {
        force: true,
        recursive: true,
      });
    }
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

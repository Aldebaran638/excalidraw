/* Fixed 3009, uniquely owned fixture only. No Qwen calls. */
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
  process.env.HTML_CANVAS_ACCEPTANCE_OUTPUT ||
    ".local-data/acceptance/html-canvas-presentation",
);
const json = async (url, init) => {
  const response = await fetch(base + url, init);
  const body = await response.json();
  assert.ok(response.ok, JSON.stringify(body));
  return body;
};
const source = `<style>html,body{background:#fff}main{min-height:calc(100vh - 32px);background:#fff}.card{max-width:300px;margin:auto;background:#fff;box-shadow:0 8px 30px #0001;color:#1f2328}h1{font-size:18px}output{display:block;font-size:40px;text-align:center;margin:20px}button{width:100%}button,input{color:var(--text)}</style><main id="app"><section class="card"><h1>番茄钟 · 外观验收</h1><input id="task" placeholder="当前任务"><output id="clock">25:00</output><button id="start">开始</button><button id="count">增加次数</button><p id="total"></p></section></main><script>(()=>{window.bootId=Math.random();const paint=()=>{document.getElementById('total').textContent='已完成 '+window.NoteApp.get('count',0);const deadline=window.NoteApp.get('deadline',0);document.getElementById('clock').textContent=deadline?String(Math.max(0,Math.ceil((deadline-Date.now())/1000))):'25:00'};window.NoteApp.on('start','app','click','#start',()=>{window.NoteApp.set('deadline',Date.now()+1500000);paint()});window.NoteApp.on('count','app','click','#count',()=>{window.NoteApp.set('count',window.NoteApp.get('count',0)+1);paint()});window.NoteApp.interval('clock',paint,1000);paint()})()</script>`;
(async () => {
  const noteId = randomUUID();
  const filename = `__html-chrome-${noteId}.excalidraw`;
  let browser;
  await fs.mkdir(output, { recursive: true });
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await json("/api/health");
        break;
      } catch (error) {
        if (attempt === 59) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
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
    const template = {
      type: "rectangle",
      x: 220,
      y: 160,
      width: 420,
      height: 540,
      angle: 0,
      strokeColor: "#6965db",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
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
      ...template,
      type: "embeddable",
      id: randomUUID(),
      link: "https://apps.excalidraw.local/fixture",
      customData: {
        embeddable: {
          snapshotRequired: true,
          contentLocked: true,
          interaction: "controls",
          keepAlive: true,
          snapshot:
            '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="540"/>',
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
    const behind = {
      ...template,
      id: randomUUID(),
      backgroundColor: "#a5d8ff",
      strokeColor: "transparent",
    };
    note.elements = [behind, element];
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
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
      acceptDownloads: true,
    });
    await page.addInitScript((filename) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", filename);
        delete window.showSaveFilePicker;
        delete window.showOpenFilePicker;
      }
    }, filename);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    const appRoot = page.locator(".canvas-html-app");
    const mountedFrame = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const handle = await appRoot.locator("iframe").elementHandle();
        const value = handle && (await handle.contentFrame());
        if (value) {
          return value;
        }
        await page.waitForTimeout(100);
      }
      throw new Error("iframe 尚未挂载");
    };
    await appRoot.waitFor({ timeout: 120000 });
    let frame = await mountedFrame();
    await frame.locator("#start").waitFor();
    await frame.waitForFunction(
      () =>
        getComputedStyle(document.body).backgroundColor === "rgba(0, 0, 0, 0)",
    );
    assert.equal(
      await appRoot.locator(".canvas-html-app-toolbar").isVisible(),
      false,
    );
    const rect = await appRoot.boundingBox();
    const unselectedFrame = await appRoot.locator("iframe").boundingBox();
    const assertToolbarInside = async (root) => {
      const bounds = await root.boundingBox();
      for (const button of await root
        .locator(".canvas-html-app-toolbar button")
        .all()) {
        const r = await button.boundingBox();
        assert.ok(
          r.x >= bounds.x + 2 &&
            r.y >= bounds.y + 2 &&
            r.x + r.width <= bounds.x + bounds.width - 2 &&
            r.y + r.height <= bounds.y + bounds.height - 2,
          JSON.stringify({ bounds, button: r }),
        );
      }
    };
    // Generated code cannot synthesize a user selection request.
    await frame.locator("h1").evaluate((n) => n.click());
    await page.waitForTimeout(50);
    assert.equal(
      await appRoot.locator(".canvas-html-app-toolbar").isVisible(),
      false,
    );
    await frame.locator("h1").click();
    await page.locator(".canvas-html-app.is-selected").waitFor();
    await page.mouse.click(100, 750);
    await page
      .locator(".canvas-html-app.is-selected")
      .waitFor({ state: "detached" });
    // The first control click both selects and acts, without replaying the action.
    await frame.locator("#start").click();
    await page.locator(".canvas-html-app.is-selected").waitFor();
    await frame.locator("#count").click();
    await page.mouse.click(100, 750);
    await page
      .locator(".canvas-html-app.is-selected")
      .waitFor({ state: "detached" });
    await frame.locator("#task").click();
    await page.locator(".canvas-html-app.is-selected").waitFor();
    assert.equal(
      await frame
        .locator("#task")
        .evaluate((n) => n.ownerDocument.activeElement === n),
      true,
    );
    await frame.locator("#task").fill("用户任务保留");
    assert.equal(
      await frame
        .locator("#task")
        .evaluate((n) => n.ownerDocument.activeElement === n),
      true,
    );
    const state = await frame.evaluate(() => ({
      deadline: window.NoteApp.get("deadline"),
      count: window.NoteApp.get("count"),
      boot: window.bootId,
    }));
    assert.ok(state.deadline);
    assert.equal(state.count, 1);
    await page.evaluate(
      () =>
        (window.__canvasFrame = document.querySelector(
          ".canvas-html-app iframe",
        )),
    );
    await assertToolbarInside(appRoot);
    await page.locator(".canvas-html-app.is-selected").waitFor();
    assert.equal(
      await appRoot.locator(".canvas-html-app-toolbar").isVisible(),
      true,
    );
    const buttons = appRoot.locator(".canvas-html-app-toolbar button");
    assert.deepEqual(
      await buttons.evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("aria-label")),
      ),
      ["放大试用", "在聊天中修改", "重新运行"],
    );
    assert.equal(
      await buttons.evaluateAll((nodes) =>
        nodes.every((n) => !n.textContent.trim()),
      ),
      true,
    );
    assert.deepEqual(
      await appRoot.locator("iframe").boundingBox(),
      unselectedFrame,
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.__canvasFrame ===
          document.querySelector(".canvas-html-app iframe"),
      ),
      true,
    );
    await buttons.first().hover();
    await page.screenshot({ path: path.join(output, "selected.png") });
    await appRoot.locator('[aria-label="在聊天中修改"]').focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await appRoot
        .locator('[aria-label="在聊天中修改"]')
        .evaluate((n) => n.matches(":focus-visible")),
      true,
    );
    const iconWidth = (
      await appRoot.locator('[aria-label="重新运行"]').boundingBox()
    ).width;
    await page.locator(".zoom-out-button").click();
    await assertToolbarInside(appRoot);
    assert.ok(
      Math.abs(
        (await appRoot.locator('[aria-label="重新运行"]').boundingBox()).width -
          iconWidth,
      ) < 1,
    );
    await page.locator(".zoom-in-button").click();
    assert.equal(await frame.evaluate(() => window.bootId), state.boot);

    await appRoot.locator('[aria-label="放大试用"]').click();
    await page.locator(".note-chat-html-dialog.is-expanded").waitFor();
    await frame.waitForFunction(
      () =>
        getComputedStyle(document.body).backgroundColor ===
        "rgb(255, 255, 255)",
    );
    await page.locator('[aria-label="关闭放大"]').hover();
    const tooltip = await page
      .locator('[aria-label="关闭放大"]')
      .evaluate((n) => {
        const css = n.ownerDocument.defaultView.getComputedStyle(n, "::after");
        const r = n.getBoundingClientRect();
        const d = n.closest("dialog").getBoundingClientRect();
        return {
          top: r.top + parseFloat(css.top),
          bottom: r.top + parseFloat(css.top) + parseFloat(css.height),
          dialogTop: d.top,
          dialogBottom: d.bottom,
          opacity: css.opacity,
          content: css.content,
          width: parseFloat(css.width),
          height: parseFloat(css.height),
        };
      });
    assert.equal(tooltip.opacity, "1");
    assert.ok(
      tooltip.width >= 48 && tooltip.height < 40,
      JSON.stringify(tooltip),
    );
    assert.ok(
      tooltip.top > tooltip.dialogTop && tooltip.bottom < tooltip.dialogBottom,
      JSON.stringify(tooltip),
    );
    await page.screenshot({ path: path.join(output, "expanded.png") });
    await page.locator('[aria-label="关闭放大"]').click();
    await page
      .locator(".note-chat-html-dialog.is-expanded")
      .waitFor({ state: "detached" });
    await frame.waitForFunction(
      () =>
        getComputedStyle(document.body).backgroundColor === "rgba(0, 0, 0, 0)",
    );
    assert.equal(await frame.evaluate(() => window.bootId), state.boot);
    assert.equal(await frame.locator("#task").inputValue(), "用户任务保留");
    assert.equal(
      await frame.evaluate(() => window.NoteApp.get("deadline")),
      state.deadline,
    );
    // Actual native drag handle still works, rather than a simulated DOM event.
    await page.mouse.move(rect.x + 60, rect.y + 15);
    await page.mouse.down();
    await page.mouse.move(rect.x + 90, rect.y + 45, { steps: 8 });
    await page.mouse.up();
    const moved = await appRoot.boundingBox();
    assert.ok(moved.x > rect.x + 20 && moved.y > rect.y + 20);
    await appRoot.locator('[aria-label="重新运行"]').click();
    await page.waitForFunction(
      () =>
        window.__canvasFrame !==
        document.querySelector(".canvas-html-app iframe"),
    );
    frame = await mountedFrame();
    await frame.locator("#start").waitFor();
    assert.equal(await frame.locator("#task").inputValue(), "用户任务保留");
    assert.equal(await frame.evaluate(() => window.NoteApp.get("count")), 1);
    assert.equal(
      await frame.evaluate(() => window.NoteApp.get("deadline")),
      state.deadline,
    );
    await page.mouse.click(100, 700);
    await page
      .locator(".canvas-html-app.is-selected")
      .waitFor({ state: "detached" });
    await page.screenshot({ path: path.join(output, "unselected.png") });
    // Native exports must keep the underlying blue shape visible in the perimeter.
    await page.locator('[data-testid="main-menu-trigger"]').click();
    await page.locator('[data-testid="image-export-button"]').click();
    for (const format of ["PNG", "SVG"]) {
      const downloading = page.waitForEvent("download", { timeout: 60000 });
      await page
        .getByRole("button", { name: `Export to ${format}`, exact: true })
        .click();
      const download = await downloading;
      await download.saveAs(
        path.join(output, `canvas.${format.toLowerCase()}`),
      );
    }
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await appRoot.locator("iframe").waitFor({ timeout: 60000 });
    frame = await mountedFrame();
    await frame.locator("#start").waitFor();
    assert.equal(await frame.locator("#task").inputValue(), "用户任务保留");
    await page.keyboard.press("Alt+Shift+D");
    await page.setViewportSize({ width: 430, height: 900 });
    await page.screenshot({ path: path.join(output, "narrow-dark.png") });
    const latest = await json(`/api/notes/${filename}`);
    const persisted = latest.elements.find((e) => e.id === element.id);
    assert.equal(persisted.strokeColor, "#6965db");
    assert.equal(persisted.customData.htmlApp.sourceSnapshot, source);
    // Touch + genuinely narrow viewport, still using only our own test note.
    await page.close();
    latest.elements = latest.elements.map((e) =>
      e.id === element.id
        ? {
            ...e,
            x: 30,
            y: 160,
            width: 230,
            version: e.version + 1,
            versionNonce: e.versionNonce + 1,
          }
        : e,
    );
    latest.appState = {
      ...latest.appState,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
    };
    await json(`/api/notes/${filename}`, {
      method: "PUT",
      body: JSON.stringify(latest),
    });
    const mobile = await browser.newContext({
      viewport: { width: 430, height: 900 },
      isMobile: true,
      hasTouch: true,
    });
    const touch = await mobile.newPage();
    await touch.addInitScript((filename) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", filename);
      }
    }, filename);
    await touch.addInitScript(() => {
      window.__interactionEvents = [];
      window.addEventListener("message", (e) => {
        if (e.data?.type === "interact") {
          window.__interactionEvents.push(e.data.data);
        }
      });
    });
    await touch.goto(base, { waitUntil: "domcontentloaded" });
    const touchRoot = touch.locator(".canvas-html-app");
    await touchRoot.locator("iframe").waitFor({ timeout: 60000 });
    await touch
      .frameLocator(".canvas-html-app iframe")
      .locator("#start")
      .waitFor();
    const heading = await touch
      .frameLocator(".canvas-html-app iframe")
      .locator("h1")
      .boundingBox();
    const cdp = await mobile.newCDPSession(touch);
    const point = {
      x: heading.x + heading.width / 2,
      y: heading.y + heading.height / 2,
    };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: point.x, y: point.y - 35 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await touch.waitForTimeout(100);
    assert.equal(
      await touchRoot.locator(".canvas-html-app-toolbar").isVisible(),
      false,
    );
    await cdp.detach();
    await touch.frameLocator(".canvas-html-app iframe").locator("h1").tap();
    await touchRoot
      .locator(".canvas-html-app-toolbar")
      .waitFor({ state: "visible" })
      .catch(async (error) => {
        console.error(
          "touch selection diagnostics",
          await touchRoot.evaluate((n) => ({
            classes: n.className,
            enabled: n
              .closest("[data-embeddable-controls-enabled]")
              ?.getAttribute("data-embeddable-controls-enabled"),
            events: window.__interactionEvents,
            tool: [
              ...n.ownerDocument.querySelectorAll(
                ".ToolIcon_type_radio input:checked",
              ),
            ].map((e) => e.value),
          })),
        );
        await touch.screenshot({ path: path.join(output, "touch-error.png") });
        throw error;
      });
    await assertToolbarInside(touchRoot);
    for (const bounds of await touchRoot
      .locator(".canvas-html-app-toolbar button")
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { width: r.width, height: r.height };
        }),
      )) {
      assert.ok(bounds.width >= 43.9 && bounds.height >= 43.9);
    }
    await touch.locator(".excalidraw").focus();
    await touch.keyboard.press("Alt+Shift+D");
    await touch.locator(".excalidraw.theme--dark").waitFor();
    await touch.waitForTimeout(750);
    await touch.screenshot({
      path: path.join(output, "touch-narrow-dark.png"),
    });
    await touchRoot.locator('[aria-label="在聊天中修改"]').tap();
    await touch.locator(".note-chat").waitFor({ state: "visible" });
    assert.equal(
      await touchRoot
        .locator('[aria-label="重新运行"]')
        .getAttribute("aria-label"),
      "重新运行",
    );
    await mobile.close();

    console.log(
      "PASS: card/control/input/touch selection, controls act once, button bounds at zoom, close tooltip visible, same live iframe, drag + state + exports + dark/narrow",
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
    await fs.rm(path.join(directory, filename), { force: true });
    await fs.rm(path.join(directory, ".apps", noteId), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(directory, ".chats", noteId), {
      recursive: true,
      force: true,
    });
  }
})();

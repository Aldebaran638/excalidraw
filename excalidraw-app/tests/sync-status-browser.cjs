/* Fixed 3009; real save flow plus browser-local failures. No model requests. */
/* eslint-disable no-console */
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:3009";
const directory = path.resolve(".local-data/preview/notes");
const output = path.resolve(".local-data/acceptance/compact-sync-status");
const name = `__compact-sync-${randomUUID()}.excalidraw`;
const noteId = randomUUID();
const json = async (url, init) => {
  const r = await fetch(base + url, init);
  assert.ok(r.ok, `${r.status}: ${url}`);
  return r.json();
};
(async () => {
  let browser;
  const results = [];
  try {
    await fs.mkdir(output, { recursive: true });
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
    await json(`/api/notes/${name}`, {
      method: "PUT",
      body: JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [],
        appState: {},
        files: {},
        repositoryMetadata: { version: 1, noteId },
      }),
    });
    browser = await chromium.launch({
      executablePath:
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    await page.addInitScript((name) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", name);
      }
    }, name);
    let mode = "ok";
    let releaseWrite;
    const hold = () =>
      new Promise((resolve) => {
        releaseWrite = resolve;
      });
    await page.route(`**/api/notes/${name}`, async (route) => {
      if (route.request().method() !== "PUT") {
        return route.continue();
      }
      if (mode === "hold") {
        await hold();
      }
      await route.continue();
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    const badge = page.locator(".RepositorySyncStatus:visible");
    const measure = async (state) => {
      const status = await badge.boundingBox();
      const toolbar = await page
        .locator(".App-toolbar:visible")
        .first()
        .boundingBox();
      const right = await page
        .locator(".excalidraw-ui-top-right:visible")
        .first()
        .boundingBox();
      assert.equal(status.width, 36);
      assert.equal(status.height, 36);
      const value = { state, status, toolbar, right };
      results.push(value);
      return value;
    };
    await page
      .locator(".RepositorySyncStatus--synced:visible")
      .waitFor({ timeout: 120000 });
    const baseline = await measure("synced");
    const stable = async (state) => {
      const current = await measure(state);
      for (const key of ["status", "toolbar", "right"]) {
        for (const metric of ["x", "y", "width", "height"]) {
          assert.ok(
            Math.abs(current[key][metric] - baseline[key][metric]) < 0.6,
            JSON.stringify({
              state,
              key,
              metric,
              current: current[key],
              baseline: baseline[key],
            }),
          );
        }
      }
    };
    const draw = async (x) => {
      await page.locator('[data-testid="toolbar-rectangle"]:visible').click();
      await page.mouse.move(x, 300);
      await page.mouse.down();
      await page.mouse.move(x + 90, 390, { steps: 4 });
      await page.mouse.up();
      await page.keyboard.press("v");
    };
    mode = "hold";
    await draw(300);
    await page.locator(".RepositorySyncStatus--pending:visible").waitFor();
    await stable("pending");
    await page.locator(".RepositorySyncStatus--syncing:visible").waitFor();
    await stable("syncing");
    await page.screenshot({ path: path.join(output, "syncing.png") });
    mode = "ok";
    releaseWrite();
    await page.locator(".RepositorySyncStatus--synced:visible").waitFor();
    await stable("saved");
    await badge.focus();
    const tooltip = page.locator(
      ".RepositorySyncStatus:visible [role=tooltip]",
    );
    await tooltip.waitFor({ state: "visible" });
    assert.ok((await tooltip.innerText()).length > 0);
    await page.screenshot({ path: path.join(output, "saved-focus.png") });
    await context.close();

    // Read failure and retry use the exact same slot, including on touch screens.
    for (const touch of [false, true]) {
      const c = await browser.newContext({
        viewport: touch
          ? { width: 430, height: 900 }
          : { width: 1440, height: 1000 },
        isMobile: touch,
        hasTouch: touch,
      });
      const p = await c.newPage();
      await p.addInitScript((name) => {
        if (window === window.top) {
          localStorage.setItem("aldebaran.repository-note-name", name);
        }
      }, name);
      let failRead = true;
      let releaseRead;
      await p.route(`**/api/notes/${name}`, async (route) => {
        if (route.request().method() !== "GET") {
          return route.continue();
        }
        if (failRead) {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "own browser read failure" }),
          });
        }
        await new Promise((resolve) => {
          releaseRead = resolve;
        });
        return route.continue();
      });
      await p.goto(base, { waitUntil: "domcontentloaded" });
      const slot = p.locator(".RepositorySyncStatus:visible");
      const retry = slot.locator("button");
      await retry.waitFor({ timeout: 120000 });
      const before = await slot.boundingBox();
      assert.equal(before.width, touch ? 44 : 36);
      assert.equal(before.height, touch ? 44 : 36);
      failRead = false;
      if (touch) {
        await retry.tap();
      } else {
        await retry.click();
      }
      await p.waitForFunction(() =>
        [...document.querySelectorAll(".RepositorySyncStatus__retry")].some(
          (n) => n.disabled,
        ),
      );
      const during = await slot.boundingBox();
      assert.deepEqual(during, before);
      assert.equal(await retry.getAttribute("aria-label"), "读取中…");
      await p.waitForTimeout(100);
      assert.ok(releaseRead);
      releaseRead();
      await p.waitForFunction(() =>
        [...document.querySelectorAll(".RepositorySyncStatus")].some(
          (n) =>
            n.getBoundingClientRect().width > 0 && !n.querySelector("button"),
        ),
      );
      assert.deepEqual(await slot.boundingBox(), before);
      await slot.focus();
      if (touch) {
        await p.locator(".excalidraw").focus();
        await p.keyboard.press("Alt+Shift+D");
        await p.locator(".excalidraw.theme--dark").waitFor();
        await slot.focus();
      }
      await slot.locator("[role=tooltip]").waitFor({ state: "visible" });
      await p.screenshot({
        path: path.join(output, touch ? "touch-dark.png" : "retry.png"),
      });
      results.push({
        state: touch ? "touch-retry" : "retry",
        before,
        during,
        after: await slot.boundingBox(),
      });
      await c.close();
    }
    await fs.writeFile(
      path.join(output, "result.json"),
      JSON.stringify(results, null, 2),
    );
    console.log(
      `PASS: ${results.length} status measurements, fixed 36px/44px slots, stable toolbar, focus tooltip and real retry`,
    );
  } finally {
    await browser?.close();
    await fs.rm(path.join(directory, name), { force: true });
    await fs.rm(path.join(directory, ".chats", noteId), {
      force: true,
      recursive: true,
    });
    await fs.rm(path.join(directory, ".apps", noteId), {
      force: true,
      recursive: true,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

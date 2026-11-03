/* Fixed 3009; real placement and cancellation, no model calls. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { chromium } = require("playwright-core");

const base = "http://127.0.0.1:3009";
const directory = path.resolve(".local-data/preview/notes");
const output = ".local-data/acceptance/canvas-action-hint";
async function json(url, init) {
  const response = await fetch(base + url, init);
  assert.ok(response.ok, `HTTP ${response.status}: ${url}`);
  return response.json();
}
(async () => {
  const noteId = randomUUID();
  const filename = `__canvas-hint-${noteId}.excalidraw`;
  let browser;
  let page;
  try {
    await json(`/api/notes/${filename}`, {
      method: "PUT",
      body: JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [],
        files: {},
        appState: {},
        repositoryMetadata: { version: 1, noteId },
      }),
    });
    const session = await json(`/api/notes/${noteId}/chats`, {
      method: "POST",
    });
    const artifactId = randomUUID();
    const ref = { kind: "html", artifactId, version: 1 };
    const root = path.join(directory, ".chats", noteId);
    const artifact = path.join(root, "artifacts", session.id, artifactId);
    await fs.mkdir(artifact, { recursive: true });
    session.messages = [
      {
        id: randomUUID(),
        turnId: randomUUID(),
        role: "assistant",
        content: "放置体验验收",
        status: "complete",
        createdAt: Date.now(),
        blocks: [
          {
            id: randomUUID(),
            type: "html",
            ref,
            runtimeVersion: 3,
            complete: true,
            saved: true,
          },
        ],
      },
    ];
    await fs.writeFile(
      path.join(root, `${session.id}.json`),
      JSON.stringify(session),
    );
    await fs.writeFile(
      path.join(artifact, "html-v1.json"),
      JSON.stringify({
        ...ref,
        noteId,
        sessionId: session.id,
        title: "放置样例",
        source:
          '<main id="app"><h1>放置样例</h1><p>只验证原生放置，不调用模型。</p></main>',
        complete: true,
        runtimeVersion: 3,
        revision: 0,
        state: { forms: {}, custom: {} },
        createdAt: Date.now(),
      }),
    );
    browser = await chromium.launch({
      executablePath:
        process.env.BROWSER_EXECUTABLE ||
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-proxy-server",
        "--disable-gpu",
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    async function open(context) {
      const next = await context.newPage();
      next.setDefaultTimeout(30000);
      await next.addInitScript((name) => {
        if (window === window.top) {
          localStorage.setItem("aldebaran.repository-note-name", name);
        }
      }, filename);
      await next.goto(base, { waitUntil: "domcontentloaded" });
      if (next.viewportSize().width <= 730) {
        await next.getByTestId("main-menu-trigger").click({ timeout: 120000 });
        await next
          .locator(".dropdown-menu-item")
          .filter({ hasText: "笔记聊天" })
          .click();
      } else {
        await next
          .getByRole("button", { name: "打开笔记聊天", exact: true })
          .click({ timeout: 120000 });
      }
      await next
        .getByRole("button", { name: "导入笔记", exact: true })
        .waitFor();
      return next;
    }
    page = await open(context);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const hint = page.locator(".canvas-action-hint");
    async function start() {
      await page.getByRole("button", { name: "导入笔记", exact: true }).click();
      await hint.waitFor();
    }
    async function geometry(target, touch = false) {
      return target.locator(".canvas-action-hint").evaluate((node, touch) => {
        const content = node.querySelector(".canvas-action-hint__content");
        const button = node.querySelector("button");
        const range = button.ownerDocument.createRange();
        range.selectNodeContents(button);
        const rect = content.getBoundingClientRect();
        const b = button.getBoundingClientRect();
        const s = range.getBoundingClientRect();
        const copy = node
          .querySelector(".canvas-action-hint__message")
          .getBoundingClientRect();
        const style = node.ownerDocument.defaultView.getComputedStyle(content);
        return {
          border: style.borderTopWidth,
          background: style.backgroundColor,
          shadow: style.boxShadow,
          blur: style.backdropFilter,
          inside:
            s.left >= b.left &&
            s.top >= b.top &&
            s.right <= b.right &&
            s.bottom <= b.bottom,
          buttonSize:
            b.width >= (touch ? 44 : 32) && b.height >= (touch ? 44 : 32),
          copyInside:
            copy.left >= rect.left &&
            copy.right <= b.left &&
            copy.top >= rect.top &&
            copy.bottom <= rect.bottom,
          noOverflow:
            content.scrollWidth <= content.clientWidth &&
            content.scrollHeight <= content.clientHeight,
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
        };
      }, touch);
    }
    await start();
    const wide = await geometry(page);
    assert.equal(wide.border, "0px");
    assert.equal(wide.background, "rgba(0, 0, 0, 0)");
    assert.equal(wide.shadow, "none");
    assert.equal(wide.blur, "none");
    assert.equal(await hint.locator("svg").count(), 0);
    assert.equal(await hint.getByRole("button").textContent(), "取消");
    assert.ok(
      wide.inside && wide.buttonSize && wide.copyInside && wide.noOverflow,
    );
    assert.ok(
      wide.right <= (await page.locator(".app-sidebar").boundingBox()).x,
      "guidance belongs to the available canvas",
    );
    assert.equal(
      await page
        .locator(".Toast")
        .filter({ hasText: /拖框放置/ })
        .count(),
      0,
      "one operation has one instruction",
    );
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: `${output}/desktop.png`, timeout: 15000 });
    const handle = await page
      .locator(".app-sidebar-resize-handle")
      .boundingBox();
    await page.mouse.move(handle.x + 3, handle.y + 150);
    await page.mouse.down();
    await page.mouse.move(900, handle.y + 150, { steps: 8 });
    await page.mouse.up();
    await page.setViewportSize({ width: 900, height: 800 });
    const narrow = await geometry(page);
    assert.ok(
      narrow.inside &&
        narrow.buttonSize &&
        narrow.copyInside &&
        narrow.noOverflow,
    );
    assert.ok(
      narrow.right <= (await page.locator(".app-sidebar").boundingBox()).x,
      "resized sidebar must not cover the cancel action",
    );
    await hint.locator(".canvas-action-hint__message").evaluate((node) => {
      node.textContent =
        "区域已预留，请在聊天中生成应用后再导入。超长说明与VeryLongUnbrokenTextForLayoutValidation必须自然换行。";
    });
    const long = await geometry(page);
    assert.ok(
      long.inside && long.buttonSize && long.copyInside && long.noOverflow,
    );
    await page.getByRole("button", { name: "取消放置", exact: true }).click();
    await hint.waitFor({ state: "detached" });
    assert.equal(await page.locator(".canvas-html-app").count(), 0);
    async function noResult(target = page) {
      assert.equal(
        await target.getByText(/^(已取消放置|已放置|再试一次)$/).count(),
        0,
      );
      assert.equal(
        await target
          .locator(".Toast")
          .filter({ hasText: /取消|放置/ })
          .count(),
        0,
      );
    }
    await noResult();
    await start();
    await page.keyboard.press("Escape");
    await hint.waitFor({ state: "detached" });
    await noResult();
    assert.equal(
      (await json(`/api/notes/${filename}`)).elements.filter(
        (item) => !item.isDeleted,
      ).length,
      0,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const key of ["Enter", "Space"]) {
      await start();
      await page.getByRole("button", { name: "取消放置", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      assert.equal(
        await page
          .getByRole("button", { name: "取消放置", exact: true })
          .evaluate((node) => node.ownerDocument.activeElement === node),
        true,
      );
      await page.keyboard.press(key);
      await hint.waitFor({ state: "detached" });
      await noResult();
    }
    await page.mouse.click(250, 100);
    await page.keyboard.press("Shift+Alt+d");
    await page.locator(".excalidraw.theme--dark").waitFor();
    await start();
    await page.screenshot({
      path: `${output}/desktop-dark.png`,
      timeout: 15000,
    });
    await page.getByRole("button", { name: "取消放置", exact: true }).click();

    const mobile = await browser.newContext({
      viewport: { width: 430, height: 900 },
      hasTouch: true,
    });
    const phone = await open(mobile);
    await phone.getByRole("button", { name: "导入笔记", exact: true }).click();
    await phone.locator(".canvas-action-hint").waitFor();
    const touch = await geometry(phone, true);
    assert.ok(
      touch.inside && touch.buttonSize && touch.copyInside && touch.noOverflow,
    );
    const panel = await phone.locator(".app-sidebar").boundingBox();
    assert.ok(
      touch.bottom <= panel.y,
      "phone hint must stay above the bottom sidebar",
    );
    await phone.screenshot({ path: `${output}/mobile.png`, timeout: 15000 });
    await phone.getByRole("button", { name: "取消放置", exact: true }).tap();
    await phone.locator(".canvas-action-hint").waitFor({ state: "detached" });
    await noResult(phone);
    await mobile.close();

    await start();
    await page.mouse.move(100, 200);
    await page.mouse.down();
    await page.mouse.move(650, 640, { steps: 10 });
    await page.mouse.up();
    await hint.waitFor({ state: "detached" });
    await page.locator(".canvas-html-app iframe").waitFor();
    assert.equal(await page.locator(".canvas-html-app").count(), 1);
    await noResult();
    await page.mouse.click(750, 150);
    await page.keyboard.press("Control+z");
    await page.locator(".canvas-html-app").waitFor({ state: "detached" });
    await page.keyboard.press("Control+Shift+z");
    await page.locator(".canvas-html-app").waitFor();
    assert.equal(await hint.count(), 0);
    await noResult();
    assert.deepEqual(errors, []);
    console.log(
      "PASS plain-text guidance, label bounds, sidebar resize, narrow layout, click/Esc/Enter/Space/touch cancellation, no result notices, dark/light, mobile avoidance and native placement",
    );
  } catch (error) {
    await fs.mkdir(output, { recursive: true });
    await page
      ?.screenshot({ path: `${output}/failure.png`, timeout: 10000 })
      .catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    await fs.unlink(path.join(directory, filename)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await fs.rm(path.join(directory, ".chats", noteId), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(directory, ".apps", noteId), {
      recursive: true,
      force: true,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/* Called only by the serial real-model runner; owns no application server. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const path = require("node:path");

const { chromium } = require("playwright-core");

module.exports = async function verifyCanvas({
  base,
  filename,
  endpoint,
  cycle,
  kind,
  output,
}) {
  const browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-proxy-server",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const imports = [];
  page.on("response", (response) => {
    if (
      response.url().includes("/apps") &&
      response.request().method() === "POST"
    ) {
      imports.push({ url: response.url(), status: response.status() });
    }
  });
  const json = async (url) => {
    const response = await fetch(base + url);
    assert.ok(response.ok, `HTTP ${response.status}`);
    return response.json();
  };
  const canvasFrame = async () => {
    await page
      .frameLocator(".canvas-html-app iframe")
      .locator("body")
      .waitFor({ timeout: 60000 });
    for (let attempt = 0; attempt < 100; attempt++) {
      const handle = await page
        .locator(".canvas-html-app iframe")
        .elementHandle();
      const frame = handle && (await handle.contentFrame());
      if (frame) {
        return frame;
      }
      await page.waitForTimeout(100);
    }
    throw new Error("画布应用运行实例尚未挂载");
  };
  try {
    await page.addInitScript((filename) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", filename);
      }
    }, filename);
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page
      .locator('[aria-label="打开笔记聊天"]')
      .click({ timeout: 120000 });
    const importButton = page
      .locator('.note-chat-html-card [aria-label="导入笔记"]')
      .last();
    await importButton.waitFor({ state: "visible", timeout: 60000 });
    const trialHandle = await page
      .locator(".note-chat-html-card iframe")
      .last()
      .elementHandle();
    const trialFrame = trialHandle && (await trialHandle.contentFrame());
    if (trialFrame) {
      await trialFrame.waitForFunction(
        (title) => document.body?.textContent?.includes(title),
        `Pi验收-${cycle}-${kind}-第2次修改`,
        { timeout: 60000 },
      );
    }
    await importButton.click();
    await page
      .locator(".canvas-action-hint")
      .waitFor({ state: "visible", timeout: 120000 });
    await page.mouse.move(100, 180);
    await page.mouse.down();
    await page.mouse.move(900, 780, { steps: 16 });
    await page.mouse.up();
    await page.locator(".canvas-html-app iframe").waitFor({ timeout: 60000 });
    const beforeFrame = page.frameLocator(".canvas-html-app iframe");
    await beforeFrame.locator("body").waitFor();
    const beforeText = await beforeFrame.locator("body").innerText();
    assert.ok(beforeText.includes(`Pi验收-${cycle}-${kind}-第2次修改`));
    await page.waitForFunction(
      () => !document.querySelector(".canvas-action-hint"),
    );
    await page.screenshot({
      path: path.join(output, `${cycle}-${kind}-import.png`),
    });
    // State bridge probe is independent of model-chosen key names.
    const canvas = await canvasFrame();
    await canvas.evaluate(() => window.NoteApp.set("pi_acceptance", 41));
    await page.waitForTimeout(1200);
    const note = await json(`/api/notes/${filename}`);
    const element = note.elements.find(
      (element) => !element.isDeleted && element.customData?.htmlApp,
    );
    assert.ok(element, "native embeddable must be saved");
    const originalId = element.id;
    const title = `Pi画布-${cycle}-${kind}-已确认`;
    await page
      .getByRole("textbox", { name: "聊天消息", exact: true })
      .fill(
        `请修改当前引用的画布组件，只将主标题改为“${title}”，保留其他代码和NoteApp状态。真实读取源码后局部编辑，不重新输出HTML。`,
      );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page
      .locator('[aria-label="确认应用修改"]')
      .last()
      .waitFor({ state: "visible", timeout: 620000 });
    await page
      .getByRole("button", { name: "停止回答", exact: true })
      .waitFor({ state: "detached", timeout: 620000 });
    const session = await json(endpoint);
    const assistant = session.messages.at(-1);
    assert.equal(assistant.status, "complete", assistant.error);
    assert.ok(
      assistant.activities.some(
        (activity) =>
          activity.name === "read_app_source" && activity.status === "complete",
      ),
    );
    assert.ok(
      assistant.activities.some(
        (activity) =>
          activity.name === "edit_app_source" && activity.status === "complete",
      ),
    );
    assert.ok(
      (await canvas.locator("body").innerText()).includes(
        `Pi验收-${cycle}-${kind}-第2次修改`,
      ),
      "candidate must not change formal component",
    );
    await page.evaluate(() => {
      window.__piPreviousFrame = document.querySelector(
        ".canvas-html-app iframe",
      );
    });
    await page.locator('[aria-label="确认应用修改"]').last().click();
    await page.waitForFunction(() => {
      const iframe = document.querySelector(".canvas-html-app iframe");
      return iframe && iframe !== window.__piPreviousFrame;
    });
    await page.waitForTimeout(1200);
    const modified = await canvasFrame();
    await modified.waitForFunction(
      (title) => document.body.textContent.includes(title),
      title,
      { timeout: 60000 },
    );
    assert.equal(
      await modified.evaluate(() => window.NoteApp.get("pi_acceptance")),
      41,
    );
    const updated = await json(`/api/notes/${filename}`);
    const current = updated.elements.find(
      (element) => element.id === originalId,
    );
    assert.ok(current && !current.isDeleted);
    assert.equal(current.x, element.x);
    assert.equal(current.y, element.y);
    assert.equal(current.width, element.width);
    assert.equal(current.height, element.height);
    await page.screenshot({
      path: path.join(output, `${cycle}-${kind}-applied.png`),
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".canvas-html-app iframe").waitFor({ timeout: 60000 });
    const restored = await canvasFrame();
    await restored.waitForFunction(
      (title) => document.body.textContent.includes(title),
      title,
      { timeout: 60000 },
    );
    assert.equal(
      await restored.evaluate(() => window.NoteApp.get("pi_acceptance")),
      41,
    );
    return {
      passed: true,
      turnId: assistant.turnId,
      elementId: originalId,
      tools: assistant.activities.map((activity) => activity.name),
      refresh: true,
      statePreserved: true,
    };
  } catch (error) {
    await page
      .screenshot({
        path: path.join(output, `${cycle}-${kind}-browser-error.png`),
      })
      .catch(() => {});
    console.error(
      "canvas acceptance failed",
      await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable"),
    );
    throw error;
  } finally {
    await browser.close();
  }
};

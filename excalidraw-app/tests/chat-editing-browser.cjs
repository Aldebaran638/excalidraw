/* Chat UX acceptance against the fixed 3009 preview; only own fixture is removed. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const puppeteer = require("puppeteer-core");
const base = "http://127.0.0.1:3009";
const root = path.resolve(__dirname, "../../.local-data/preview/notes");
const json = async (url, init) => {
  const response = await fetch(base + url, init);
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
};
(async () => {
  const noteId = randomUUID();
  const filename = `__chat-editing-${noteId}.excalidraw`;
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
    const question = randomUUID();
    const turnId = randomUUID();
    session.messages = [
      {
        id: question,
        turnId,
        role: "user",
        content: "请只回复一个词：READY",
        status: "complete",
        createdAt: Date.now(),
      },
      {
        id: randomUUID(),
        turnId,
        role: "assistant",
        content: "可拖动选中并复制的回答 SELECTABLE",
        status: "complete",
        createdAt: Date.now(),
      },
    ];
    await fs.writeFile(
      path.join(root, ".chats", noteId, `${session.id}.json`),
      JSON.stringify(session),
    );
    browser = await puppeteer.launch({
      executablePath:
        process.env.BROWSER_EXECUTABLE ||
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      pipe: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    });
    page = await browser.newPage();
    page.on("pageerror", (error) => console.log("page error", String(error)));
    page.setDefaultTimeout(60000);
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(
      (name, theme) => {
        localStorage.setItem("aldebaran.repository-note-name", name);
        localStorage.setItem("excalidraw-theme", theme);
      },
      filename,
      process.env.CHAT_TEST_THEME === "dark" ? "dark" : "light",
    );
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(
      () => Boolean(document.querySelector('[aria-label="打开笔记聊天"]')),
      { polling: 100, timeout: 120000 },
    );
    console.log("page ready");
    await page.click('[aria-label="打开笔记聊天"]');
    await page.waitForFunction(
      () => Boolean(document.querySelector(".note-chat-message--assistant p")),
      { polling: 100, timeout: 60000 },
    );
    console.log("chat ready");
    const composerIcons = await page.$$eval(
      ".note-chat-compose-actions button",
      (nodes) =>
        nodes.map((node) => ({
          label: node.getAttribute("aria-label"),
          icon: !!node.querySelector("svg"),
          text: node.textContent.trim(),
        })),
    );
    assert.deepEqual(
      composerIcons.map((item) => item.label),
      ["深度思考：已关闭", "发送消息"],
    );
    assert.ok(composerIcons.every((item) => item.icon && !item.text));
    await page.click('[aria-label="深度思考：已关闭"]');
    assert.equal(
      await page.$eval('[aria-label="深度思考：已开启"]', (node) =>
        node.getAttribute("aria-pressed"),
      ),
      "true",
    );
    await page.click('[aria-label="深度思考：已开启"]');
    assert.ok(await page.$('[aria-label="复制回答"] svg'));
    assert.ok(await page.$('[aria-label="重新生成"] svg'));
    const layout = await page.$eval(".note-chat-message--user", (node) => {
      const bubble = node
        .querySelector(".note-chat-message-content")
        .getBoundingClientRect();
      const actions = node
        .querySelector(".note-chat-user-actions")
        .getBoundingClientRect();
      const edit = node.querySelector('[aria-label="编辑消息"]');
      const rect = edit.getBoundingClientRect();
      return {
        bubbleBottom: bubble.bottom,
        actionsTop: actions.top,
        bubbleRight: bubble.right,
        buttonRight: rect.right,
        width: rect.width,
        height: rect.height,
        label: edit.textContent.trim(),
        icon: !!edit.querySelector("svg"),
      };
    });
    assert.ok(
      layout.actionsTop >= layout.bubbleBottom,
      "actions sit outside and below the bubble",
    );
    assert.ok(
      Math.abs(layout.buttonRight - layout.bubbleRight) <= 2,
      "actions align with bubble right edge",
    );
    assert.equal(layout.width, 28);
    assert.equal(layout.height, 28);
    assert.equal(layout.label, "");
    assert.ok(layout.icon);
    await fs.mkdir(path.resolve(root, "../../acceptance/chat-ux"), {
      recursive: true,
    });
    await (
      await page.$(".note-chat-message--user")
    ).screenshot({
      path: path.resolve(
        root,
        "../../acceptance/chat-ux/user-message-actions.png",
      ),
    });
    const bounds = await page.$eval(
      ".note-chat-message--assistant p",
      (node) => {
        const rect = node.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          selectable: getComputedStyle(node).userSelect,
        };
      },
    );
    assert.equal(bounds.selectable, "text");
    await page.mouse.move(bounds.x + 2, bounds.y + 8);
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width - 2,
      bounds.y + bounds.height - 4,
      { steps: 15 },
    );
    await page.mouse.up();
    assert.ok(
      await page.evaluate(() => getSelection().toString().length > 0),
      "drag selection must work",
    );
    const long = "verylongunbrokeninput".repeat(80);
    await page.$eval(
      '[aria-label="聊天消息"]',
      (node, text) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        ).set;
        setter.call(node, text);
        node.dispatchEvent(new Event("input", { bubbles: true }));
      },
      long,
    );
    const metrics = await page.$eval('[aria-label="聊天消息"]', (node) => ({
      value: node.value,
      scroll: node.scrollWidth,
      width: node.clientWidth,
      height: node.scrollHeight,
      visible: node.clientHeight,
    }));
    assert.equal(metrics.value, long);
    assert.ok(metrics.scroll <= metrics.width + 1, "no horizontal overflow");
    assert.ok(metrics.height > metrics.visible, "long text wraps vertically");
    const clickText = async (label) => {
      await page.waitForFunction(
        (text) =>
          [...document.querySelectorAll(".note-chat button")].some(
            (node) =>
              (node.textContent.trim() === text ||
                node.getAttribute("aria-label") === text) &&
              !node.disabled,
          ),
        { polling: 100, timeout: 120000 },
        label,
      );
      await page.evaluate((text) => {
        const button = [...document.querySelectorAll(".note-chat button")].find(
          (node) =>
            node.textContent.trim() === text ||
            node.getAttribute("aria-label") === text,
        );
        if (!button) {
          throw new Error(`Missing button ${text}`);
        }
        button.click();
      }, label);
    };
    await clickText("重新生成");
    console.log("selection and soft wrap passed; regenerate requested");
    await page.waitForFunction(
      () =>
        document
          .querySelector(".note-chat-message--assistant")
          ?.textContent.includes("READY"),
      { polling: 100, timeout: 120000 },
    );
    assert.equal(
      await page.$eval('[aria-label="聊天消息"]', (node) => node.value),
      long,
      "regeneration preserves composer draft",
    );
    await clickText("编辑消息");
    console.log("regenerate complete; editing");
    await page.$eval('[aria-label="编辑历史消息"]', (node) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(node, "请只回复一个词：EDITED");
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickText("发送修改");
    await page.waitForFunction(
      () =>
        document
          .querySelector(".note-chat-message--assistant")
          ?.textContent.includes("EDITED"),
      { polling: 100, timeout: 120000 },
    );
    const stored = await json(`/api/notes/${noteId}/chats/${session.id}`);
    assert.equal(stored.messages[0].content, "请只回复一个词：EDITED");
    assert.equal(stored.previousVersions.length, 2);
    assert.equal(
      stored.previousVersions[0].messages[1].content,
      "可拖动选中并复制的回答 SELECTABLE",
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(
      () => Boolean(document.querySelector('[aria-label="对话版本"]')),
      { polling: 100, timeout: 120000 },
    );
    await page.select('[aria-label="对话版本"]', stored.previousVersions[0].id);
    await page.waitForFunction(
      () =>
        document
          .querySelector(".note-chat")
          ?.textContent.includes("SELECTABLE"),
      { polling: 100 },
    );
    await fs.mkdir(path.resolve(root, "../../acceptance/chat-ux"), {
      recursive: true,
    });
    await page.screenshot({
      path: path.resolve(root, "../../acceptance/chat-ux/history.png"),
    });
    await page.select('[aria-label="对话版本"]', "");
    if (process.env.CHAT_TEST_THEME === "dark") {
      assert.ok(
        await page.$eval(".excalidraw", (node) =>
          node.classList.contains("theme--dark"),
        ),
        "Dark theme was requested but is not active; do not count this as dark-theme acceptance",
      );
    }
    await page.waitForFunction(
      () => Boolean(document.querySelector(".note-chat-compose-actions")),
      { polling: 100, timeout: 120000 },
    );
    await page.screenshot({
      path: path.resolve(
        root,
        `../../acceptance/chat-ux/icons-${
          process.env.CHAT_TEST_THEME === "dark" ? "dark" : "light"
        }.png`,
      ),
    });
    await page.setViewport({
      width: 430,
      height: 900,
      isMobile: true,
      hasTouch: true,
    });
    await page.waitForFunction(
      () =>
        Boolean(
          document.querySelector(
            '.note-chat-compose-actions [aria-label="发送消息"]',
          ),
        ),
      { polling: 100, timeout: 30000 },
    );
    const touch = await page.$eval(
      '.note-chat-compose-actions [aria-label="发送消息"]',
      (node) => ({
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
      }),
    );
    assert.ok(touch.width >= 44 && touch.height >= 44);
    await page.screenshot({
      path: path.resolve(root, "../../acceptance/chat-ux/icons-narrow.png"),
      isMobile: true,
    });
    console.log(
      "PASS actual drag selection, soft wrap/value preservation, real Qwen regenerate/edit, composer preservation and history refresh",
    );
  } catch (error) {
    if (page && !page.isClosed()) {
      console.log(
        "failure page",
        await page.evaluate(() => ({
          text: document.body.innerText.slice(0, 1500),
          resources: performance
            .getEntriesByType("resource")
            .slice(-10)
            .map((entry) => ({ name: entry.name, duration: entry.duration })),
        })),
      );
    }
    throw error;
  } finally {
    await browser?.close();
    await fs.rm(path.join(root, filename), { force: true });
    await fs.rm(path.join(root, ".chats", noteId), {
      force: true,
      recursive: true,
    });
    await fs.rm(path.join(root, ".apps", noteId), {
      force: true,
      recursive: true,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

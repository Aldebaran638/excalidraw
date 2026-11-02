/* Real native disclosures and scroll geometry; no Qwen requests. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { chromium } = require("playwright-core");

const base = "http://127.0.0.1:3009";
const directory = path.resolve(".local-data/preview/notes");
async function json(url, init) {
  const response = await fetch(base + url, init);
  assert.ok(response.ok, `HTTP ${response.status}: ${url}`);
  return response.json();
}
(async () => {
  const noteId = randomUUID();
  const filename = `__reasoning-sticky-${noteId}.excalidraw`;
  let browser;
  try {
    await json(`/api/notes/${filename}`, {
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
    const session = await json(`/api/notes/${noteId}/chats`, {
      method: "POST",
    });
    const long = Array.from(
      { length: 240 },
      (_, i) =>
        `思考步骤 ${
          i + 1
        }：长内容滚动时应始终能找到收起入口，中文文字可以正常选择。`,
    ).join("\n");
    const tail = "后续回答：收起思考之后继续阅读答案。\n".repeat(60);
    session.messages = [
      {
        id: randomUUID(),
        turnId: randomUUID(),
        role: "assistant",
        content: "正文",
        createdAt: Date.now(),
        status: "complete",
        blocks: [
          { id: randomUUID(), type: "reasoning", text: long },
          { id: randomUUID(), type: "text", text: tail },
          { id: randomUUID(), type: "reasoning", text: long },
          { id: randomUUID(), type: "text", text: tail },
        ],
      },
      {
        id: randomUUID(),
        turnId: randomUUID(),
        role: "assistant",
        content: tail,
        reasoning: long,
        createdAt: Date.now(),
        status: "complete",
      },
    ];
    const file = path.join(directory, ".chats", noteId, `${session.id}.json`);
    await fs.writeFile(`${file}.fixture.tmp`, JSON.stringify(session));
    await fs.rename(`${file}.fixture.tmp`, file);
    browser = await chromium.launch({
      executablePath:
        process.env.BROWSER_EXECUTABLE ||
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    });
    const page = await browser.newPage({
      hasTouch: true,
      viewport: { width: 1440, height: 1000 },
    });
    await page.addInitScript((name) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", name);
      }
    }, filename);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "打开笔记聊天", exact: true })
      .click({ timeout: 120000 });
    const reasoning = page.locator(".note-chat-reasoning");
    await reasoning.nth(2).waitFor();
    const header = page.locator(".note-chat-header");
    const beforeHeader = await header.boundingBox();
    async function middle(index) {
      const block = reasoning.nth(index);
      if (!(await block.evaluate((node) => node.open))) {
        await block.locator("summary").click();
      }
      await block.evaluate((node) => {
        const scroller = node.closest(".note-chat-messages");
        scroller.scrollTop +=
          node.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          900;
      });
      await page
        .waitForFunction(
          (index) => {
            const node = document.querySelectorAll(".note-chat-reasoning")[
              index
            ];
            const root = node
              .closest(".note-chat-messages")
              .getBoundingClientRect();
            return (
              Math.abs(
                node.querySelector("summary").getBoundingClientRect().top -
                  root.top,
              ) < 2
            );
          },
          index,
          { polling: 100 },
        )
        .catch(async (error) => {
          console.log(
            "sticky geometry",
            await block.evaluate((node) => {
              const root = node.closest(".note-chat-messages");
              const summary = node.querySelector("summary");
              return {
                open: node.open,
                scrollTop: root.scrollTop,
                rootTop: root.getBoundingClientRect().top,
                detailsTop: node.getBoundingClientRect().top,
                summaryTop: summary.getBoundingClientRect().top,
                position:
                  node.ownerDocument.defaultView.getComputedStyle(summary)
                    .position,
                top: node.ownerDocument.defaultView.getComputedStyle(summary)
                  .top,
              };
            }),
          );
          throw error;
        });
      const bounds = await block.locator("summary").boundingBox();
      assert.ok(bounds.height >= 44, "touch disclosure target must be 44px");
      return block;
    }
    await middle(0);
    assert.deepEqual(
      await header.boundingBox(),
      beforeHeader,
      "session header must not move",
    );
    await fs.mkdir(".local-data/acceptance/chat-reasoning", {
      recursive: true,
    });
    await page.screenshot({
      path: ".local-data/acceptance/chat-reasoning/desktop.png",
      timeout: 15000,
    });
    await reasoning.nth(0).evaluate((node) => {
      const scroller = node.closest(".note-chat-messages");
      scroller.scrollTop +=
        node.getBoundingClientRect().bottom -
        scroller.getBoundingClientRect().top +
        80;
    });
    assert.ok(
      await reasoning
        .nth(0)
        .locator("summary")
        .evaluate(
          (node) =>
            node.getBoundingClientRect().bottom <=
            node.closest(".note-chat-messages").getBoundingClientRect().top + 2,
        ),
      "previous sticky header must leave with its block",
    );
    await middle(1);
    await reasoning.nth(1).locator("summary").click();
    assert.equal(await reasoning.nth(1).evaluate((node) => node.open), false);
    assert.ok(
      await reasoning
        .nth(1)
        .locator("summary")
        .evaluate((node) => {
          const top =
            node.getBoundingClientRect().top -
            node.closest(".note-chat-messages").getBoundingClientRect().top;
          return top >= 0 && top < 60;
        }),
      "collapse must anchor at the current reasoning, not a distant message",
    );
    await reasoning.nth(1).locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await reasoning.nth(1).evaluate((node) => node.open), true);
    await page.keyboard.press("Space");
    assert.equal(await reasoning.nth(1).evaluate((node) => node.open), false);
    await page.mouse.click(400, 90);
    await page.keyboard.press("Shift+Alt+d");
    await page.locator(".excalidraw.theme--dark").waitFor();
    await page.setViewportSize({ width: 430, height: 900 });
    await middle(2);
    await page.screenshot({
      path: ".local-data/acceptance/chat-reasoning/mobile-dark.png",
      timeout: 15000,
    });
    const summary = await reasoning.nth(2).locator("summary").boundingBox();
    await page.touchscreen.tap(
      summary.x + summary.width / 2,
      summary.y + summary.height / 2,
    );
    assert.equal(await reasoning.nth(2).evaluate((node) => node.open), false);
    const stored = await json(`/api/notes/${noteId}/chats/${session.id}`);
    assert.equal(
      stored.revision,
      session.revision,
      "disclosures must not write chat history",
    );
    assert.deepEqual(stored.messages, session.messages);
    console.log(
      "PASS sticky bounds, collapse anchor, keyboard, touch, legacy blocks, stable header and no history writes",
    );
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
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/* Opt-in, strictly serial real Qwen acceptance on fixed 3009; owns only UUID fixture records. */
/* eslint-disable no-console */
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { chromium } = require("playwright-core");
if (process.env.CHAT_IMAGES_REAL !== "1") {
  console.log(
    "SKIP: set CHAT_IMAGES_REAL=1 for strictly serial real-model acceptance",
  );
  process.exit(0);
}
const base = "http://127.0.0.1:3009";
const root = path.resolve(".local-data/preview/notes");
const out = path.resolve(".local-data/acceptance/chat-canvas-images");
const json = async (url, init) => {
  const r = await fetch(base + url, init);
  assert.ok(r.ok, `${url} ${r.status}`);
  return r.json();
};
(async () => {
  assert.equal(
    (await json("/api/ai/capabilities")).vision,
    true,
    "Verify upstream vision before enabling it",
  );
  const noteId = randomUUID();
  const filename = `__chat-images-real-${noteId}.excalidraw`;
  let browser;
  let session;
  let activeTurn;
  const results = [];
  const api = () => `/api/notes/${noteId}/chats/${session.id}`;
  try {
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(
      path.join(out, "real-fixture.json"),
      JSON.stringify({ noteId, filename }),
    );
    const shape = {
      id: randomUUID(),
      type: "rectangle",
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      angle: 0,
      strokeColor: "#0000ff",
      backgroundColor: "#0000ff",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a0",
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
    };
    await json(`/api/notes/${filename}`, {
      method: "PUT",
      body: JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [shape],
        files: {},
        appState: {
          viewBackgroundColor: "#ffffff",
          scrollX: 300,
          scrollY: 300,
          zoom: { value: 1 },
        },
        repositoryMetadata: { version: 1, noteId },
      }),
    });
    session = await json(`/api/notes/${noteId}/chats`, { method: "POST" });
    browser = await chromium.launch({
      executablePath:
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    const page = await context.newPage();
    await page.addInitScript(
      ({ filename }) => {
        if (window === window.top) {
          localStorage.setItem("aldebaran.repository-note-name", filename);
        }
      },
      { filename },
    );
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "打开笔记聊天", exact: true })
      .click({ timeout: 120000 });
    const png = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 240;
      c.height = 160;
      const x = c.getContext("2d");
      x.fillStyle = "#00ff00";
      x.fillRect(0, 0, 240, 160);
      x.fillStyle = "#000000";
      x.font = "bold 90px sans-serif";
      x.fillText("73", 50, 115);
      return c.toDataURL().split(",")[1];
    });
    await page.locator('input[aria-label="选择聊天图片"]').setInputFiles({
      name: "视觉验收-73.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await page.locator(".note-chat-draft-images img").waitFor();
    const send = async (label, prompt) => {
      await page.locator(".note-chat-composer textarea").fill(prompt);
      const pending = page.waitForRequest(
        (r) => r.url() === `${base + api()}/turns` && r.method() === "POST",
      );
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      const body = (await pending).postDataJSON();
      activeTurn = body.turnId;
      const started = performance.now();
      let message;
      while (performance.now() - started < 180000) {
        const current = await json(api());
        const expectedTurn = body.turnId;
        message = current.messages.find(
          (m) => m.role === "assistant" && m.turnId === expectedTurn,
        );
        if (message && message.status !== "generating") {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(message, "no assistant response");
      results.push({
        label,
        status: message.status,
        content: message.content,
        error: message.error,
        activities: message.activities,
        turnId: activeTurn,
      });
      await fs.writeFile(
        path.join(out, "real-results.json"),
        JSON.stringify(
          { noteId, sessionId: session.id, model: "configured Qwen", results },
          null,
          2,
        ),
      );
      assert.equal(
        message.status,
        "complete",
        message.error || message.content,
      );
      await page
        .getByRole("button", { name: "发送消息", exact: true })
        .waitFor({ timeout: 10000 });
      activeTurn = undefined;
      return message;
    };
    const upload = await send("uploaded image", "");
    assert.match(upload.content, /73/);
    console.log("PASS real upload recognition");
    const capture = await send(
      "canvas region tool",
      "请真实调用 capture_note_region 工具，截取当前画布左上角 (10, 10)、右下角 (190, 110) 的区域，然后根据工具返回的图片告诉我色块是什么颜色。不要用读取元素属性来代替截图。简短回答。",
    );
    const activity = capture.activities?.find(
      (a) => a.name === "capture_note_region" && a.status === "complete",
    );
    assert.ok(activity, "model did not execute screenshot tool");
    assert.equal(activity.imageDelivery, "sent");
    assert.equal(activity.images.length, 1);
    assert.match(capture.content, /蓝|blue/i);
    const r = await fetch(`${base + api()}/images/${activity.images[0].id}`);
    assert.ok(r.ok);
    await fs.writeFile(
      path.join(out, "real-region.png"),
      Buffer.from(await r.arrayBuffer()),
    );
    console.log("PASS real screenshot tool and image understanding");
    const details = page
      .locator(".note-chat-reading")
      .filter({ hasText: "截图已保存，图片已提交给模型" });
    assert.equal(await details.last().getAttribute("open"), null);
    await details.last().locator("summary").click();
    await details
      .last()
      .getByRole("button", { name: "放大图片：画布区域截图", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "画布区域截图", exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(out, "real-viewer.png") });
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".note-chat-composer textarea").waitFor();
    const history = await send(
      "image context after refresh",
      "最开始我上传的那张图片的背景是什么颜色？只回答颜色。",
    );
    assert.match(history.content, /绿|green/i);
    console.log("PASS real image context after reload");
    await page.screenshot({ path: path.join(out, "real-chat.png") });
    console.log(
      "PASS: 3 serial real Qwen turns, real image upload, actual canvas screenshot tool, persistence and refreshed context.",
    );
  } finally {
    if (activeTurn && session) {
      await fetch(`${base + api()}/turns/${activeTurn}/stop`, {
        method: "POST",
      }).catch(() => {});
    }
    await browser?.close();
    if (session) {
      for (let i = 0; i < 20; i++) {
        const current = await json(api()).catch(() => null);
        if (!current?.messages.some((m) => m.status === "generating")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await fs.rm(path.join(root, filename), { force: true });
    await fs.rm(path.join(root, ".chats", noteId), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(root, ".apps", noteId), {
      recursive: true,
      force: true,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

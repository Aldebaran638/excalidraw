/* No model requests: replay our recorded K8s source for native export/UX regression. */
/* eslint-disable no-console */
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:3009";
const directory = path.resolve(".local-data/preview/notes");
const output = path.resolve(".local-data/acceptance/pi-runtime");
async function json(url, options) {
  const response = await fetch(base + url, options);
  assert.ok(response.ok, `${url}: HTTP ${response.status}`);
  return response.json();
}
(async () => {
  const noteId = randomUUID();
  const filename = `__pi-export-${noteId}.excalidraw`;
  let browser;
  try {
    const entries = (
      await fs.readFile(path.join(output, "2-complex-1.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    const text = entries
      .filter((entry) => entry.kind === "model_response")
      .map((entry) => entry.data.content)
      .join("");
    const recorded = text.match(/```html[^\n]*\n([\s\S]*?)```/)[1];
    const source = `<section style="padding:12px;display:flex;gap:12px;align-items:center"><input id="export-probe-text" aria-label="导出输入" value="初始输入"><svg width="60" height="50"><rect width="60" height="50" fill="#ef4444"/></svg><canvas id="export-probe-canvas" width="60" height="50"></canvas></section><script>document.getElementById('export-probe-canvas').getContext('2d').fillStyle='#16a34a';document.getElementById('export-probe-canvas').getContext('2d').fillRect(0,0,60,50);</script>${recorded}`;
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
    const artifactId = randomUUID();
    const ref = { kind: "html", artifactId, version: 1 };
    const root = path.join(directory, ".chats", noteId);
    const artifactRoot = path.join(root, "artifacts", session.id, artifactId);
    await fs.mkdir(artifactRoot, { recursive: true });
    await fs.writeFile(
      path.join(artifactRoot, "html-v1.json"),
      JSON.stringify({
        ...ref,
        noteId,
        sessionId: session.id,
        title: "导出回归",
        source,
        complete: true,
        runtimeVersion: 3,
        revision: 0,
        createdAt: Date.now(),
        state: { forms: {}, custom: {} },
      }),
    );
    session.messages = [
      {
        id: randomUUID(),
        turnId: randomUUID(),
        role: "assistant",
        content: "已记录的真实应用 + Canvas、SVG 与表单回归样例",
        status: "complete",
        createdAt: Date.now(),
        blocks: [
          {
            id: randomUUID(),
            type: "html",
            ref,
            complete: true,
            saved: true,
            runtimeVersion: 3,
          },
        ],
      },
    ];
    await fs.writeFile(
      path.join(root, `${session.id}.json`),
      JSON.stringify(session),
    );
    browser = await chromium.launch({
      executablePath:
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    await page.addInitScript((name) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", name);
        delete window.showSaveFilePicker;
        delete window.showOpenFilePicker;
      }
    }, filename);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page
      .locator('[aria-label="打开笔记聊天"]')
      .click({ timeout: 120000 });
    await page.locator('.note-chat-html-card [aria-label="导入笔记"]').click();
    await page.locator(".canvas-action-hint").waitFor({ timeout: 120000 });
    await page.mouse.move(100, 180);
    await page.mouse.down();
    await page.mouse.move(900, 780, { steps: 12 });
    await page.mouse.up();
    await page
      .frameLocator(".canvas-html-app iframe")
      .locator("#export-probe-text")
      .waitFor();
    const frame = await (
      await page.locator(".canvas-html-app iframe").elementHandle()
    ).contentFrame();
    await frame.locator("#export-probe-text").fill("当前输入：中文测试");
    await frame.locator("#export-probe-text").press("Tab");
    const before = await frame.locator("body").innerText();
    await frame.locator(".k8s-node-group").nth(1).click();
    await frame.waitForFunction(
      (before) => document.body.innerText !== before,
      before,
    );
    await page.screenshot({
      path: path.join(output, "export-current-view.png"),
    });
    await page.locator('[data-testid="main-menu-trigger"]').click();
    await page.locator('[data-testid="image-export-button"]').click();
    for (const format of ["PNG", "SVG"]) {
      const button = page.getByRole("button", {
        name: `Export to ${format}`,
        exact: true,
      });
      const downloading = page
        .waitForEvent("download", { timeout: 60000 })
        .catch(async (error) => {
          console.error(
            "export dialog",
            await page.locator("body").innerText(),
          );
          await page.screenshot({
            path: path.join(output, "export-error.png"),
          });
          throw error;
        });
      await button.click();
      const download = await downloading;
      await download.saveAs(
        path.join(output, `native-export.${format.toLowerCase()}`),
      );
    }
    const png = await fs.readFile(path.join(output, "native-export.png"));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.ok(png.length > 2000);
    const svg = await fs.readFile(
      path.join(output, "native-export.svg"),
      "utf8",
    );
    const decoded =
      svg +
      [...svg.matchAll(/href="data:image\/svg\+xml,([^"]+)"/g)]
        .map((match) => decodeURIComponent(match[1]))
        .join("\n");
    assert.ok(decoded.includes("data:image/png;base64,"));
    assert.ok(!/<script|<foreignObject/i.test(decoded));
    await page.keyboard.press("Escape");
    await page.mouse.click(1000, 820);
    await page.keyboard.press("Alt+Shift+D");
    await page.locator(".excalidraw.theme--dark").waitFor();
    await page.setViewportSize({ width: 430, height: 900 });
    await page.screenshot({ path: path.join(output, "narrow-view.png") });
    console.log(
      JSON.stringify({
        pngBytes: png.length,
        svgBytes: svg.length,
        canvasAndSvg: true,
        input: "当前输入：中文测试",
        nodeSelection: true,
        narrow: true,
      }),
    );
  } finally {
    await browser?.close();
    await fs.rm(path.join(directory, filename), { force: true });
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

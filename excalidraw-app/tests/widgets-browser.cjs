/* Browser acceptance: uses an isolated note and leaves user notes untouched. */
/* global h */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const puppeteer = require("puppeteer-core");

const base = process.env.APP_URL || "http://127.0.0.1:3001";
const executablePath = process.env.BROWSER_EXECUTABLE;
const name = `__widget-browser-${Date.now()}.excalidraw`;
const noteUrl = `${base}/api/notes/${name}`;
let browser;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const button = async (page, text, scope = "") => {
  const target = await page.evaluateHandle(
    (label, prefix) => {
      const parent = prefix ? document.querySelector(prefix) : document;
      return [...parent.querySelectorAll("button")].find(
        (node) => node.textContent.trim() === label,
      );
    },
    text,
    scope,
  );
  const element = target.asElement();
  assert.ok(element, `Missing button: ${text}`);
  await element.click();
};
const note = async () => (await fetch(noteUrl)).json();
const widget = async () =>
  (await note()).elements.find(
    (el) => !el.isDeleted && el.customData?.aiWidget,
  );
const waitSaved = async (test) => {
  for (let i = 0; i < 50; i++) {
    const w = await widget();
    if (w && test(w)) {
      return w;
    }
    await sleep(200);
  }
  throw new Error("Widget state did not save");
};
const createRegion = async (page) => {
  await page.click(".App-toolbar__extra-tools-trigger");
  await button(page, "AI 组件");
  await page.mouse.move(260, 200);
  await page.mouse.down();
  await page.mouse.move(880, 740, { steps: 12 });
  await page.mouse.up();
  await page.waitForSelector(".ai-widget-panel");
};

(async () => {
  assert.ok(executablePath, "Set BROWSER_EXECUTABLE to a Chromium executable");
  const response = await fetch(noteUrl, {
    method: "PUT",
    headers: { "If-None-Match": "*" },
    body: JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: {},
    }),
  });
  assert.equal(response.status, 200);
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluateOnNewDocument((filename) => {
    localStorage.setItem("aldebaran.repository-note-name", filename);
  }, name);
  await page.goto(base, { waitUntil: "networkidle2", timeout: 120000 });
  await page.waitForFunction(
    () => window.h?.app?.api && !window.h.state.isLoading,
  );
  await sleep(600);
  await createRegion(page);
  await page.click(".ai-widget-panel summary");
  await button(page, "Kubernetes 架构全景", ".ai-widget-panel");
  await page.waitForSelector(".ai-widget-preview .iw-pressable");
  await page.evaluate(() =>
    [...document.querySelectorAll(".ai-widget-preview .iw-pressable")]
      .find((n) => n.textContent.includes("etcd"))
      .click(),
  );
  await page.waitForFunction(() =>
    document.querySelector(".ai-widget-preview")?.textContent.includes("Raft"),
  );
  await button(page, "放入笔记", ".ai-widget-panel");
  let saved = await waitSaved(
    (w) => w.customData.aiWidget.state.selected === "etcd",
  );
  assert.equal(saved.type, "embeddable");
  const id = saved.id;
  await button(page, "进入交互", ".ai-widget-actions");
  await page
    .waitForSelector(".excalidraw__embeddable .iw-pressable")
    .catch(() =>
      page.waitForSelector(".excalidraw__embeddable-container .iw-pressable"),
    );
  const viewportBefore = await page.evaluate(() => ({
    scrollX: h.state.scrollX,
    scrollY: h.state.scrollY,
    zoom: h.state.zoom.value,
  }));
  await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        ".excalidraw__embeddable-container .iw-pressable",
      ),
    ]
      .find((n) => n.textContent.includes("Scheduler"))
      .focus(),
  );
  await page.keyboard.press("Enter");
  saved = await waitSaved(
    (w) => w.customData.aiWidget.state.selected === "scheduler",
  );
  await sleep(1400);
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: h.state.scrollX,
      scrollY: h.state.scrollY,
      zoom: h.state.zoom.value,
    })),
    viewportBefore,
  );
  const requests = [];
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url() === noteUrl) {
      requests.push(req.postData());
    }
  });
  await sleep(2000);
  assert.equal(requests.length, 0, "Idle widget must not continuously save");
  await page.keyboard.press("Escape");
  await page.focus(".excalidraw");
  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await sleep(500);
  await waitSaved((w) => w.customData.aiWidget.state.selected === "etcd");
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await waitSaved((w) => w.customData.aiWidget.state.selected === "scheduler");
  console.log("PASS: widget input undo and redo persist correctly");
  const exported = await page.evaluate(
    async (elementId, moduleUrl) => {
      const { exportToSvg, exportToCanvas } = await import(moduleUrl);
      const elements = h.app.api
        .getSceneElements()
        .filter((e) => e.id === elementId);
      const state = {
        ...h.state,
        exportBackground: true,
        exportScale: 1,
        exportEmbedScene: false,
      };
      const svg = await exportToSvg(elements, state, h.app.api.getFiles());
      const canvas = await exportToCanvas(
        elements,
        state,
        h.app.api.getFiles(),
        state,
      );
      return {
        svg: svg.outerHTML,
        png: canvas.toDataURL().length,
        width: canvas.width,
      };
    },
    id,
    `/@fs${path.resolve(
      __dirname,
      "../../packages/excalidraw/scene/export.ts",
    )}`,
  );
  assert.ok(
    exported.svg.includes("image/svg+xml"),
    "SVG must include the trusted widget snapshot",
  );
  assert.ok(
    !exported.svg.includes("<foreignObject"),
    "Export cannot contain executable DOM",
  );
  assert.ok(
    exported.png > 1000 && exported.width > 100,
    "PNG must contain widget content",
  );
  console.log("PASS: native SVG and PNG export contain widget content");
  await page.evaluate((elementId) => {
    h.app.api.updateScene({
      elements: h.elements.map((e) =>
        e.id === elementId ? { ...e, width: 280, version: e.version + 1 } : e,
      ),
      appState: { selectedElementIds: { [elementId]: true } },
    });
  }, id);
  await page.waitForFunction(
    () =>
      document.querySelector(".excalidraw__embeddable-container .iw-view")
        ?.clientWidth < 300,
  );
  await button(page, "放大操作", ".ai-widget-actions");
  await page.waitForSelector(".ai-widget-modal .iw-view");
  await button(page, "关闭", ".ai-widget-modal");
  await page.reload({ waitUntil: "networkidle2", timeout: 120000 });
  await page.waitForFunction(() =>
    h.elements?.some(
      (e) => e.customData?.aiWidget?.state.selected === "scheduler",
    ),
  );
  console.log(
    "PASS: native region tool, scoped card interactions, persistence, stable viewport, idle save suppression, responsive resize, enlarged view, reload",
  );
  const second = await browser.newPage();
  await second.setViewport({ width: 1280, height: 900 });
  await second.goto(base, { waitUntil: "networkidle2", timeout: 120000 });
  await second.waitForFunction(() =>
    h.elements?.some(
      (e) => e.customData?.aiWidget?.state.selected === "scheduler",
    ),
  );
  await sleep(1500);
  const responseBefore = await fetch(noteUrl);
  const external = await responseBefore.json();
  external.elements.find(
    (e) => e.id === id,
  ).customData.aiWidget.state.selected = "etcd";
  const beforeExternal = await page.evaluate(() => ({
    scrollX: h.state.scrollX,
    scrollY: h.state.scrollY,
    zoom: h.state.zoom.value,
  }));
  const putCount = requests.length;
  const externalSave = await fetch(noteUrl, {
    method: "PUT",
    headers: {
      "If-Match": responseBefore.headers.get("etag"),
      "X-Repository-Client-Id": "external-acceptance",
    },
    body: JSON.stringify(external),
  });
  assert.equal(externalSave.status, 200);
  for (const client of [page, second]) {
    await client.waitForFunction(() =>
      h.elements?.some(
        (e) => e.customData?.aiWidget?.state.selected === "etcd",
      ),
    );
  }
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: h.state.scrollX,
      scrollY: h.state.scrollY,
      zoom: h.state.zoom.value,
    })),
    beforeExternal,
  );
  await second.close();
  await sleep(1200);
  assert.equal(
    requests.length,
    putCount,
    "External scene application must not write back",
  );
  console.log(
    "PASS: two clients receive external SSE updates without resetting the viewport",
  );
  await createRegion(page);
  await page.click(".ai-widget-panel summary");
  for (const [title, heading] of [
    ["通用计算器", "通用计算器"],
    ["数据筛选", "按阈值筛选数据"],
    ["矩阵与二维变换", "二维线性变换"],
    ["Attention 演示", "Attention: softmax"],
  ]) {
    await button(page, title, ".ai-widget-panel");
    await page.waitForFunction(
      (text) =>
        document
          .querySelector(".ai-widget-preview")
          ?.textContent.includes(text) &&
        !document.querySelector(".ai-widget-preview .iw-error"),
      {},
      heading,
    );
  }
  const conflictResponse = await fetch(noteUrl);
  const conflictScene = await conflictResponse.json();
  conflictScene.elements.find(
    (e) => e.id === id,
  ).customData.aiWidget.state.selected = "cluster";
  await fetch(noteUrl, {
    method: "PUT",
    headers: {
      "If-Match": conflictResponse.headers.get("etag"),
      "X-Repository-Client-Id": "external-conflict",
    },
    body: JSON.stringify(conflictScene),
  });
  await page.waitForSelector(".ai-widget-conflict");
  assert.equal(
    await page.evaluate(
      (elementId) =>
        h.elements.find((e) => e.id === elementId).customData.aiWidget.state
          .selected,
      id,
    ),
    "etcd",
    "Draft conflicts cannot silently replace the scene",
  );
  await button(page, "放弃草稿并加载本地版本", ".ai-widget-conflict");
  await page.waitForFunction(() =>
    h.elements?.some(
      (e) => e.customData?.aiWidget?.state.selected === "cluster",
    ),
  );
  console.log(
    "PASS: five application previews and explicit external-update conflict resolution",
  );
  if (process.env.TEST_REAL_QWEN === "true") {
    await page.evaluate(
      (elementId) =>
        h.app.api.updateScene({
          appState: { selectedElementIds: { [elementId]: true } },
        }),
      id,
    );
    await button(page, "AI 修改", ".ai-widget-actions");
    await page.type(
      ".ai-widget-panel textarea",
      "保留这个 Kubernetes 点击解释组件，仅把标题改成 Kubernetes 交互架构示例。保持 selected、facts 及所有现有节点 ID。",
    );
    await button(page, "用 Qwen 生成", ".ai-widget-panel");
    await page.waitForSelector(".ai-widget-preview", { timeout: 150000 });
    await button(page, "应用修改", ".ai-widget-panel");
    await waitSaved((w) =>
      w.customData.aiWidget.definition.title.includes("Kubernetes"),
    );
    console.log("PASS: real qwen3.8-27b generation and confirmed modification");
  }
  assert.deepEqual(errors, [], "Unexpected browser errors");
  await page.screenshot({ path: "/tmp/excalidraw-widgets-browser.png" });
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) {
      await browser.close();
    }
    // Only delete the generated, uniquely named acceptance note.
    await fs.unlink(path.join(__dirname, "../../notes", name)).catch((e) => {
      if (e.code !== "ENOENT") {
        throw e;
      }
    });
  });

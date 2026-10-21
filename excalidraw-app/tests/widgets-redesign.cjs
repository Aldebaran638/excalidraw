/* Isolated browser acceptance, usable against development or production. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const base = process.env.APP_URL || "http://127.0.0.1:3009";
const filename = `__widget-redesign-${Date.now()}.excalidraw`;
const url = `${base}/api/notes/${filename}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
const clickElement = async (page, element) => {
  await page.bringToFront();
  await element.evaluate((node) =>
    node.scrollIntoView({ block: "nearest", inline: "nearest" }),
  );
  const box = await element.boundingBox();
  assert.ok(box && box.width && box.height, "Click target must be visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};
const clickSelector = async (page, selector) =>
  clickElement(page, await page.$(selector));
const click = async (page, text, selector = "body") => {
  const handle = await page.evaluateHandle(
    (label, scope) =>
      [...document.querySelector(scope).querySelectorAll("button")].find(
        (node) => node.textContent.trim() === label,
      ),
    text,
    selector,
  );
  assert.ok(handle.asElement(), `Missing button ${text}`);
  await clickElement(page, handle.asElement());
};
const openExamples = (page) =>
  page.evaluate(() =>
    document.querySelectorAll(".ai-widget-panel details").forEach((node) => {
      node.open = true;
    }),
  );
const saved = async (predicate) => {
  for (let attempt = 0; attempt < 70; attempt++) {
    const note = await (await fetch(url)).json();
    const widget = note.elements.find(
      (element) => !element.isDeleted && element.customData?.aiWidget,
    );
    if (widget && predicate(widget)) {
      return widget;
    }
    await sleep(150);
  }
  throw new Error("Widget did not reach expected persisted state");
};
(async () => {
  assert.ok(process.env.BROWSER_EXECUTABLE, "Set BROWSER_EXECUTABLE");
  assert.equal(
    (
      await fetch(url, {
        method: "PUT",
        headers: { "If-None-Match": "*" },
        body: JSON.stringify({
          type: "excalidraw",
          version: 2,
          elements: [],
          appState: {},
          files: {},
        }),
      })
    ).status,
    200,
  );
  browser = await puppeteer.launch({
    executablePath: process.env.BROWSER_EXECUTABLE,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.bringToFront();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.log("browser:", message.text().slice(0, 350));
    }
  });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(
    (name) => localStorage.setItem("aldebaran.repository-note-name", name),
    filename,
  );
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(".App-toolbar__extra-tools-trigger", {
    timeout: 120000,
  });
  console.log("READY editor");
  await sleep(1000);
  await clickSelector(page, ".App-toolbar__extra-tools-trigger");
  await click(page, "AI 组件");
  await page.mouse.move(370, 220);
  await page.mouse.down();
  await page.mouse.move(1070, 780, { steps: 10 });
  await page.mouse.up();
  await page.waitForSelector(".ai-widget-panel");
  await openExamples(page);
  await click(page, "Kubernetes · 从请求到运行", ".ai-widget-panel");
  await page.waitForSelector(
    ".ai-widget-canvas-preview .iw-relations path[marker-end]",
  );
  const dims = await page.$eval(".ai-widget-canvas-preview", (node) => ({
    width: node.clientWidth,
    height: node.clientHeight,
  }));
  assert.deepEqual(dims, { width: 700, height: 560 });
  assert.equal(
    (await (await fetch(url)).json()).elements.length,
    0,
    "Preview must not enter the saved scene",
  );
  await page.screenshot({ path: "/tmp/widget-redesign-creation.png" });
  // Prototype selection and linked explanation use the same runtime as saved content.
  await page.$eval(
    '.ai-widget-canvas-preview [aria-label="etcd · 集群状态"]',
    (node) => node.click(),
  );
  await page.waitForFunction(() =>
    document
      .querySelector(".ai-widget-canvas-preview")
      ?.textContent.includes("Raft"),
  );
  await page.waitForFunction(
    async (name) => {
      return new Promise((resolve) => {
        const request = indexedDB.open("excalidraw-widget-drafts", 1);
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const db = request.result;
          const read = db
            .transaction("drafts", "readonly")
            .objectStore("drafts")
            .getAll();
          read.onsuccess = () => {
            resolve(
              read.result.some(
                (draft) =>
                  draft.note === name &&
                  draft.candidates[draft.candidateIndex]?.state.selected ===
                    "etcd",
              ),
            );
            db.close();
          };
          read.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      });
    },
    { polling: 100 },
    filename,
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(".ai-widget-recovery");
  await click(page, "恢复未完成的组件草稿");
  await page.waitForSelector(".ai-widget-canvas-preview .iw-pressable");
  await page.waitForFunction(() =>
    document
      .querySelector(".ai-widget-canvas-preview")
      ?.textContent.includes("Raft"),
  );
  await click(page, "放入笔记", ".ai-widget-panel");
  const first = await saved(
    (element) => element.customData.aiWidget.state.selected === "etcd",
  );
  assert.equal(first.customData.aiWidget.version, 2);
  assert.equal(first.customData.embeddable.interaction, "controls");
  await page.waitForSelector(".excalidraw__embeddable-container .iw-pressable");
  // A real click (not synthetic activation or double-click) must reach a control.
  const node = await page.$(
    '.excalidraw__embeddable-container [aria-label="API Server"]',
  );
  await node.evaluate((element) => {
    const pane = element.closest(".iw-view");
    pane.scrollTop = Math.max(
      0,
      element.getBoundingClientRect().top -
        pane.getBoundingClientRect().top +
        pane.scrollTop -
        120,
    );
  });
  await clickElement(page, node);
  await saved(
    (element) => element.customData.aiWidget.state.selected === "api",
  );
  await page.keyboard.press("Delete");
  const camera = await page.$eval(
    ".excalidraw__embeddable-container",
    (node) => {
      const rect = node.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    },
  );
  await node.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await saved(
    (element) => element.customData.aiWidget.state.selected === "etcd",
  );
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await saved(
    (element) => element.customData.aiWidget.state.selected === "api",
  );
  assert.deepEqual(
    await page.$eval(".excalidraw__embeddable-container", (node) => {
      const rect = node.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    }),
    camera,
    "Autosave/undo must preserve the camera",
  );
  assert.ok(
    (await saved(() => true)).id === first.id,
    "Focused widget controls cannot trigger canvas Delete",
  );
  await page.screenshot({ path: "/tmp/widget-redesign-saved.png" });
  await click(page, "AI 修改", ".ai-widget-actions");
  await openExamples(page);
  await click(page, "请求处理 · 成功与重试", ".ai-widget-panel");
  await page.waitForSelector(".ai-widget-canvas-preview .iw-pressable");
  await click(page, "原版", ".ai-widget-panel");
  await page.waitForFunction(() =>
    document
      .querySelector(".ai-widget-canvas-preview")
      ?.textContent.includes("Kubernetes"),
  );
  await click(page, "候选版", ".ai-widget-panel");
  await page.waitForFunction(() =>
    document
      .querySelector(".ai-widget-canvas-preview")
      ?.textContent.includes("异步请求"),
  );
  assert.equal(
    (await saved(() => true)).customData.aiWidget.definition.title,
    first.customData.aiWidget.definition.title,
    "Candidates must not overwrite saved definitions",
  );
  await click(page, "确认应用修改", ".ai-widget-panel");
  await saved((element) =>
    element.customData.aiWidget.definition.title.includes("成功与重试"),
  );
  await click(page, "放大", ".ai-widget-actions");
  await page.waitForSelector(".ai-widget-expanded .iw-pressable");
  await page.$eval('.ai-widget-expanded [aria-label="执行任务"]', (element) =>
    element.click(),
  );
  await saved(
    (element) => element.customData.aiWidget.state.selected === "process",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector(".ai-widget-expanded"),
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          '.excalidraw__embeddable-container [aria-label="执行任务"]',
        )
        ?.getAttribute("aria-pressed") === "true",
  );
  console.log(
    "PASS direct controls, native undo/redo, stable viewport and enlarged state",
  );
  await click(page, "AI 修改", ".ai-widget-actions");
  await openExamples(page);
  for (const [title, heading] of [
    ["通用计算器", "通用计算器"],
    ["数据筛选", "按阈值筛选数据"],
    ["矩阵与二维变换", "二维线性变换"],
    ["Attention 演示", "Attention: softmax"],
  ]) {
    await click(page, title, ".ai-widget-panel");
    await page.waitForFunction(
      (text) =>
        document
          .querySelector(".ai-widget-canvas-preview")
          ?.textContent.includes(text) &&
        !document.querySelector(".ai-widget-canvas-preview .iw-error"),
      {},
      heading,
    );
  }
  await click(page, "上一候选", ".ai-widget-panel");
  await page.waitForFunction(() =>
    document
      .querySelector(".ai-widget-canvas-preview")
      ?.textContent.includes("二维线性变换"),
  );
  await click(page, "放弃草稿", ".ai-widget-panel");
  console.log(
    "PASS calculator, filtering, matrix, Attention and candidate rollback",
  );
  await click(page, "AI 修改", ".ai-widget-actions");
  await openExamples(page);
  await click(page, "场景联动 · 选择与解释", ".ai-widget-panel");
  await page.waitForSelector('.ai-widget-canvas-preview [role="radio"]');
  await click(page, "协作", ".ai-widget-canvas-preview");
  await page.waitForFunction(() =>
    document
      .querySelector(".ai-widget-canvas-preview")
      ?.textContent.includes("共享当前进展"),
  );
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () =>
      document.querySelector(
        '.ai-widget-canvas-preview [role="radio"][aria-checked="true"]',
      )?.textContent === "休息",
  );
  const trialText = ".ai-widget-canvas-preview textarea";
  await page.focus(trialText);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type("first line\nsecond line");
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await clickSelector(page, '.ai-widget-canvas-preview input[type="checkbox"]');
  await page.waitForFunction(() =>
    document
      .querySelector(".ai-widget-canvas-preview .iw-card")
      ?.textContent.includes("second line"),
  );
  await click(page, "放弃草稿", ".ai-widget-panel");
  assert.ok(
    !(await saved(() => true)).customData.aiWidget.definition.title.includes(
      "场景联动",
    ),
    "Discarded controls must not replace saved widget",
  );
  console.log(
    "PASS segmented mouse/keyboard selection, multiline input, conditional content and discard",
  );
  if (
    process.env.TEST_REAL_QWEN === "true" ||
    process.env.TEST_AI_FIXTURE === "true"
  ) {
    await click(page, "AI 修改", ".ai-widget-actions");
    await page.type(
      ".ai-widget-panel textarea",
      "保持所有节点和状态ID，只把标题修改为请求处理与重试演示。保持 diagram、点击解释和反馈关系，返回 version:2。",
    );
    await click(page, "生成组件", ".ai-widget-panel");
    await page.waitForSelector(".ai-widget-canvas-preview", {
      timeout: 150000,
    });
    if (process.env.TEST_AI_FIXTURE === "true") {
      await page.focus(".ai-widget-panel textarea");
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.keyboard.type("只把标题改为请求处理第二候选");
      await click(page, "生成下一候选", ".ai-widget-panel");
      await page.waitForFunction(() =>
        document
          .querySelector(".ai-widget-canvas-preview .iw-drag-handle")
          ?.textContent.includes("第二候选"),
      );
      assert.ok(
        !(
          await saved(() => true)
        ).customData.aiWidget.definition.title.includes("第二候选"),
        "AI candidates must remain outside the scene",
      );
      await click(page, "上一候选", ".ai-widget-panel");
      await page.waitForFunction(() =>
        document
          .querySelector(".ai-widget-canvas-preview .iw-drag-handle")
          ?.textContent.includes("请求处理与重试演示"),
      );
    }
    await click(page, "确认应用修改", ".ai-widget-panel");
    await saved(
      (element) =>
        element.customData.aiWidget.definition.title === "请求处理与重试演示",
    );
    console.log(
      process.env.TEST_AI_FIXTURE === "true"
        ? "PASS fixture-backed proxy generation, latest-candidate iteration and explicit apply"
        : "PASS real Qwen v2 design modification",
    );
  }
  const puts = [];
  await page.waitForSelector(".RepositorySyncStatus--synced");
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url() === url) {
      puts.push(request.url());
    }
  });
  const current = await fetch(url);
  const external = await current.json();
  const target = external.elements.find((element) => element.id === first.id);
  target.customData.aiWidget.state.selected = "queue";
  target.version++;
  assert.equal(
    (
      await fetch(url, {
        method: "PUT",
        headers: {
          "If-Match": current.headers.get("etag"),
          "X-Repository-Client-Id": "redesign-external-client",
        },
        body: JSON.stringify(external),
      })
    ).status,
    200,
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          '.excalidraw__embeddable-container [aria-label="进入队列"]',
        )
        ?.getAttribute("aria-pressed") === "true",
  );
  await sleep(1200);
  assert.equal(
    puts.length,
    0,
    "External scene changes must not be written back",
  );
  assert.deepEqual(
    await page.$eval(".excalidraw__embeddable-container", (node) => {
      const rect = node.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    }),
    camera,
  );
  console.log("PASS external SSE state and no save/reload loop");
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await page.focus(".excalidraw");
  await page.keyboard.down("Shift");
  await page.keyboard.press("1");
  await page.keyboard.up("Shift");
  await sleep(350);
  const bounds = await page.$eval(
    ".excalidraw__embeddable-container .iw-view",
    (node) => {
      const r = node.getBoundingClientRect();
      return {
        x: Math.max(50, Math.min(340, r.x + r.width / 2)),
        y: Math.max(160, Math.min(650, r.y + r.height / 2)),
        width: r.width,
      };
    },
  );
  const client = await page.target().createCDPSession();
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: bounds.x - 20, y: bounds.y, id: 1 },
      { x: bounds.x + 20, y: bounds.y, id: 2 },
    ],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: bounds.x - 50, y: bounds.y, id: 1 },
      { x: bounds.x + 50, y: bounds.y, id: 2 },
    ],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await sleep(350);
  const pinchedWidth = await page.$eval(
    ".excalidraw__embeddable-container .iw-view",
    (node) => node.getBoundingClientRect().width,
  );
  assert.ok(
    pinchedWidth > bounds.width * 1.3,
    "Two-finger pinch over a widget must zoom the native canvas",
  );
  await page.screenshot({ path: "/tmp/widget-redesign-mobile.png" });
  console.log("PASS mobile viewport and native embedded pinch routing");
  assert.deepEqual(errors, [], "Unexpected browser errors");
  console.log(
    "PASS v2 region preview, diagrams, draft refresh recovery, direct controls, Delete safety, explicit comparison/apply, shared enlarged state, persistence",
  );
})()
  .catch(async (error) => {
    console.error(error);
    const pages = await browser?.pages();
    const page = pages?.find((page) => page.url().startsWith(base));
    if (page) {
      console.log(
        await page.evaluate(() => document.body.innerText.slice(-2500)),
      );
      await page.screenshot({ path: "/tmp/widget-redesign-failed.png" });
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) {
      await browser.close();
    }
    if (process.env.TEST_NOTES_DIR !== "skip") {
      await fs
        .unlink(
          path.join(
            process.env.TEST_NOTES_DIR ||
              path.resolve(__dirname, "../../notes"),
            filename,
          ),
        )
        .catch((error) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        });
    }
  });

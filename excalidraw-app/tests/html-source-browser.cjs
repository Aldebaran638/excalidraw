/* Native canvas import acceptance on the fixed 3009 dataset. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const puppeteer = require("puppeteer-core");
const base = "http://127.0.0.1:3009";
const directory = path.resolve(__dirname, "../../.local-data/preview/notes");
const json = async (url, init) => {
  const response = await fetch(base + url, init);
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
};
const source =
  '<main id="app"><h1 id="title">源码计数器</h1><input id="task" placeholder="记录任务"><button id="increase">增加</button><output id="value"></output></main><script>(()=>{const render=()=>document.getElementById("value").textContent=String(NoteApp.get("count",0));NoteApp.on("count","app","click","#increase",()=>{NoteApp.set("count",NoteApp.get("count",0)+1);render()});render()})()</script>';
(async () => {
  const noteId = randomUUID();
  const filename = `__html-source-${noteId}.excalidraw`;
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
  const session = await json(`/api/notes/${noteId}/chats`, { method: "POST" });
  const artifactId = randomUUID();
  const ref = { kind: "html", artifactId, version: 1 };
  const chatRoot = path.join(directory, ".chats", noteId);
  const artifactRoot = path.join(chatRoot, "artifacts", session.id, artifactId);
  await fs.mkdir(artifactRoot, { recursive: true });
  session.messages = [
    {
      id: randomUUID(),
      turnId: randomUUID(),
      role: "assistant",
      status: "complete",
      content: "这是可导入的源码应用。",
      createdAt: Date.now(),
      blocks: [
        {
          id: randomUUID(),
          type: "html",
          ref,
          runtimeVersion: 2,
          complete: true,
          saved: true,
        },
      ],
    },
  ];
  await fs.writeFile(
    path.join(chatRoot, `${session.id}.json`),
    JSON.stringify(session),
  );
  await fs.writeFile(
    path.join(artifactRoot, "html-v1.json"),
    JSON.stringify({
      ...ref,
      noteId,
      sessionId: session.id,
      title: "源码计数器",
      source,
      complete: true,
      runtimeVersion: 2,
      revision: 0,
      state: { forms: {}, custom: {} },
      createdAt: Date.now(),
    }),
  );
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath:
        process.env.BROWSER_EXECUTABLE ||
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      pipe: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(String(error));
      console.log("browser error", String(error));
    });
    page.on("requestfailed", (request) =>
      console.log(
        "request failed",
        request.url(),
        request.failure()?.errorText,
      ),
    );
    page.on("response", (response) => {
      if (
        response.url().includes("/apps") &&
        response.request().method() === "POST"
      ) {
        void response.json().then((value) =>
          console.log("source write", response.status(), {
            version: value.version,
            error: value.error,
          }),
        );
      }
    });
    await page.setViewport({
      width: Number(process.env.HTML_DIALOG_WIDTH) || 1440,
      height: Number(process.env.HTML_DIALOG_HEIGHT) || 1000,
    });
    await page.evaluateOnNewDocument((filename) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", filename);
      }
    }, filename);
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
    console.log(
      "page loaded",
      await page.evaluate(() => ({
        width: innerWidth,
        text: document.body.innerText.slice(0, 350),
        buttons: document.querySelectorAll("button").length,
      })),
    );
    if (
      Number(process.env.HTML_DIALOG_WIDTH) > 0 &&
      Number(process.env.HTML_DIALOG_WIDTH) < 730
    ) {
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="main-menu-trigger"]')),
        { polling: 100, timeout: 120000 },
      );
      await page.click('[data-testid="main-menu-trigger"]');
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".dropdown-menu-item")].some((node) =>
            node.textContent.includes("笔记聊天"),
          ),
        { polling: 100 },
      );
      await page.evaluate(() =>
        [...document.querySelectorAll(".dropdown-menu-item")]
          .find((node) => node.textContent.includes("笔记聊天"))
          .click(),
      );
    } else {
      await page.waitForFunction(
        () => Boolean(document.querySelector('[aria-label="打开笔记聊天"]')),
        { polling: 100, timeout: 120000 },
      );
      await page.click('[aria-label="打开笔记聊天"]');
    }
    await page.waitForFunction(
      () => Boolean(document.querySelector(".note-chat-html-frame")),
      { polling: 100, timeout: 60000 },
    );
    const trial = await (await page.$(".note-chat-html-frame")).contentFrame();
    const actions = await page.$$eval(
      ".note-chat-html-card .html-app-actions button",
      (nodes) =>
        nodes.map((node) => ({
          label: node.getAttribute("aria-label"),
          text: node.textContent.trim(),
          icon: !!node.querySelector("svg"),
        })),
    );
    assert.deepEqual(
      actions.map((action) => action.label),
      ["放大试用", "查看代码", "重新运行", "继续修改", "导入笔记"],
    );
    assert.ok(actions.every((action) => !action.text && action.icon));
    await fs.mkdir(".local-data/acceptance/chat-ux", { recursive: true });
    await page.screenshot({
      path: ".local-data/acceptance/chat-ux/all-actions-desktop.png",
    });
    await trial.waitForFunction(
      () => Boolean(document.querySelector("#increase")),
      { polling: 100 },
    );
    if (process.env.HTML_POINTER_ONLY === "1") {
      await page.bringToFront();
      console.log(
        "host inert",
        await page.$eval(".note-chat-html-frame", (node) => ({
          inert: [...node.ownerDocument.querySelectorAll("[inert]")].map((n) =>
            n.outerHTML.slice(0, 120),
          ),
          ancestors: (() => {
            const out = [];
            for (let p = node; p; p = p.parentElement) {
              out.push({
                tag: p.tagName,
                attr: p.getAttribute("inert"),
                inert: p.inert,
                pointer: getComputedStyle(p).pointerEvents,
              });
            }
            return out;
          })(),
          modal: [...node.ownerDocument.querySelectorAll("dialog:modal")].map(
            (n) => n.className,
          ),
        })),
      );
      await trial.click("#increase");
      console.log(
        "native value",
        await trial.$eval("#value", (node) => node.textContent),
      );
      await trial.$eval("#increase", (node) => node.click());
      console.log(
        "program value",
        await trial.$eval("#value", (node) => node.textContent),
      );
      await trial.waitForFunction(
        () => document.querySelector("#value")?.textContent === "2",
        { polling: 100 },
      );
      console.log("PASS real pointer in seeded app");
      return;
    }
    await trial.$eval("#increase", (node) => node.click());
    await trial.$eval("#increase", (node) => node.click());
    await trial.$eval("#task", (node) => {
      node.value = "独立输入";
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector(".note-chat-html-card")
          .textContent.includes("源码已保存"),
      { polling: 100 },
    );
    if (process.env.HTML_SCROLLBAR_ONLY === "1") {
      await page.bringToFront();
      const before = await trial.evaluate(() => ({
        width: document.documentElement.clientWidth,
        viewport: innerWidth,
      }));
      assert.equal(before.width, before.viewport);
      await trial.evaluate(() => {
        const extra = document.createElement("div");
        extra.style.height = "1600px";
        extra.textContent = "浮动滚动条验收：不改变内容宽度";
        document.body.append(extra);
      });
      await trial.waitForFunction(
        () =>
          Boolean(document.querySelector("note-scrollbars")) &&
          document.documentElement.scrollHeight > innerHeight,
        { polling: 100 },
      );
      assert.equal(
        await trial.evaluate(() => document.documentElement.clientWidth),
        before.width,
      );
      await page.screenshot({
        path: ".local-data/acceptance/chat-ux/overlay-production.png",
      });
      const rect = await (await page.$(".note-chat-html-frame")).boundingBox();
      await page.mouse.move(rect.x + rect.width - 6, rect.y + 10);
      await page.mouse.down();
      await page.mouse.move(rect.x + rect.width - 6, rect.y + 220, {
        steps: 12,
      });
      await page.mouse.up();
      await trial.waitForFunction(() => scrollY > 100, { polling: 100 });
      assert.equal(
        await trial.$eval("#task", (node) => node.value),
        "独立输入",
      );
      console.log(
        "PASS production runtime: zero-gutter layout and real overlay-thumb dragging without input loss",
      );
      return;
    }
    if (process.env.HTML_DIALOG_ONLY === "1") {
      await page.evaluate(() => {
        window.__dialogFrame = document.querySelector(".note-chat-html-frame");
      });
      for (let cycle = 0; cycle < 3; cycle++) {
        await page.click('[aria-label="放大试用"]');
        await page.waitForFunction(
          () => Boolean(document.querySelector("dialog:modal")),
          { polling: 100 },
        );
        // Drain native queued close events before checking modal presentation.
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        const geometry = await page.$eval("dialog:modal", (node) => {
          const rect = node.getBoundingClientRect();
          return {
            expanded: node.classList.contains("is-expanded"),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            viewportWidth: node.ownerDocument.defaultView.innerWidth,
            viewportHeight: node.ownerDocument.defaultView.innerHeight,
            position: getComputedStyle(node).position,
          };
        });
        console.log("expanded dialog", geometry);
        await fs.mkdir(".local-data/acceptance/chat-ux", { recursive: true });
        await page.screenshot({
          path: `.local-data/acceptance/chat-ux/expanded-dialog-${cycle}.png`,
        });
        assert.ok(
          geometry.expanded,
          "queued inline-dialog close event must not clear expanded state",
        );
        assert.equal(geometry.position, "fixed");
        assert.ok(
          Math.abs(
            geometry.x - (geometry.viewportWidth - geometry.width) / 2,
          ) <= 2,
          "modal centers horizontally",
        );
        assert.ok(
          Math.abs(
            geometry.y - (geometry.viewportHeight - geometry.height) / 2,
          ) <= 2,
          "modal centers vertically",
        );
        assert.ok(
          geometry.width <= geometry.viewportWidth &&
            geometry.height <= geometry.viewportHeight,
        );
        assert.ok(
          await page.evaluate(
            () =>
              window.__dialogFrame ===
              document.querySelector("dialog:modal iframe"),
          ),
          "enlarging must keep the running iframe",
        );
        assert.equal(
          await trial.$eval("#task", (node) => node.value),
          "独立输入",
        );
        assert.equal(
          await trial.$eval("#value", (node) => node.textContent),
          "2",
        );
        if (cycle === 1) {
          await page.keyboard.press("Escape");
        } else {
          await page.click('[aria-label="关闭放大"]');
        }
        await page.waitForFunction(
          () =>
            !document.querySelector("dialog:modal") &&
            Boolean(
              document.querySelector(
                ".note-chat-html-dialog:not(.is-expanded)[open]",
              ),
            ),
          { polling: 100 },
        );
        assert.ok(
          await page.evaluate(
            () =>
              window.__dialogFrame ===
              document.querySelector(".note-chat-html-card iframe"),
          ),
          "closing must keep the running iframe",
        );
        assert.equal(
          await page.evaluate(() =>
            document.activeElement?.getAttribute("aria-label"),
          ),
          "放大试用",
          "closing returns keyboard focus without scrolling",
        );
      }
      console.log(
        "PASS modal centering, repeated open/close, Escape, and iframe/input state preservation",
      );
      return;
    }
    await page.evaluate(() =>
      [...document.querySelectorAll(".note-chat-html-card button")]
        .find((node) => node.getAttribute("aria-label") === "导入笔记")
        .click(),
    );
    await page
      .waitForFunction(() => document.body.textContent.includes("拖框放置"), {
        polling: 100,
      })
      .catch(async (error) => {
        console.log(
          await page.$$eval(".note-chat-inline-error", (nodes) =>
            nodes.map((node) => node.textContent),
          ),
        );
        throw error;
      });
    await page.mouse.move(160, 220);
    await page.mouse.down();
    await page.mouse.move(860, 700, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(
      () => Boolean(document.querySelector(".canvas-html-app iframe")),
      { polling: 100, timeout: 30000 },
    );
    console.log("native import ready");
    let canvas = await (await page.$(".canvas-html-app iframe")).contentFrame();
    await canvas.waitForFunction(
      () => document.getElementById("value")?.textContent === "2",
      { polling: 100 },
    );
    assert.equal(await canvas.$eval("#task", (node) => node.value), "独立输入");
    await canvas.$eval("#increase", (node) => node.click());
    await page.waitForFunction(
      () =>
        document.querySelector(".note-chat-target") ||
        document.body.textContent.includes("画布组件"),
      { polling: 100 },
    );
    // Wait for native debounced persistence by observing the actual note, not a fixed sleep.
    let saved;
    for (let attempt = 0; attempt < 30; attempt++) {
      saved = await json(`/api/notes/${filename}`);
      if (
        saved.elements.find(
          (e) =>
            !e.isDeleted && e.customData?.htmlApp?.state.custom.count === 3,
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const element = saved.elements.find(
      (e) => !e.isDeleted && e.customData?.htmlApp,
    );
    assert.equal(element.customData.htmlApp.state.custom.count, 3);
    assert.notEqual(element.customData.htmlApp.appId, artifactId);
    assert.equal(
      await fs.readFile(
        path.join(
          directory,
          ".apps",
          noteId,
          element.customData.htmlApp.appId,
          "versions",
          "1",
          "source.html",
        ),
        "utf8",
      ),
      source,
    );
    assert.equal(
      await trial.$eval("#value", (node) => node.textContent),
      "2",
      "canvas state must be independent",
    );
    console.log("independent source and input saved");
    await page.evaluate(
      () =>
        (window.__oldAppFrame = document.querySelector(
          ".canvas-html-app iframe",
        )),
    );
    await page.keyboard.down("Control");
    await page.keyboard.press("z");
    await page.keyboard.up("Control");
    await page.waitForFunction(
      () =>
        document.querySelector(".canvas-html-app iframe") !==
        window.__oldAppFrame,
      { polling: 100, timeout: 60000 },
    );
    canvas = await (await page.$(".canvas-html-app iframe")).contentFrame();
    await canvas.waitForFunction(
      () => document.getElementById("value")?.textContent === "2",
      { polling: 100, timeout: 10000 },
    );
    console.log("undo restored count");
    await page.evaluate(
      () =>
        (window.__oldAppFrame = document.querySelector(
          ".canvas-html-app iframe",
        )),
    );
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.press("z");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await page.waitForFunction(
      () =>
        document.querySelector(".canvas-html-app iframe") !==
        window.__oldAppFrame,
      { polling: 100, timeout: 10000 },
    );
    canvas = await (await page.$(".canvas-html-app iframe")).contentFrame();
    await canvas.waitForFunction(
      () => document.getElementById("value")?.textContent === "3",
      { polling: 100, timeout: 10000 },
    );
    console.log("redo restored count");
    await page.type(
      'textarea[aria-label="聊天消息"]',
      "请先用read_app_source读取这个画布应用，再用edit_app_source只把可见标题源码计数器改为已确认的源码计数器，其他代码不要改，不输出完整HTML。",
    );
    await page.click('[aria-label="发送消息"]');
    await page.waitForFunction(
      () => Boolean(document.querySelector(".html-app-candidate")),
      { polling: 100, timeout: 120000 },
    );
    console.log("real Qwen canvas candidate ready");
    assert.equal(
      await canvas.$eval("#title", (node) => node.textContent),
      "源码计数器",
      "candidate must not modify the formal app",
    );
    await canvas.$eval("#increase", (node) => node.click());
    await page.evaluate(() => {
      window.__oldAppFrame = document.querySelector(".canvas-html-app iframe");
      [...document.querySelectorAll(".html-app-candidate button")]
        .find((node) => node.getAttribute("aria-label") === "确认应用修改")
        .click();
    });
    await page
      .waitForFunction(
        () =>
          Boolean(document.querySelector(".canvas-html-app iframe")) &&
          document.querySelector(".canvas-html-app iframe") !==
            window.__oldAppFrame,
        { polling: 100, timeout: 60000 },
      )
      .catch(async (error) => {
        console.log(
          "apply errors",
          await page.$$eval(".note-chat-inline-error", (nodes) =>
            nodes.map((node) => node.textContent),
          ),
        );
        throw error;
      });
    const modified = await (
      await page.$(".canvas-html-app iframe")
    ).contentFrame();
    await modified
      .waitForFunction(
        () =>
          document.getElementById("title")?.textContent ===
          "已确认的源码计数器",
        { polling: 100, timeout: 30000 },
      )
      .catch(async (error) => {
        console.log(
          "modified app diagnostic",
          await modified.evaluate(() => ({
            title: document.getElementById("title")?.textContent,
            text: document.body?.textContent?.slice(0, 600),
          })),
        );
        throw error;
      });
    console.log("confirmed source update ready");
    assert.equal(
      await modified.$eval("#value", (node) => node.textContent),
      "4",
      "apply must preserve latest formal input",
    );
    assert.equal(
      await modified.$eval("#task", (node) => node.value),
      "独立输入",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        Boolean(
          document.querySelector(".canvas-html-app .note-chat-html-frame"),
        ),
      { polling: 100, timeout: 60000 },
    );
    const restored = await (
      await page.$(".canvas-html-app .note-chat-html-frame")
    ).contentFrame();
    await restored.waitForFunction(
      () => document.getElementById("value")?.textContent === "4",
      { polling: 100 },
    );
    await fs.mkdir(".local-data/acceptance/html-source", { recursive: true });
    await page.screenshot({
      path: ".local-data/acceptance/html-source/canvas-import.png",
      captureBeyondViewport: false,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS legacy HTML read, native placement, independent source/state, undo/redo, real Qwen targeted source candidate/confirmation, latest state preservation, refresh",
    );
  } finally {
    if (browser) {
      await browser.close();
    }
    await fs.unlink(path.join(directory, filename)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await fs.rm(chatRoot, { recursive: true, force: true });
    await fs.rm(path.join(directory, ".apps", noteId), {
      recursive: true,
      force: true,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/* Real layout acceptance on the fixed preview port; no model request. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const puppeteer = require("puppeteer-core");

const base = "http://127.0.0.1:3009";
const headers = {
  "X-Chat-Protocol": "3",
  "X-Chat-Capabilities": "html-blocks",
};
const json = async (url, init) => {
  const response = await fetch(base + url, { ...init, headers });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
};
(async () => {
  const directory = path.resolve(__dirname, "../../.local-data/preview/notes");
  assert.ok(
    !process.env.TEST_NOTES_DIR ||
      path.resolve(process.env.TEST_NOTES_DIR) === directory,
    "3009 always uses the fixed project-local preview dataset; do not switch its mount",
  );
  const noteId = randomUUID();
  const filename = `__sidebar-${noteId}.excalidraw`;
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
  const turnId = randomUUID();
  session.messages = Array.from({ length: 24 }, (_, index) => ({
    id: randomUUID(),
    turnId,
    role: index % 2 ? "assistant" : "user",
    status: "complete",
    createdAt: Date.now() + index,
    content: `布局回归样例 ${index}：中文长消息用于检查侧栏内部滚动，不应挤压或移动标签栏。`,
  }));
  session.messages.push({
    id: randomUUID(),
    turnId,
    role: "assistant",
    status: "complete",
    createdAt: Date.now() + 25,
    content: "可交互预览",
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
  });
  const root = path.join(directory, ".chats", noteId);
  const artifactRoot = path.join(root, "artifacts", session.id, artifactId);
  await fs.mkdir(artifactRoot, { recursive: true });
  await fs.writeFile(
    path.join(root, `${session.id}.json`),
    JSON.stringify(session),
  );
  await fs.writeFile(
    path.join(artifactRoot, "html-v1.json"),
    JSON.stringify({
      ...ref,
      formatVersion: 1,
      runtimeVersion: 2,
      noteId,
      sessionId: session.id,
      title: "布局验收",
      source:
        '<main id="app"><h2>布局验收</h2><label for="task">输入不会因布局丢失</label><input id="task"><button id="count">增加</button><output id="result">0</output></main><script>(()=>{NoteApp.patch("result",{text:String(NoteApp.get("count",0))});NoteApp.on("count","app","click","#count",()=>{const n=NoteApp.get("count",0)+1;NoteApp.set("count",n);NoteApp.patch("result",{text:String(n)})})})()</script>',
      complete: true,
      revision: 0,
      state: { forms: {}, custom: {} },
      createdAt: Date.now(),
    }),
  );
  const browser = await puppeteer.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    let modelRequests = 0;
    let noteWrites = 0;
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/turns")) {
        modelRequests++;
      }
      if (request.method() === "PUT" && request.url().includes("/api/notes/")) {
        noteWrites++;
      }
    });
    await page.evaluateOnNewDocument((filename) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", filename);
      }
    }, filename);
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('[aria-label="打开笔记聊天"]', {
      timeout: 120000,
    });
    await page.click('[aria-label="打开笔记聊天"]');
    await page.waitForSelector(".app-sidebar .note-chat-html-frame", {
      timeout: 60000,
    });
    await page.type('textarea[aria-label="聊天消息"]', "标签切换后保留的草稿");
    const firstPreview = await (
      await page.$(".note-chat-html-frame")
    ).contentFrame();
    await firstPreview.waitForFunction(
      () => Boolean(document.querySelector("#count")),
      { polling: 100 },
    );
    await firstPreview.$eval("#count", (node) => node.click());
    assert.equal(
      await firstPreview.$eval("#result", (node) => node.textContent),
      "1",
    );
    const names = [
      "search",
      "library",
      "note-chat",
      "comments",
      "presentation",
    ];
    const sample = () =>
      page.evaluate(() => {
        const shell = document.querySelector(".app-sidebar");
        const header = shell.querySelector(".sidebar__header");
        const tabs = shell.querySelector("[role=tablist]");
        const rect = (node) => {
          const r = node.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        const stable = window.__sidebarShell;
        const result = {
          shell: rect(shell),
          header: rect(header),
          tabs: rect(tabs),
          close: rect(shell.querySelector(".sidebar__close")),
          triggers: [...tabs.querySelectorAll("button")].map(rect),
          canvasUI: rect(
            document.querySelector(".layer-ui__wrapper") ||
              document.querySelector(".excalidraw"),
          ),
          docked: shell.classList.contains("sidebar--docked"),
          sameNodes:
            !stable ||
            (stable.shell === shell &&
              stable.header === header &&
              stable.tabs === tabs),
          rootWidth: getComputedStyle(
            document.querySelector(".excalidraw"),
          ).getPropertyValue("--right-sidebar-width"),
          shellWidth: getComputedStyle(shell).getPropertyValue(
            "--right-sidebar-width",
          ),
        };
        window.__sidebarShell = { shell, header, tabs };
        return result;
      });
    const select = async (index) => {
      await page.waitForFunction(
        () =>
          document.querySelector(".app-sidebar") ||
          document.querySelector('[data-testid="main-menu-trigger"]'),
        { polling: 100, timeout: 120000 },
      );
      if (!(await page.$(".app-sidebar"))) {
        if (await page.$('[aria-label="打开笔记聊天"]')) {
          await page.click('[aria-label="打开笔记聊天"]');
        } else {
          await page.click('[data-testid="main-menu-trigger"]');
          await page.evaluate(() =>
            Array.from(document.querySelectorAll(".dropdown-menu-item"))
              .find((node) => node.textContent.includes("笔记聊天"))
              .click(),
          );
        }
      }
      await page.waitForSelector(".app-sidebar [role=tab]");
      const triggers = await page.$$(".app-sidebar [role=tab]");
      await triggers[index].click();
      await page.waitForFunction(
        (index) =>
          document
            .querySelectorAll(".app-sidebar [role=tab]")
            [index]?.getAttribute("data-state") === "active",
        { polling: 100 },
        index,
      );
      // Measure two frames later so that intrinsic content and scrollbar layout
      // have settled; this catches shifts after the tab's initial paint too.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    };
    const compare = (actual, expected, label) => {
      assert.equal(actual.sameNodes, true, `${label}: shell must not remount`);
      for (const key of ["shell", "header", "tabs", "close", "canvasUI"]) {
        for (const field of ["x", "y", "width", "height"]) {
          assert.ok(
            Math.abs(actual[key][field] - expected[key][field]) <= 0.5,
            `${label}: ${key}.${field}: ${actual[key][field]} != ${expected[key][field]}`,
          );
        }
      }
      assert.deepEqual(
        actual.triggers,
        expected.triggers,
        `${label}: tab icons moved`,
      );
      assert.equal(actual.docked, expected.docked, `${label}: docking changed`);
      assert.equal(
        actual.rootWidth,
        actual.shellWidth,
        `${label}: canvas/sidebar width disagrees`,
      );
    };
    // Resize the actual native shell, then verify all tabs inherit that width.
    const original = await sample();
    const grip = await page.$(".app-sidebar-resize-handle");
    const gripBox = await grip.boundingBox();
    await page.mouse.move(gripBox.x + 3, gripBox.y + 200);
    await page.mouse.down();
    await page.mouse.move(gripBox.x - 177, gripBox.y + 200, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".excalidraw")
          .style.getPropertyValue("--right-sidebar-width") === "540px",
      { polling: 100 },
    );
    const widened = await sample();
    assert.equal(widened.shell.width, original.shell.width + 180);
    for (const index of [1, 3, 0, 4, 2]) {
      await select(index);
      compare(await sample(), widened, `resized/${names[index]}`);
    }
    // Clicking and drawing in the canvas must not dismiss the working panel.
    await page.mouse.click(600, 400);
    assert.ok(await page.$(".app-sidebar"));
    await page.waitForFunction(
      () => localStorage.getItem("aldebaran.sidebar-width") === "540",
      { polling: 100 },
    );
    await page.screenshot({
      path: "/tmp/sidebar-resize-desktop.png",
      captureBeyondViewport: false,
    });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
    await select(2);
    assert.equal((await sample()).rootWidth, "540px");
    await page.click(".sidebar__close");
    assert.equal(await page.$(".app-sidebar"), null);
    await select(2);
    assert.equal((await sample()).rootWidth, "540px");
    await page.focus(".app-sidebar-resize-handle");
    await page.keyboard.press("Home");
    await page.waitForFunction(
      () =>
        document
          .querySelector(".excalidraw")
          .style.getPropertyValue("--right-sidebar-width") === "328px",
      { polling: 100 },
    );
    await page.click(".app-sidebar-resize-handle", { clickCount: 2 });
    await page.waitForFunction(
      () =>
        document
          .querySelector(".excalidraw")
          .style.getPropertyValue("--right-sidebar-width") === "360px",
      { polling: 100 },
    );
    console.log(
      "resize, canvas click, keyboard, reset, reopen and persistence passed",
    );

    for (const [label, width, height, mobile] of [
      ["desktop", 1440, 1000, false],
      ["narrow", 900, 1000, false],
      ["phone", 390, 844, true],
      ["landscape", 640, 480, true],
    ]) {
      await page.setViewport({
        width,
        height,
        isMobile: mobile,
        hasTouch: mobile,
      });
      await select(2);
      const before = await sample();
      assert.ok(
        before.shell.x >= 0 &&
          before.shell.x + before.shell.width <= width + 0.5,
      );
      assert.ok(
        before.header.y >= before.shell.y &&
          before.header.y + before.header.height <=
            before.shell.y + before.shell.height,
      );
      for (const index of [1, 3, 2, 4, 0, 1, 2]) {
        await select(index);
        compare(await sample(), before, `${label}/${names[index]}`);
        if (label === "desktop" && [1, 2, 3].includes(index)) {
          await page.screenshot({
            path: `/tmp/sidebar-shell-${label}-${names[index]}.png`,
            captureBeyondViewport: false,
          });
        }
      }
      // Long chat is allowed to scroll, but its header and tab rail cannot.
      await page.evaluate(() => {
        document.querySelector(".note-chat-messages").scrollTop = 0;
      });
      compare(await sample(), before, `${label}/scroll`);
      const controlsVisible = await page.evaluate(() => {
        const panel = document
          .querySelector(".app-sidebar-chat-tab")
          .getBoundingClientRect();
        return [
          ".note-chat-send",
          ".note-chat-thinking",
          'textarea[aria-label="聊天消息"]',
        ].every((selector) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return (
            box.top >= panel.top &&
            box.bottom <= panel.bottom &&
            box.left >= panel.left &&
            box.right <= panel.right
          );
        });
      });
      assert.ok(
        controlsVisible,
        `${label}: composer controls must not be clipped`,
      );
      assert.equal(
        await page.$eval(
          'textarea[aria-label="聊天消息"]',
          (node) => node.value,
        ),
        "标签切换后保留的草稿",
      );
      await page.screenshot({
        path: `/tmp/sidebar-shell-${label}.png`,
        captureBeyondViewport: false,
      });
      console.log(
        JSON.stringify({
          label,
          shell: before.shell,
          header: before.header,
          tabs: before.tabs,
          stable: true,
        }),
      );
    }
    await page.setViewport({ width: 1440, height: 1000 });
    await select(2);
    const pin = await page.$(".sidebar__dock");
    assert.ok(pin);
    await pin.click();
    const pinned = await sample();
    assert.equal(pinned.docked, true);
    for (const index of [0, 1, 2, 3, 4, 2]) {
      await select(index);
      compare(await sample(), pinned, `pinned/${names[index]}`);
    }
    // Ensure the shell refactor did not clip away the composer or send action.
    const fit = await page.evaluate(() => {
      const shell = document
        .querySelector(".app-sidebar")
        .getBoundingClientRect();
      const send = document
        .querySelector(".note-chat-send")
        .getBoundingClientRect();
      return send.bottom <= shell.bottom && send.top >= shell.top;
    });
    assert.ok(fit);
    await page.$eval(".note-chat-messages", (node) => {
      node.scrollTop = node.scrollHeight;
    });
    const restoredPreview = await (
      await page.$(".note-chat-html-frame")
    ).contentFrame();
    await restoredPreview.waitForFunction(
      () => document.querySelector("#result")?.textContent === "1",
      { polling: 100 },
    );
    await page.screenshot({
      path: "/tmp/sidebar-shell-preview.png",
      captureBeyondViewport: false,
    });
    assert.equal(modelRequests, 0);
    assert.equal(noteWrites, 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: all five tabs retain shell/header/tab positions and canvas column; desktop, narrow, phone, landscape, scrolling and pinning; no AI request or note writes",
    );
  } finally {
    const force = setTimeout(() => browser.process()?.kill(), 5000);
    await browser.close();
    clearTimeout(force);
    // Only this run's UUID-named fixture, never the shared dataset itself.
    await fs.unlink(path.join(directory, filename));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

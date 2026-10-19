/* Independent browser acceptance. Never point TEST_NOTES_DIR at user notes. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const base = process.env.APP_URL || "http://127.0.0.1:3108";
const stamp = Date.now();
const names = [
  `__chat-browser-${stamp}-a.excalidraw`,
  `__chat-browser-${stamp}-b.excalidraw`,
];
const copyName = `__chat-browser-${stamp}-copy.excalidraw`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
const click = async (page, selector) => {
  const element = await page.waitForSelector(selector);
  await element.evaluate((node) => node.scrollIntoView({ block: "nearest" }));
  const box = await element.boundingBox();
  assert.ok(box);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};
const button = async (page, text, root = ".note-chat") => {
  const element = await page.evaluateHandle(
    (text, root) =>
      [...document.querySelector(root).querySelectorAll("button")].find(
        (node) => node.textContent.trim() === text,
      ),
    text,
    root,
  );
  assert.ok(element.asElement(), `Missing ${text}`);
  const box = await element.asElement().boundingBox();
  assert.ok(box);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};
const note = async (name) => (await fetch(`${base}/api/notes/${name}`)).json();
const identity = async (name) => {
  for (let i = 0; i < 50; i++) {
    const value = await note(name);
    if (value.repositoryMetadata) return value.repositoryMetadata.noteId;
    await sleep(100);
  }
  throw new Error("Identity was not saved");
};
const waitSession = async (noteId, sessionId) => {
  for (let i = 0; i < 300; i++) {
    const session = await (
      await fetch(`${base}/api/notes/${noteId}/chats/${sessionId}`)
    ).json();
    if (
      session.messages?.some((message) => message.role === "assistant") &&
      !session.messages.some((message) => message.status === "generating")
    )
      return session;
    await sleep(400);
  }
  throw new Error("Answer did not finish");
};
const openNote = async (page, name) => {
  await click(page, ".main-menu-trigger");
  await button(page, "Open repository note", ".dropdown-menu");
  await page.waitForSelector(".RepositoryNotesDialog__note");
  await page.evaluate(
    (name) =>
      [...document.querySelectorAll(".RepositoryNotesDialog__note")]
        .find((node) => node.textContent.includes(name))
        .click(),
    name,
  );
  await page.waitForFunction(
    () => !document.querySelector(".RepositoryNotesDialog"),
  );
  if (!(await page.$(".note-chat")))
    await click(page, '[aria-label="打开笔记聊天"]');
};
(async () => {
  assert.ok(process.env.BROWSER_EXECUTABLE);
  assert.ok(process.env.TEST_NOTES_DIR);
  const definition = {
    version: 2,
    title: "快照参数验收",
    initialState: { value: 42 },
    computations: {},
    root: {
      id: "root",
      type: "column",
      children: [
        { id: "value", type: "number", label: "当前参数", bind: "value" },
      ],
    },
  };
  const element = {
    id: "widget-current",
    type: "embeddable",
    x: 80,
    y: 140,
    width: 400,
    height: 200,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    groupIds: [],
    boundElements: [],
    locked: false,
    link: "https://widgets.excalidraw.local/widget-current",
    customData: {
      aiWidget: {
        version: 2,
        catalogVersion: 2,
        definition,
        state: { value: 42 },
        prompt: "test",
      },
      embeddable: { contentLocked: true, interaction: "controls" },
    },
  };
  for (const name of names)
    assert.equal(
      (
        await fetch(`${base}/api/notes/${name}`, {
          method: "PUT",
          headers: { "If-None-Match": "*" },
          body: JSON.stringify({
            type: "excalidraw",
            version: 2,
            elements: [element],
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
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.evaluateOnNewDocument((name) => {
    if (!sessionStorage.getItem("chat-test-initialized")) {
      localStorage.setItem("aldebaran.repository-note-name", name);
      sessionStorage.setItem("chat-test-initialized", "true");
    }
  }, names[0]);
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('.iw-view input[aria-label="当前参数"]', {
    timeout: 120000,
  });
  const box = () =>
    page.$eval(".excalidraw__embeddable-container", (node) => {
      const r = node.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    });
  const before = await box();
  await click(page, '[aria-label="打开笔记聊天"]');
  await page.waitForSelector(".note-chat-empty");
  assert.deepEqual(
    await box(),
    before,
    "Opening chat must not shift the canvas",
  );
  await button(page, "开启第一个会话");
  await page.waitForSelector('textarea[aria-label="聊天消息"]');
  const noteId = await identity(names[0]);
  let list = await (await fetch(`${base}/api/notes/${noteId}/chats`)).json();
  const firstId = list.sessions[0].id;
  console.log("PASS lazy note identity, native sidebar and stable viewport");
  // Pause only note PUTs, not Workers: prove the model reads unsaved canvas state.
  const cdp = await page.target().createCDPSession();
  await cdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*/api/notes/*.excalidraw", requestStage: "Request" },
    ],
  });
  cdp.on("Fetch.requestPaused", async (event) => {
    if (event.request.method === "PUT") await sleep(2500);
    await cdp
      .send("Fetch.continueRequest", { requestId: event.requestId })
      .catch(() => {});
  });
  await click(page, '.iw-view input[aria-label="当前参数"]');
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type("74");
  await page.type(
    'textarea[aria-label="聊天消息"]',
    "调用 read_note_elements 读取 widget-current，告诉我 aiWidget.state.value 的数值，不要猜默认值。请用中文简短回答。",
  );
  const request = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith("/turns"),
  );
  await button(page, "发送 ↑");
  const posted = JSON.parse((await request).postData());
  assert.equal(posted.snapshot.elements[0].customData.aiWidget.state.value, 74);
  assert.equal(
    (await note(names[0])).elements[0].customData.aiWidget.state.value,
    42,
    "Disk must still contain the old value at send time",
  );
  await click(page, '[aria-label="新建聊天会话"]');
  await page.waitForFunction(
    (firstId) =>
      document.querySelector('select[aria-label="聊天会话"]')?.value !==
      firstId,
    {},
    firstId,
  );
  const secondId = await page.$eval(
    'select[aria-label="聊天会话"]',
    (node) => node.value,
  );
  let answer = await waitSession(noteId, firstId);
  if (answer.messages.at(-1).status !== "complete") {
    console.log(
      "UPSTREAM first attempt failed; testing explicit user retry:",
      answer.messages.at(-1).error,
    );
    await page.select('select[aria-label="聊天会话"]', firstId);
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".note-chat button")].some(
        (node) => node.textContent === "重试最后一个问题",
      ),
    );
    const retried = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/turns"),
    );
    await button(page, "重试最后一个问题");
    await retried;
    await page.select('select[aria-label="聊天会话"]', secondId);
    answer = await waitSession(noteId, firstId);
    assert.equal(
      answer.messages.filter((message) => message.role === "user").length,
      1,
    );
  }
  assert.equal(
    answer.messages.at(-1).status,
    "complete",
    JSON.stringify(answer.messages.at(-1)),
  );
  assert.ok(answer.messages.at(-1).content.includes("74"));
  assert.ok(answer.messages.at(-1).activities.length > 0);
  assert.equal(
    await page.$eval(
      ".note-chat-messages",
      (node) => node.querySelectorAll("article").length,
    ),
    0,
    "Background answer must not appear in the new session",
  );
  await sleep(2700);
  await cdp.send("Fetch.disable");
  console.log(
    "PASS real Qwen tool reading of unsaved snapshot and background session isolation",
  );
  await page.type('textarea[aria-label="聊天消息"]', "未发送的独立草稿");
  await page.select('select[aria-label="聊天会话"]', firstId);
  await page.waitForFunction(() =>
    document.querySelector(".note-chat-messages")?.textContent.includes("74"),
  );
  await page.screenshot({ path: "/tmp/note-chat-desktop.png" });
  await page.select('select[aria-label="聊天会话"]', secondId);
  assert.equal(
    await page.$eval('textarea[aria-label="聊天消息"]', (node) => node.value),
    "未发送的独立草稿",
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('textarea[aria-label="聊天消息"]', {
    timeout: 120000,
  });
  assert.equal(
    await page.$eval('textarea[aria-label="聊天消息"]', (node) => node.value),
    "未发送的独立草稿",
  );
  console.log("PASS per-session draft switching and refresh recovery");
  await page.select('select[aria-label="聊天会话"]', firstId);
  await page.waitForFunction(() =>
    document.querySelector(".note-chat-messages")?.textContent.includes("74"),
  );
  await page.type(
    'textarea[aria-label="聊天消息"]',
    "再次用工具读取 widget-current 的当前参数，并用80字解释该数值。注意不要修改笔记。",
  );
  const background = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/turns"),
  );
  await button(page, "发送 ↑");
  await background;
  await openNote(page, names[1]);
  await page.waitForSelector(".note-chat-empty");
  assert.equal(
    await page.$eval(
      ".note-chat-messages",
      (node) => node.querySelectorAll("article").length,
    ),
    0,
  );
  await button(page, "开启第一个会话");
  const otherId = await identity(names[1]);
  assert.notEqual(otherId, noteId);
  const backgroundAnswer = await waitSession(noteId, firstId);
  assert.ok(
    ["complete", "failed"].includes(backgroundAnswer.messages.at(-1).status),
    "Switching notes must not abort the background turn",
  );
  assert.ok(backgroundAnswer.messages.length >= 4);
  assert.equal(
    (await fetch(`${base}/api/notes/${otherId}/chats/${firstId}`)).status,
    404,
  );
  await openNote(page, names[0]);
  await page.waitForSelector('select[aria-label="聊天会话"]');
  await page.select('select[aria-label="聊天会话"]', firstId);
  await page.waitForFunction(() =>
    document.querySelector(".note-chat-messages")?.textContent.includes("74"),
  );
  console.log(
    "PASS note switching, history restoration and foreign-session protection",
  );
  await click(page, '[aria-label="会话更多操作"]');
  await button(page, "重命名");
  await click(page, '.note-chat-dialog input[aria-label="会话名称"]');
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type("My note discussion");
  await button(page, "保存名称", ".note-chat-dialog");
  await page.waitForFunction(() =>
    [...document.querySelector('select[aria-label="聊天会话"]').options].some(
      (option) => option.text.includes("My note discussion"),
    ),
  );
  await page.select('select[aria-label="聊天会话"]', secondId);
  await click(page, '[aria-label="会话更多操作"]');
  await button(page, "删除会话");
  await button(page, "确认删除", ".note-chat-dialog");
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="聊天会话"]')?.options
        .length === 1,
  );
  assert.equal(
    (await fetch(`${base}/api/notes/${noteId}/chats/${secondId}`)).status,
    404,
  );
  console.log("PASS native rename/delete dialogs and persistent history");
  await click(page, ".main-menu-trigger");
  await button(page, "Save repository note as...", ".dropdown-menu");
  await click(page, ".RepositoryNotesDialog__save input");
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type(copyName);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => !document.querySelector(".RepositoryNotesDialog"),
  );
  if (!(await page.$(".note-chat")))
    await click(page, '[aria-label="打开笔记聊天"]');
  await page.waitForSelector(".note-chat-empty");
  assert.ok(
    !(await note(copyName)).repositoryMetadata,
    "Save As must not copy source identity",
  );
  await button(page, "开启第一个会话");
  const copyId = await identity(copyName);
  await page.waitForSelector('textarea[aria-label="聊天消息"]');
  assert.notEqual(copyId, noteId);
  const copyChats = await (
    await fetch(`${base}/api/notes/${copyId}/chats`)
  ).json();
  assert.equal(copyChats.sessions.length, 1);
  assert.equal(
    (
      await (
        await fetch(
          `${base}/api/notes/${copyId}/chats/${copyChats.sessions[0].id}`,
        )
      ).json()
    ).messages.length,
    0,
  );
  await openNote(page, names[0]);
  await page.waitForFunction(() =>
    document.querySelector(".note-chat-messages")?.textContent.includes("74"),
  );
  console.log("PASS Save As identity isolation without copying source chats");
  const delayed = await page.target().createCDPSession();
  let release;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  let heldOnce = false;
  delayed.on("Fetch.requestPaused", async (event) => {
    if (
      !heldOnce &&
      event.request.method === "PUT" &&
      event.request.url.endsWith(names[0])
    ) {
      heldOnce = true;
      release(event.requestId);
    } else
      await delayed
        .send("Fetch.continueRequest", { requestId: event.requestId })
        .catch(() => {});
  });
  await delayed.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*/api/notes/*.excalidraw", requestStage: "Request" },
    ],
  });
  await click(page, '.iw-view input[aria-label="当前参数"]');
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type("75");
  await page.focus('textarea[aria-label="聊天消息"]');
  const heldRequest = await Promise.race([
    paused,
    sleep(10000).then(() => {
      throw new Error("Autosave did not reach the controlled delay");
    }),
  ]);
  await openNote(page, names[1]);
  await delayed.send("Fetch.continueRequest", { requestId: heldRequest });
  await sleep(1200);
  assert.ok(
    await page.$eval(
      ".note-chat-header p",
      (node, name) => node.textContent.includes(name),
      names[1],
    ),
    "Late save must not rebind the new canvas to the old note",
  );
  assert.equal(
    (await note(names[0])).elements[0].customData.aiWidget.state.value,
    75,
  );
  await delayed.send("Fetch.disable");
  await openNote(page, names[0]);
  await page.waitForFunction(() =>
    document.querySelector(".note-chat-messages")?.textContent.includes("74"),
  );
  console.log(
    "PASS delayed autosave cannot rebind a different note or its chats",
  );
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: "dark" },
  ]);
  if (!(await page.$(".excalidraw.theme--dark"))) {
    await page.focus(".excalidraw");
    await page.keyboard.down("Shift");
    await page.keyboard.down("Alt");
    await page.keyboard.press("d");
    await page.keyboard.up("Alt");
    await page.keyboard.up("Shift");
  }
  await page.waitForSelector(".excalidraw.theme--dark");
  await page.screenshot({ path: "/tmp/note-chat-dark.png" });
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await sleep(500);
  const mobile = await page.$eval(".note-chat", (node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width };
  });
  assert.ok(
    mobile.x >= 0 &&
      mobile.right <= 390 &&
      mobile.bottom <= 844 &&
      mobile.width > 250,
    JSON.stringify(mobile),
  );
  await page.screenshot({ path: "/tmp/note-chat-mobile.png" });
  await click(page, ".sidebar__close");
  await click(page, ".main-menu-trigger");
  await button(page, "笔记聊天", ".dropdown-menu");
  await page.waitForSelector(".note-chat-composer");
  assert.deepEqual(errors, []);
  console.log("PASS mobile chat bounds, screenshots and no browser exceptions");
})()
  .catch(async (error) => {
    console.error(error);
    if (browser) {
      const pages = await browser.pages();
      const page = pages.at(-1);
      await page
        .screenshot({ path: "/tmp/note-chat-failed.png" })
        .catch(() => {});
      console.error(
        await page.$eval("body", (node) => node.innerText).catch(() => ""),
      );
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    if (process.env.TEST_NOTES_DIR)
      for (const name of [...names, copyName])
        await fs
          .unlink(path.join(process.env.TEST_NOTES_DIR, name))
          .catch(() => {});
  });

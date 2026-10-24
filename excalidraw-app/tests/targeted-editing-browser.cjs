/* Presentation/restore acceptance on the fixed preview; model calls have a
 * separate real-Qwen test. Only this script's UUID-scoped fixtures are removed. */
/* eslint-disable no-console */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");

const puppeteer = require("puppeteer-core");
const base = "http://127.0.0.1:3009";
const directory = path.resolve(__dirname, "../../.local-data/preview/notes");
const json = async (url, init) => {
  const response = await fetch(base + url, {
    ...init,
    headers: {
      "X-Chat-Protocol": "4",
      "X-Chat-Capabilities": "html-blocks",
      ...init?.headers,
    },
  });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
};
(async () => {
  const noteId = randomUUID();
  const filename = `__targeted-reliability-${noteId}.excalidraw`;
  let browser;
  const folder = path.join(directory, ".apps", noteId);
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
    const artifactId = randomUUID();
    const source =
      '<main id="app"><style>#app{--bad:var(--bad);border:1px solid var(--border);padding:16px;border-radius:12px}h1{font-size:20px}p{overflow-wrap:anywhere}</style><h1>候选续改验收</h1><p>可拖选的中文长文本与样式警告</p><input id="task" placeholder="记录任务"><button id="inc">增加</button><output id="value">0</output></main><script>(()=>{const render=()=>document.getElementById("value").textContent=String(NoteApp.get("n",0));NoteApp.on("counter","app","click","#inc",()=>{NoteApp.set("n",NoteApp.get("n",0)+1);render()});render()})()</script>';
    const hash = createHash("sha256").update(source).digest("hex");
    for (const version of [1, 2]) {
      const versionFolder = path.join(
        folder,
        artifactId,
        "versions",
        String(version),
      );
      await fs.mkdir(versionFolder, { recursive: true });
      await fs.writeFile(path.join(versionFolder, "source.html"), source);
      await fs.writeFile(
        path.join(versionFolder, "metadata.json"),
        JSON.stringify({
          kind: "html",
          formatVersion: 1,
          noteId,
          sessionId: session.id,
          artifactId,
          version,
          sourceHash: hash,
          title: "候选续改验收",
          complete: true,
          runtimeVersion: 2,
          revision: 0,
          createdAt: Date.now(),
          state: { forms: {}, custom: {} },
          candidateNumber: version - 1,
          styleDiagnostics: [
            {
              code: "css_variable_cycle",
              line: 1,
              column: 30,
              message: "CSS 变量自引用：--bad → --bad",
              excerpt: "--bad:var(--bad)",
            },
          ],
          ...(version === 2
            ? { editBase: { kind: "html", artifactId, version: 1 } }
            : {}),
        }),
      );
    }
    session.revision++;
    session.appWorkspace = {
      generation: randomUUID(),
      selection: { kind: "html", artifactId, version: 1 },
      base: { kind: "html", artifactId, version: 1 },
      baseHash: hash,
      head: { kind: "html", artifactId, version: 2 },
      candidateNumber: 1,
    };
    session.messages = [
      {
        id: randomUUID(),
        turnId: randomUUID(),
        role: "assistant",
        content: "真实工具结果与候选预览",
        status: "complete",
        createdAt: Date.now(),
        blocks: [
          {
            id: randomUUID(),
            type: "text",
            text: "真实工具结果与候选预览：这段文字可以直接选择复制。",
          },
          {
            id: randomUUID(),
            type: "protocol",
            text: "<tool_call><function=edit_app_source>正文不会执行</function></tool_call>",
            status: "resolved",
          },
          {
            id: randomUUID(),
            type: "html",
            ref: { kind: "html", artifactId, version: 2 },
            complete: true,
            saved: true,
            runtimeVersion: 2,
            candidateNumber: 1,
          },
          {
            id: randomUUID(),
            type: "edit_result",
            text: "候选已保存，尚未应用；请预览并确认",
          },
        ],
      },
    ];
    await fs.writeFile(
      path.join(directory, ".chats", noteId, `${session.id}.json`),
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
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(String(error));
      console.log("pageerror", String(error));
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument((name) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", name);
      }
    }, filename);
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('[aria-label="打开笔记聊天"]', {
      timeout: 120000,
    });
    await page.click('[aria-label="打开笔记聊天"]');
    await page.waitForSelector(".note-chat-html-frame", { timeout: 60000 });
    await page.waitForFunction(() =>
      document
        .querySelector(".note-chat-workspace")
        ?.textContent.includes("候选第 1 版"),
    );
    const shell = await page.$eval(".note-chat", (node) => {
      const r = node.getBoundingClientRect();
      return { width: r.width, x: r.x };
    });
    assert.ok(
      await page.$eval(".note-chat-messages", (node) =>
        node.textContent.includes("未执行的调用已通过真实工具补正"),
      ),
    );
    assert.ok(
      await page.$eval(".note-chat-html-card", (node) =>
        node.textContent.includes("样式警告 1 项"),
      ),
    );
    assert.ok(
      await page.$eval(
        ".note-chat-messages",
        (node) =>
          getComputedStyle(node.querySelector(".note-chat-message"))
            .userSelect !== "none",
      ),
    );
    const iframe = await (await page.$(".note-chat-html-frame")).contentFrame();
    await iframe.waitForSelector("#task");
    await iframe.type("#task", "保留输入");
    await iframe.click("#inc");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await page.bringToFront();
    assert.equal(
      await page.$$eval(".sidebar-tabs-root", (nodes) => nodes.length),
      1,
      "fallback must not cover the real sidebar",
    );
    assert.ok(
      await page.$eval('[aria-label="更换目标或编辑起点"]', (button) => {
        const rect = button.getBoundingClientRect();
        return button.contains(
          button.ownerDocument.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        );
      }),
      "editing action must receive real pointer hits",
    );
    await fs.mkdir(".local-data/acceptance/targeted-reliability", {
      recursive: true,
    });
    await page.screenshot({
      path: ".local-data/acceptance/targeted-reliability/desktop.png",
    });
    await page.click('[aria-label="更换目标或编辑起点"]');
    await page.waitForSelector('[aria-label="选择编辑起点"]');
    assert.ok(await page.$('[aria-label="选择编辑起点"]'));
    const after = await page.$eval(".note-chat", (node) => {
      const r = node.getBoundingClientRect();
      return { width: r.width, x: r.x };
    });
    assert.deepEqual(after, shell);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (!(await page.$(".note-chat-html-frame"))) {
      await page.waitForSelector('[aria-label="打开笔记聊天"]');
      await page.click('[aria-label="打开笔记聊天"]');
    }
    await page.waitForSelector(".note-chat-html-frame");
    const restored = await (
      await page.$(".note-chat-html-frame")
    ).contentFrame();
    await restored.waitForFunction(
      () => document.querySelector("#task")?.value === "保留输入",
    );
    assert.equal(
      await restored.$eval("#value", (node) => node.textContent),
      "1",
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
    await page.screenshot({
      path: ".local-data/acceptance/targeted-reliability/dark.png",
    });
    await page.setViewport({ width: 430, height: 900 });
    await page.screenshot({
      path: ".local-data/acceptance/targeted-reliability/narrow.png",
    });
    assert.ok(!errors.length, errors.join("\n"));
    console.log(
      "PASS warnings, folded fake calls, candidate restore, state persistence, stable shell, dark/narrow presentation",
    );
  } finally {
    await browser?.close();
    await fs.rm(path.join(directory, filename), { force: true });
    await fs.rm(path.join(directory, ".chats", noteId), {
      recursive: true,
      force: true,
    });
    await fs.rm(folder, { recursive: true, force: true });
    console.log(`Removed only acceptance note/chat/app ${noteId}`);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/* Real Qwen, one ordinary response per app. No mock output or automatic repair. */
/* eslint-disable no-console */
/* global HTMLRuntime, NoteApp */
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { buildSync } = require("esbuild");
const puppeteer = require("puppeteer-core");
const base = "http://127.0.0.1:3009";
const headers = {
  "X-Chat-Protocol": "3",
  "X-Chat-Capabilities": "html-blocks",
};
const json = async (url, init) => {
  const r = await fetch(base + url, { ...init, headers });
  const d = await r.json();
  assert.ok(r.ok, JSON.stringify(d));
  return d;
};
(async () => {
  assert.ok(
    process.env.TEST_NOTES_DIR?.startsWith("/tmp/excalidraw-chat-html-"),
  );
  assert.equal((await json("/api/ai/status")).model, "qwen3.8-27b");
  const bundle = buildSync({
    entryPoints: ["excalidraw-app/data/htmlRuntime.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "HTMLRuntime",
    minify: true,
  }).outputFiles[0].text;
  const browser = await puppeteer.launch({
    executablePath:
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    for (const [kind, request] of [
      [
        "pomodoro",
        "番茄钟。输入 id=task，开始按钮 id=start，时间 id=remaining。早期安装 NoteApp.on/interval，保存绝对 deadline；后半段用 NoteApp.patch 修改 title 为“小番茄 · Focus”和配色；不要重建已输出结构。",
      ],
      [
        "calculator",
        "加法计算器，两个数字输入 id=a 和 id=b，结果 id=result，即时计算。尽早安装 NoteApp.on 委托 input，再输出控件；后半段 patch 标题和颜色。",
      ],
      [
        "architecture",
        "架构联动讲解：按钮 id=client 和 id=server，点击更新 id=explanation 的解释文字。尽早安装事件委托，之后继续输出关系箭头、卡片和说明，最后 patch 标题和颜色。",
      ],
    ]) {
      const noteId = randomUUID();
      const filename = `__contract-${kind}-${noteId}.excalidraw`;
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
      const url = `/api/notes/${noteId}/chats/${session.id}`;
      const page = await browser.newPage();
      await page.setViewport({ width: 750, height: 900 });
      await page.setContent("<body></body>");
      await page.addScriptTag({ content: bundle });
      await page.evaluate(() => {
        window.events = [];
        window.queue = [];
        window.ready = false;
        window.finished = false;
        const iframe = document.createElement("iframe");
        iframe.sandbox = "allow-scripts";
        iframe.width = "700";
        iframe.height = "800";
        window.appFrame = iframe;
        window.flush = () => {
          if (!window.ready) {
            return;
          }
          for (const data of window.queue.splice(0)) {
            iframe.contentWindow.postMessage(
              { token: "real", type: "append", data },
              "*",
            );
          }
          if (window.finished) {
            iframe.contentWindow.postMessage(
              { token: "real", type: "finish" },
              "*",
            );
          }
        };
        window.addEventListener("message", (e) => {
          if (e.source !== iframe.contentWindow) {
            return;
          }
          window.events.push(e.data);
          if (e.data.type === "ready") {
            window.ready = true;
            window.flush();
          }
        });
        document.body.append(iframe);
        iframe.srcdoc = HTMLRuntime.htmlBootstrap(
          "real",
          { forms: {}, custom: {} },
          2,
        );
      });
      const response = await fetch(`${base + url}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          turnId: randomUUID(),
          revision: session.revision,
          content: `请生成自包含、简洁美观的交互HTML应用（尽量120行内），只输出一个html围栏。${request} 根容器id=app，标题id=title；IIFE脚本，使用运行时v2生命周期契约，分小段完整script安装，不把交互全部堆在最后。不调用组件工具。`,
          snapshot: { capturedAt: Date.now(), elements: [] },
        }),
      });
      assert.ok(response.ok);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let final;
      let visibleBeforeEnd = false;
      let earlyAction = false;
      let chunkCount = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const line = buffer
            .slice(0, end)
            .split("\n")
            .find((l) => l.startsWith("data: "));
          buffer = buffer.slice(end + 2);
          if (!line) {
            continue;
          }
          const event = JSON.parse(line.slice(6));
          if (event.type === "block" && event.block?.type === "html") {
            if (event.blockDelta) {
              chunkCount++;
              await page.evaluate((text) => {
                window.queue.push(text);
                window.flush();
              }, event.blockDelta);
              const frame = page.frames().find((f) => f.parentFrame());
              if (frame) {
                visibleBeforeEnd ||= await frame.evaluate(
                  () => !!document.querySelector("h2,h1,button,input"),
                );
                if (!earlyAction && kind === "pomodoro") {
                  earlyAction = await frame.evaluate(() => {
                    const task = document.getElementById("task");
                    const start = document.getElementById("start");
                    if (!task || !start) {
                      return false;
                    }
                    task.value = "真实流式输入";
                    task.focus();
                    task.dispatchEvent(new Event("input", { bubbles: true }));
                    start.click();
                    return (
                      Math.max(
                        Number(NoteApp.get("deadline", 0)),
                        Number(NoteApp.get("pomodoro", {}).deadline || 0),
                      ) > Date.now()
                    );
                  });
                }
              }
            }
            if (event.block.complete) {
              await page.evaluate(() => {
                window.finished = true;
                window.flush();
              });
            }
          }
          if (event.type === "done") {
            final = event;
          }
        }
      }
      assert.ok(final?.saved, JSON.stringify(final));
      assert.equal(final.message.status, "complete", final.message.error);
      const block = final.message.blocks.find((b) => b.type === "html");
      assert.ok(block?.saved);
      const artifact = await json(
        `${url}/html-artifacts/${block.ref.artifactId}?version=1`,
      );
      await page.waitForFunction(
        () => window.events.some((e) => e.type === "complete"),
        { polling: 100, timeout: 10000 },
      );
      const frame = page.frames().find((f) => f.parentFrame());
      if (kind === "calculator") {
        await frame.evaluate(() => {
          for (const [id, value] of [
            ["a", "7"],
            ["b", "8"],
          ]) {
            const n = document.getElementById(id);
            n.value = value;
            n.dispatchEvent(new Event("input", { bubbles: true }));
          }
        });
        assert.match(await frame.$eval("#result", (n) => n.textContent), /15/);
      } else if (kind === "architecture") {
        const before = await frame.$eval("#explanation", (n) => n.textContent);
        await frame.$eval("#server", (n) => n.click());
        assert.notEqual(
          await frame.$eval("#explanation", (n) => n.textContent),
          before,
        );
      } else if (earlyAction) {
        assert.equal(
          await frame.$eval("#task", (n) => n.value),
          "真实流式输入",
        );
        assert.ok(
          await frame.evaluate(
            () =>
              Math.max(
                Number(NoteApp.get("deadline", 0)),
                Number(NoteApp.get("pomodoro", {}).deadline || 0),
              ) > Date.now(),
          ),
        );
      }
      const errors = await page.evaluate(() =>
        window.events.filter((e) => e.type === "error"),
      );
      if (kind === "pomodoro") {
        assert.ok(
          earlyAction,
          "real model must install a working action before the response ends",
        );
        const before = await frame.evaluate(() => ({
          direct: NoteApp.get("deadline", null),
          nested: NoteApp.get("pomodoro", null),
        }));
        const state = await page.evaluate(
          () =>
            window.events.filter((e) => e.type === "state").at(-1)?.data || {
              forms: {},
              custom: {},
            },
        );
        await page.evaluate(
          ({ source, state }) => {
            const iframe = document.createElement("iframe");
            iframe.sandbox = "allow-scripts";
            window.restoredFrame = iframe;
            window.restoredEvents = [];
            window.addEventListener("message", (e) => {
              if (e.source !== iframe.contentWindow) {
                return;
              }
              window.restoredEvents.push(e.data);
              if (e.data.type === "ready") {
                iframe.contentWindow.postMessage(
                  { token: "restored", type: "append", data: source },
                  "*",
                );
                iframe.contentWindow.postMessage(
                  { token: "restored", type: "finish" },
                  "*",
                );
              }
            });
            document.body.append(iframe);
            iframe.srcdoc = HTMLRuntime.htmlBootstrap("restored", state, 2);
          },
          { source: artifact.source, state },
        );
        await page.waitForFunction(
          () => window.restoredEvents.some((e) => e.type === "complete"),
          { polling: 100, timeout: 10000 },
        );
        const restored = await (
          await page.$("iframe:last-of-type")
        ).contentFrame();
        assert.deepEqual(
          await restored.evaluate(() => ({
            direct: NoteApp.get("deadline", null),
            nested: NoteApp.get("pomodoro", null),
          })),
          before,
          "real source must not reset persisted timing on restoration",
        );
        assert.equal(
          await restored.$eval("#task", (n) => n.value),
          "真实流式输入",
        );
        await page.evaluate(() => window.restoredFrame.remove());
      }
      await page.screenshot({
        path: `/tmp/html-contract-real-${kind}.png`,
        captureBeyondViewport: false,
      });
      console.log(
        JSON.stringify({
          kind,
          visibleBeforeEnd,
          earlyAction,
          chunkCount,
          bytes: artifact.source.length,
          usesContract: artifact.source.includes("NoteApp.on"),
          usesPatch: artifact.source.includes("NoteApp.patch"),
          errors,
        }),
      );
      assert.equal(errors.length, 0);
      assert.ok(visibleBeforeEnd);
      await page.close();
    }
  } finally {
    const forceClose = setTimeout(() => browser.process()?.kill(), 5000);
    await browser.close();
    clearTimeout(forceClose);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

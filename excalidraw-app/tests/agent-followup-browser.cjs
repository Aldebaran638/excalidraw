/* One real Qwen loop, using a uniquely named fixture on the fixed 3009 data. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const { chromium } = require("playwright-core");

const base = "http://127.0.0.1:3009";
const directory = path.resolve(".local-data/preview/notes");
const output = path.resolve(".local-data/acceptance/agent-followup");
const source = `<main id="app">
<h1 id="app-title">MVCC 业务场景实验室</h1>
<label for="task">学习笔记</label><input id="task">
<div class="row"><button id="rc">RC</button><button id="rr">RR</button></div>
<p id="mode"></p>
<section id="examples"><h2>实际使用例子</h2>
<article id="rc-case"><h3>RC</h3><p>下单前查一次商品价格，再写入订单。</p></article>
<article id="rr-case"><h3>RR</h3><p>对账时在同一事务查余额与流水。</p></article></section>
</main><script>(()=>{const render=()=>document.getElementById('mode').textContent=NoteApp.get('mode','RC');NoteApp.on('mode','app','click','button',(_,node)=>{NoteApp.set('mode',node.id==='rr'?'RR':'RC');render()});render()})()</script>`;
const hash = createHash("sha256").update(source).digest("hex");
const headers = {
  "Content-Type": "application/json",
  "X-Chat-Protocol": "9",
  "X-Chat-Capabilities": "html-blocks,preview-feedback,interaction-probes",
};
async function json(url, init = {}) {
  const response = await fetch(base + url, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  const data = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(data)}`);
  return data;
}
async function until(fn, timeout = 30000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const result = await fn();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("follow-up acceptance timed out");
}
async function click(page, locator) {
  await page.bringToFront();
  await locator.evaluate((node) =>
    node.scrollIntoView({ block: "center", inline: "center" }),
  );
  await locator.click();
}
(async () => {
  const noteId = randomUUID();
  const appId = randomUUID();
  const elementId = randomUUID();
  const filename = `__agent-followup-${noteId}.excalidraw`;
  let browser;
  let sessionId;
  try {
    const state = {
      forms: { task: { type: "text", value: "保留已有学习笔记" } },
      custom: { mode: "RR" },
    };
    const app = {
      formatVersion: 1,
      appId,
      version: 1,
      sourceHash: hash,
      sourceSnapshot: source,
      title: "MVCC 业务场景实验室",
      runtimeVersion: 3,
      state,
    };
    await json(`/api/notes/${filename}`, {
      method: "PUT",
      body: JSON.stringify({
        type: "excalidraw",
        version: 2,
        repositoryMetadata: { version: 1, noteId },
        files: {},
        appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } },
        elements: [
          {
            id: elementId,
            type: "embeddable",
            x: 100,
            y: 160,
            width: 650,
            height: 480,
            angle: 0,
            strokeColor: "#6965db",
            backgroundColor: "transparent",
            fillStyle: "solid",
            strokeWidth: 1,
            strokeStyle: "solid",
            roughness: 0,
            opacity: 100,
            groupIds: [],
            frameId: null,
            roundness: null,
            seed: 1,
            version: 1,
            versionNonce: 1,
            isDeleted: false,
            boundElements: null,
            updated: Date.now(),
            link: `https://apps.excalidraw.local/${elementId}`,
            locked: false,
            customData: {
              htmlApp: app,
              embeddable: {
                snapshotRequired: true,
                keepAlive: true,
                contentLocked: true,
                interaction: "controls",
                snapshot:
                  '<svg xmlns="http://www.w3.org/2000/svg" width="650" height="480"/>',
              },
            },
          },
        ],
      }),
    });
    const session = await json(`/api/notes/${noteId}/chats`, {
      method: "POST",
    });
    sessionId = session.id;
    const folder = path.join(
      directory,
      ".apps",
      noteId,
      appId,
      "versions",
      "1",
    );
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "source.html"), source);
    await fs.writeFile(
      path.join(folder, "metadata.json"),
      JSON.stringify({
        formatVersion: 1,
        runtimeVersion: 3,
        kind: "html",
        artifactId: appId,
        version: 1,
        noteId,
        sessionId,
        title: app.title,
        complete: true,
        revision: 0,
        state,
        sourceHash: hash,
        createdAt: Date.now(),
      }),
    );
    await fs.writeFile(
      path.join(directory, ".apps", noteId, appId, "manifest.json"),
      JSON.stringify({ formatVersion: 1, appId, noteId, versions: [1] }),
    );
    const precedingTurn = randomUUID();
    session.messages = [
      {
        id: randomUUID(),
        turnId: precedingTurn,
        role: "user",
        content: "补充MVCC中RR和RC的两个实际使用例子",
        createdAt: Date.now() - 2000,
        status: "complete",
      },
      {
        id: randomUUID(),
        turnId: precedingTurn,
        role: "assistant",
        content: "已补充下单与对账两个例子。",
        createdAt: Date.now() - 1000,
        status: "complete",
        activities: [
          {
            id: randomUUID(),
            name: "edit_app_source",
            status: "complete",
            elementIds: [],
            snapshotAt: Date.now() - 2000,
          },
        ],
        // Deliberately legacy metadata: reproduce the user's pre-fix context.
        blocks: [
          {
            id: randomUUID(),
            type: "edit_result",
            text: "候选已保存",
            application: { elementId, appId, sourceHash: hash },
          },
        ],
      },
    ];
    session.appWorkspace = {
      generation: randomUUID(),
      selection: { kind: "element", elementId },
      candidateNumber: 0,
    };
    const sessionFile = path.join(
      directory,
      ".chats",
      noteId,
      `${sessionId}.json`,
    );
    await fs.writeFile(`${sessionFile}.fixture.tmp`, JSON.stringify(session));
    await fs.rename(`${sessionFile}.fixture.tmp`, sessionFile);
    browser = await chromium.launch({
      executablePath:
        process.env.BROWSER_EXECUTABLE ||
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(45000);
    await page.addInitScript((name) => {
      // Playwright also injects init scripts into child frames. Repository
      // selection belongs to the host, never the opaque app sandbox.
      if (window !== window.top) {
        return;
      }
      localStorage.setItem("aldebaran.repository-note-name", name);
      window.followupPreviews = [];
      window.addEventListener("message", (event) => {
        if (
          event.data?.type === "preview" &&
          event.source ===
            document.querySelector(".canvas-html-app iframe")?.contentWindow
        ) {
          window.followupPreviews.push(event.data.data);
        }
      });
    }, filename);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "打开笔记聊天", exact: true })
      .click({ timeout: 120000 });
    const formal = page.frameLocator(".canvas-html-app iframe");
    await formal.locator("#app-title").waitFor();
    assert.equal(
      await formal.locator("#task").inputValue(),
      state.forms.task.value,
    );
    assert.equal(await formal.locator("#mode").textContent(), "RR");
    const baseline = await until(() =>
      page.evaluate(() => window.followupPreviews.at(-1)),
    );
    assert.deepEqual(
      baseline.errors,
      [],
      "fixture must be valid before using Qwen",
    );
    await page
      .getByRole("textbox", { name: "聊天消息", exact: true })
      .fill(
        "你理解错了，我说的实际使用例子指的是，一般什么业务场景使用RR，什么使用RC",
      );
    await click(
      page,
      page.getByRole("button", { name: "发送消息", exact: true }),
    );
    const answer = await until(async () => {
      const latest = await json(`/api/notes/${noteId}/chats/${sessionId}`);
      const message = latest.messages.at(-1);
      return message.role === "assistant" &&
        message.turnId !== precedingTurn &&
        message.status !== "generating"
        ? message
        : null;
    }, 650000);
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, `real-result-${noteId}.json`),
      JSON.stringify(answer, null, 2),
    );
    assert.equal(answer.status, "complete", answer.error);
    assert.equal(answer.agentTask.kind, "edit");
    assert.ok(
      answer.activities.some(
        (tool) => tool.name === "read_app_source" && tool.status === "complete",
      ),
    );
    assert.ok(
      answer.activities.some(
        (tool) => tool.name === "edit_app_source" && tool.status === "complete",
      ),
    );
    const candidate = answer.blocks.findLast(
      (block) => block.type === "html" && block.saved,
    );
    assert.ok(candidate, "no saved candidate");
    assert.equal(candidate.preview?.status, "checked");
    const data = await json(
      `/api/notes/${noteId}/chats/${sessionId}/html-artifacts/${candidate.ref.artifactId}?version=${candidate.ref.version}`,
    );
    assert.notEqual(data.sourceHash, hash);
    assert.equal(data.target.elementId, elementId);
    const before = await json(`/api/notes/${filename}`);
    assert.equal(
      before.elements[0].customData.htmlApp.sourceHash,
      hash,
      "model changed the canvas without confirmation",
    );
    await fs.writeFile(path.join(output, "candidate.html"), data.source);
    await click(
      page,
      page
        .locator(".html-app-candidate")
        .last()
        .getByRole("button", { name: "确认应用修改", exact: true }),
    );
    const saved = await until(async () => {
      const note = await json(`/api/notes/${filename}`);
      return note.elements.find((element) => element.id === elementId)
        ?.customData?.htmlApp?.sourceHash === data.sourceHash
        ? note
        : null;
    });
    const element = saved.elements.find((e) => e.id === elementId);
    assert.deepEqual(
      [element.x, element.y, element.width, element.height],
      [100, 160, 650, 480],
    );
    await until(
      async () =>
        (await formal.locator("#task").inputValue()) === state.forms.task.value,
    );
    assert.equal(await formal.locator("#mode").textContent(), "RR");
    await click(page, formal.locator("#rc"));
    await until(
      async () => (await formal.locator("#mode").textContent()) === "RC",
    );
    await until(async () => {
      const note = await json(`/api/notes/${filename}`);
      return (
        note.elements.find((e) => e.id === elementId)?.customData?.htmlApp
          ?.state.custom.mode === "RC"
      );
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await formal.locator("#app-title").waitFor();
    assert.equal(
      await formal.locator("#task").inputValue(),
      state.forms.task.value,
    );
    await until(
      async () => (await formal.locator("#mode").textContent()) === "RC",
    );
    console.log(
      JSON.stringify({
        ok: true,
        fixture: filename,
        task: answer.agentTask,
        tools: answer.activities.map((tool) => ({
          name: tool.name,
          status: tool.status,
        })),
        preview: candidate.preview,
        manualApply: true,
        geometryPreserved: true,
        stateRestored: true,
      }),
    );
  } finally {
    await browser?.close();
    // Remove only this run's exact UUID fixtures, never the shared directory.
    await fs.unlink(path.join(directory, filename)).catch((e) => {
      if (e.code !== "ENOENT") {
        throw e;
      }
    });
    for (const folder of [
      path.join(directory, ".chats", noteId),
      path.join(directory, ".apps", noteId),
    ]) {
      await fs.rm(folder, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

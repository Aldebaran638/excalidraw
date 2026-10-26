/* Real Qwen and real pointer actions. The harness never resends model turns. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:3009";
const directory = path.resolve(__dirname, "../../.local-data/preview/notes");
const outputTag = process.env.AGENT_OUTPUT_TAG || ".";
assert.ok(outputTag === "." || /^[a-zA-Z0-9_-]+$/.test(outputTag));
const output = path.resolve(
  ".local-data/acceptance/agent-productivity",
  outputTag,
);
const headers = {
  "Content-Type": "application/json",
  "X-Chat-Protocol": "9",
  "X-Chat-Capabilities": "html-blocks,preview-feedback,interaction-probes",
};
const cases = [
  {
    name: "counter",
    title: "学习计数器",
    min: 0,
    requirement:
      "精致计数器，output id=count初始为0，增加按钮id=inc每次加1，重置按钮id=reset，NoteApp持久保存计数",
  },
  {
    name: "network",
    title: "计算机网络全架构",
    min: 16,
    requirement:
      "计算机网络完整知识架构：分应用、传输、网络、数据链路、物理层，至少16个可点击知识节点，覆盖HTTP/DNS/TCP/UDP/IP/路由/ARP/ICMP/以太网/WiFi，画出协议间真实关系，点击显示用途、机制及常见面试点",
  },
  {
    name: "tcp",
    title: "TCP详细流程",
    min: 10,
    requirement:
      "TCP详细交互流程图：至少10个可点击步骤，分客户端和服务器泳道，画出三次握手、数据/ACK、丢包重传、滑动窗口、拥塞控制及四次挥手，使用连线和seq/ack标签，点击解释原因和状态",
  },
  {
    name: "kubernetes",
    title: "Kubernetes知识架构",
    min: 18,
    requirement:
      "Kubernetes详细知识架构图：至少18个可点击节点，按控制平面、工作节点、网络与存储、工作负载分组，覆盖API Server/etcd/Scheduler/Controller/kubelet/kube-proxy/Pod/Deployment/ReplicaSet/Service/Ingress/CNI/CSI/PV/PVC/ConfigMap/Secret，绘制真实关联并联动解释",
  },
];
if (process.env.AGENT_LARGE === "1") {
  const network = cases.find((test) => test.name === "network");
  network.min = 45;
  network.requirement =
    "计算机网络完整多级知识架构：至少45个可点击知识节点，包含五层分组及子分组，覆盖HTTP/HTTPS/HTTP2/HTTP3/DNS/CDN/邮件/FTP/DHCP/TCP/UDP/QUIC/握手/重传/流控/拥塞控制/IP/子网/NAT/ICMP/ARP/路由/OSPF/BGP/以太网/MAC/交换机/VLAN/STP/WiFi/物理介质等，绘制真实跨层和组内关联；每个节点能点击解释机制、典型场景和面试要点。用数据数组和统一计算布局，不能用45张无关联文字卡片冒充架构图；默认节点和文字可读，局部滚动，不整体缩小。";
}
async function json(url, init = {}) {
  const r = await fetch(base + url, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  const v = await r.json();
  assert.ok(r.ok, `${r.status} ${url}: ${JSON.stringify(v)}`);
  return v;
}
async function until(fn, timeout = 650000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const v = await fn();
    if (v) {
      return v;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("acceptance timed out");
}
async function clickVisible(page, locator) {
  await page.bringToFront();
  await locator.waitFor({ state: "visible", timeout: 120000 });
  await until(() => locator.isEnabled(), 30000);
  await locator.evaluate((node) =>
    node.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant",
    }),
  );
  const bounds = await locator.boundingBox();
  assert.ok(bounds?.width && bounds.height, "button has no pointer target");
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
}
async function send(page, noteId, sid, text) {
  const url = `/api/notes/${noteId}/chats/${sid}`;
  const last = (await json(url)).messages.at(-1)?.id;
  await page.locator('select[aria-label="聊天会话"]').waitFor();
  assert.equal(
    await page.locator('select[aria-label="聊天会话"]').inputValue(),
    sid,
  );
  await page.getByRole("textbox", { name: "聊天消息", exact: true }).fill(text);
  await clickVisible(
    page,
    page.getByRole("button", { name: "发送消息", exact: true }),
  );
  console.log("sent", text.slice(0, 45));
  let visibleBeforeEnd = false;
  const m = await until(async () => {
    const s = await json(url);
    const a = s.messages.at(-1);
    if (a?.id !== last && a?.status === "generating" && !visibleBeforeEnd) {
      const frames = page.locator(".note-chat-html-card iframe");
      if (await frames.count()) {
        visibleBeforeEnd =
          (await frames.last().contentFrame().locator("#app-title").count()) >
          0;
      }
    }
    return a?.role === "assistant" && a.id !== last && a.status !== "generating"
      ? a
      : null;
  });
  assert.equal(
    m.status,
    "complete",
    `${m.error}; tools=${JSON.stringify(
      m.activities?.map((t) => ({
        name: t.name,
        status: t.status,
        details: t.status === "failed" ? t.details : undefined,
      })),
    )}`,
  );
  return { ...m, visibleBeforeEnd };
}
async function artifact(noteId, sid, m) {
  const b = m.blocks?.findLast((b) => b.type === "html" && b.saved);
  assert.ok(b, "no saved application");
  assert.notEqual(b.preview?.status, "issues");
  return json(
    `/api/notes/${noteId}/chats/${sid}/html-artifacts/${b.ref.artifactId}?version=${b.ref.version}`,
  );
}
async function run(browser, test, cycle) {
  const noteId = randomUUID();
  const notePhrase =
    process.env.AGENT_NOTE_CONTEXT === "1" ? `qa-${randomUUID()}` : null;
  const filename = `__agent-productivity-${noteId}.excalidraw`;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("browser", error.message));
  page.setDefaultTimeout(45000);
  let session;
  const report = { cycle, name: test.name, ok: false };
  try {
    await json(`/api/notes/${filename}`, {
      method: "PUT",
      body: JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: notePhrase
          ? [
              {
                id: randomUUID(),
                type: "text",
                x: 30,
                y: 40,
                width: 600,
                height: 50,
                angle: 0,
                strokeColor: "#1b1b1f",
                backgroundColor: "transparent",
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
                updated: Date.now(),
                link: null,
                locked: false,
                text: `校验口令：${notePhrase}`,
                originalText: `校验口令：${notePhrase}`,
                fontSize: 20,
                fontFamily: 1,
                lineHeight: 1.25,
                textAlign: "left",
                verticalAlign: "top",
                containerId: null,
                autoResize: true,
              },
            ]
          : [],
        appState: {},
        files: {},
        repositoryMetadata: { version: 1, noteId },
      }),
    });
    session = await json(`/api/notes/${noteId}/chats`, { method: "POST" });
    await context.addInitScript((filename) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", filename);
      }
    }, filename);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    console.log("loaded", cycle, test.name);
    await clickVisible(
      page,
      page.getByRole("button", { name: "打开笔记聊天", exact: true }),
    );
    console.log("chat opened", cycle, test.name);
    if (test.name === "counter") {
      const m = await send(
        page,
        noteId,
        session.id,
        "解释TCP和UDP的区别，三句话，不需要生成应用。",
      );
      assert.ok(m.content.includes("TCP") && m.content.includes("UDP"));
      assert.ok(!m.blocks?.some((b) => b.type === "html"));
    }
    const m = await send(
      page,
      noteId,
      session.id,
      `生成一个能直接操作的HTML应用：${
        test.requirement
      }。主标题id=app-title，文字为“${test.title}”。${
        test.min
          ? "图区域id=diagram，每个节点/步骤用data-node属性标识；点击在id=explanation区域显示至少两句解释；真实关系用SVG线条/路径绘制，数据数组组织，保留稳定ID。"
          : ""
      }中文、清晰分组和图例、克制配色、响应式布局，320px聊天预览可用，可以放大。优先使用NoteApp.load本地库。${
        notePhrase
          ? "另请根据当前笔记读取其中的校验口令，并在应用里原样显示该口令；口令不要猜测。"
          : ""
      }`,
    );
    const original = await artifact(noteId, session.id, m);
    report.visibleBeforeEnd = m.visibleBeforeEnd;
    assert.ok(
      m.visibleBeforeEnd,
      "no actual app structure visible before turn finished",
    );
    report.sourceBytes = original.source.length;
    await fs.writeFile(
      path.join(output, `${cycle}-${test.name}-source.html`),
      original.source,
    );
    const card = page.locator(".note-chat-html-card").last();
    await card.locator('[data-app-status="complete"]').waitFor();
    const trial = card.frameLocator("iframe");
    if (notePhrase) {
      assert.ok(
        m.activities?.some(
          (activity) =>
            ["get_note_outline", "search_note", "read_note_elements"].includes(
              activity.name,
            ) && activity.status === "complete",
        ),
        "note-based creation did not use a real reading tool",
      );
      assert.ok(
        (await trial.locator("body").textContent()).includes(notePhrase),
        "app did not display the note-only phrase",
      );
      report.noteContextVerified = true;
    }
    assert.ok(
      (await trial.locator("#app-title").textContent()).includes(test.title),
    );
    if (test.min) {
      await until(
        async () => (await trial.locator("[data-node]").count()) >= test.min,
        45000,
      );
      report.nodes = await trial.locator("[data-node]").count();
      assert.ok(
        (await trial
          .locator("#diagram line,#diagram path,#diagram polyline")
          .count()) >=
          test.min - 1,
        "insufficient relationships",
      );
      let previous = "";
      for (let i = 0; i < 3; i++) {
        const before = previous;
        await trial.locator("[data-node]").nth(i).click();
        await until(async () => {
          const next = (
            await trial.locator("#explanation").textContent()
          ).trim();
          return next.length > 12 && (!i || next !== before);
        }, 5000);
        const text = (await trial.locator("#explanation").textContent()).trim();
        assert.ok(text.length > 12);
        if (i) {
          assert.notEqual(
            text,
            previous,
            "explanation did not follow selection",
          );
        }
        previous = text;
      }
    } else {
      await trial.locator("#inc").click();
      await until(
        async () =>
          (await trial.locator("#count").textContent()).trim() === "1",
        10000,
      );
    }
    assert.deepEqual(
      await card.locator(".note-chat-inline-error").allTextContents(),
      [],
    );
    await page.screenshot({
      path: path.join(output, `${cycle}-${test.name}-chat.png`),
    });
    const importButton = card.getByRole("button", {
      name: "导入笔记",
      exact: true,
    });
    await importButton.scrollIntoViewIfNeeded();
    const importResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/notes/${noteId}/apps`) &&
        response.request().method() === "POST",
      { timeout: 30000 },
    );
    const importBounds = await importButton.boundingBox();
    assert.ok(importBounds, "import button is not visible");
    await page.mouse.click(
      importBounds.x + importBounds.width / 2,
      importBounds.y + importBounds.height / 2,
    );
    const imported = await importResponse;
    assert.ok(
      imported.ok(),
      `import failed ${imported.status()}: ${await imported.text()}`,
    );
    await page.locator(".html-app-placement").waitFor();
    await page.mouse.move(130, 180);
    await page.mouse.down();
    await page.mouse.move(830, 730, { steps: 12 });
    await page.mouse.up();
    const formal = page.frameLocator(".canvas-html-app iframe");
    await formal.locator("#app-title").waitFor();
    let saved = await until(async () => {
      const n = await json(`/api/notes/${filename}`);
      return n.elements.some((e) => !e.isDeleted && e.customData?.htmlApp)
        ? n
        : null;
    }, 30000);
    let element = saved.elements.find(
      (e) => !e.isDeleted && e.customData?.htmlApp,
    );
    const id = element.id;
    const geometry = [element.x, element.y, element.width, element.height];
    report.edits = [];
    let expectedCount = 1;
    if (!test.min) {
      assert.equal(
        Number(await formal.locator("#count").textContent()),
        expectedCount,
        "import lost trial input",
      );
    }
    for (let edit = 1; edit <= 2; edit++) {
      const title = `${test.title} · 第${edit}次优化`;
      const request = test.min
        ? `标题改为“${title}”；${
            edit === 1
              ? "增加一个data-node=review的可点击“学习检查”节点，和现有节点连线，点击在explanation显示自测建议"
              : "给“学习检查”节点补充三条具体自测题，用不同强调色突出"
          }。保留全部原节点与交互。`
        : `标题改为“${title}”，增加按钮每次加${edit + 1}，保留当前计数和重置。`;
      const changed = await send(
        page,
        noteId,
        session.id,
        `修改当前引用的画布组件：${request}使用真实源码工具局部修改。`,
      );
      const candidate = await artifact(noteId, session.id, changed);
      await fs.writeFile(
        path.join(output, `${cycle}-${test.name}-edit${edit}.html`),
        candidate.source,
      );
      assert.ok(
        changed.activities.some(
          (t) => t.name === "read_app_source" && t.status === "complete",
        ),
      );
      assert.ok(
        changed.activities.some(
          (t) => t.name === "edit_app_source" && t.status === "complete",
        ),
      );
      await page
        .locator(".html-app-candidate")
        .last()
        .getByRole("button", { name: "确认应用修改", exact: true })
        .click();
      await until(
        async () =>
          (await formal.locator("#app-title").textContent())?.includes(title),
        45000,
      );
      if (test.min) {
        await formal.locator('[data-node="review"]').click();
        let explanation = await formal.locator("#explanation").textContent();
        if (!/检查|自测|复习|学习|review/i.test(explanation)) {
          await formal.locator('[data-node="review"]').click();
          explanation = await formal.locator("#explanation").textContent();
        }
        assert.ok(
          /检查|自测|复习|学习|review/i.test(explanation),
          `review selection did not explain: ${explanation}`,
        );
        assert.ok(
          (await formal.locator("[data-node]").count()) >= test.min + 1,
          "editing removed required knowledge nodes",
        );
      } else {
        const before = Number(await formal.locator("#count").textContent());
        assert.equal(
          before,
          expectedCount,
          "apply lost the latest formal state",
        );
        await formal.locator("#inc").click();
        await until(
          async () =>
            Number(await formal.locator("#count").textContent()) ===
            before + edit + 1,
          10000,
        );
        expectedCount = before + edit + 1;
      }
      saved = await until(async () => {
        const n = await json(`/api/notes/${filename}`);
        return n.elements.find((e) => e.id === id)?.customData?.htmlApp
          ?.sourceHash === candidate.sourceHash
          ? n
          : null;
      }, 30000);
      element = saved.elements.find((e) => e.id === id);
      assert.deepEqual(
        [element.x, element.y, element.width, element.height],
        geometry,
      );
      report.edits.push({
        version: element.customData.htmlApp.version,
        tools: changed.activities.map((t) => ({
          name: t.name,
          status: t.status,
        })),
        preview: changed.blocks.findLast((b) => b.type === "html")?.preview,
      });
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await until(
      async () =>
        (
          await formal.locator("#app-title").textContent()
        )?.includes("第2次优化"),
      45000,
    );
    await page.screenshot({
      path: path.join(output, `${cycle}-${test.name}-canvas.png`),
    });
    if (!test.min) {
      assert.equal(
        Number(await formal.locator("#count").textContent()),
        expectedCount,
        "refresh lost state",
      );
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 430, height: 900 });
    await page.screenshot({
      path: path.join(output, `${cycle}-${test.name}-narrow.png`),
    });
    report.ok = true;
    return report;
  } catch (error) {
    report.error = String(error);
    console.error("case failed", cycle, test.name, report.error);
    await page
      .screenshot({
        timeout: 10000,
        path: path.join(output, `${cycle}-${test.name}-failed.png`),
      })
      .catch(() => {});
    if (session) {
      await fs
        .cp(
          path.join(directory, ".chats", noteId),
          path.join(output, `${cycle}-${test.name}-failed-chats`),
          { recursive: true },
        )
        .catch(() => {});
      await fs
        .cp(
          path.join(directory, ".apps", noteId),
          path.join(output, `${cycle}-${test.name}-failed-apps`),
          { recursive: true },
        )
        .catch(() => {});
      await fs
        .writeFile(
          path.join(output, `${cycle}-${test.name}-failed-session.json`),
          JSON.stringify(
            await json(`/api/notes/${noteId}/chats/${session.id}`),
            null,
            2,
          ),
        )
        .catch(() => {});
    }
    return report;
  } finally {
    await context.close();
    if (session) {
      await until(async () => {
        const s = await json(`/api/notes/${noteId}/chats/${session.id}`);
        const m = s.messages.at(-1);
        if (m?.status === "generating") {
          await json(
            `/api/notes/${noteId}/chats/${session.id}/turns/${m.turnId}/stop`,
            { method: "POST" },
          );
          return false;
        }
        return true;
      }, 30000).catch(() => {});
    }
    await fs.unlink(path.join(directory, filename)).catch((e) => {
      if (e.code !== "ENOENT") {
        throw e;
      }
    });
    await fs.rm(path.join(directory, ".chats", noteId), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(directory, ".apps", noteId), {
      recursive: true,
      force: true,
    });
  }
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const results = [];
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    void browser.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    runs: for (
      let cycle = 1;
      cycle <= Number(process.env.AGENT_RUNS || 2);
      cycle++
    ) {
      for (const test of cases) {
        if (interrupted) {
          break runs;
        }
        if (process.env.AGENT_CASE && process.env.AGENT_CASE !== test.name) {
          continue;
        }
        const result = await run(browser, test, cycle);
        results.push(result);
        console.log(JSON.stringify(result));
        await fs.writeFile(
          path.join(output, "playwright-report.json"),
          JSON.stringify(results, null, 2),
        );
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await browser.close();
  }
  assert.ok(
    results.length && results.every((r) => r.ok),
    JSON.stringify(results),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

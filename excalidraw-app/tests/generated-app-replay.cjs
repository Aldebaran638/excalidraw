/* Real Qwen source replay in the production UI; no new model requests. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:3009";
const outputTag = process.env.AGENT_OUTPUT_TAG || ".";
assert.ok(outputTag === "." || /^[a-zA-Z0-9_-]+$/.test(outputTag));
const output = path.resolve(
  ".local-data/acceptance/agent-productivity",
  outputTag,
);
const replayStage = process.env.REPLAY_STAGE || "edit2";
assert.ok(["source", "edit1", "edit2"].includes(replayStage));
const directory = path.resolve(".local-data/preview/notes");
async function json(url, init = {}) {
  const response = await fetch(base + url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Chat-Protocol": "9",
      "X-Chat-Capabilities": "html-blocks,preview-feedback,interaction-probes",
      ...init.headers,
    },
  });
  const data = await response.json();
  assert.ok(response.ok, `${response.status} ${url}: ${JSON.stringify(data)}`);
  return data;
}
async function until(fn, timeout = 30000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("replay condition timed out");
}
async function nativeClick(page, locator, touch = false) {
  await page.bringToFront();
  await locator.evaluate((node) =>
    node.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant",
    }),
  );
  const hit = await locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const target = node.ownerDocument.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    );
    return { ok: node.contains(target), cover: target?.id || target?.tagName };
  });
  assert.ok(hit.ok, `node center is covered by ${hit.cover}`);
  const r = await locator.boundingBox();
  assert.ok(r?.width && r.height, "no visible pointer target");
  if (touch) {
    await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
  } else {
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  }
}
async function replay(browser, record) {
  const noteId = randomUUID();
  const artifactId = randomUUID();
  const filename = `__agent-replay-${noteId}.excalidraw`;
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const result = { cycle: record.cycle, name: record.name, ok: false };
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
    let sourceFile = path.join(
      output,
      `${record.cycle}-${record.name}-${
        process.env.REPLAY_IMPORT_ONLY === "1" ? "source" : replayStage
      }.html`,
    );
    if (process.env.REPLAY_REPAIR === "1") {
      const failed = JSON.parse(
        await fs.readFile(
          path.join(
            output,
            `${record.cycle}-${record.name}-failed-session.json`,
          ),
          "utf8",
        ),
      );
      const ref = failed.messages
        .at(-1)
        .blocks.findLast((block) => block.type === "html").ref;
      assert.match(ref.artifactId, /^[a-f0-9-]{36}$/);
      sourceFile = path.join(
        output,
        `${record.cycle}-${record.name}-failed-apps`,
        ref.artifactId,
        "versions/1/source.html",
      );
    }
    const source = await fs.readFile(sourceFile, "utf8");
    const ref = { kind: "html", artifactId, version: 1 };
    const folder = path.join(
      directory,
      ".apps",
      noteId,
      artifactId,
      "versions",
      "1",
    );
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "source.html"), source);
    await fs.writeFile(
      path.join(folder, "metadata.json"),
      JSON.stringify({
        ...ref,
        noteId,
        sessionId: session.id,
        formatVersion: 1,
        runtimeVersion: 3,
        title: `回放 · ${record.name}`,
        complete: true,
        revision: 0,
        state: { forms: {}, custom: {} },
        sourceHash: createHash("sha256").update(source).digest("hex"),
        createdAt: Date.now(),
      }),
    );
    session.messages = [
      {
        id: randomUUID(),
        turnId: randomUUID(),
        role: "assistant",
        status:
          process.env.REPLAY_VERIFY_ONLY === "1" ? "generating" : "complete",
        content: "真实 Qwen 最终源码的交互回放。",
        createdAt: Date.now(),
        blocks: [
          {
            id: randomUUID(),
            type: "html",
            ref,
            runtimeVersion: 3,
            complete: true,
            saved: true,
          },
        ],
      },
    ];
    const sessionFile = path.join(
      directory,
      ".chats",
      noteId,
      `${session.id}.json`,
    );
    await fs.writeFile(`${sessionFile}.replay.tmp`, JSON.stringify(session));
    await fs.rename(`${sessionFile}.replay.tmp`, sessionFile);
    const verificationReports = [];
    if (process.env.REPLAY_VERIFY_ONLY === "1") {
      await page.route("**/turns/*/preview", async (route) => {
        verificationReports.push(route.request().postDataJSON().report);
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ accepted: true }),
        });
      });
    }
    await context.addInitScript((filename) => {
      if (window === window.top) {
        localStorage.setItem("aldebaran.repository-note-name", filename);
        window.agentReplay = { reports: [], errors: [] };
        window.addEventListener("message", (event) => {
          if (event.data?.type === "preview") {
            window.agentReplay.reports.push(event.data.data);
          }
          if (
            event.data?.type === "error" ||
            event.data?.type === "patch_rejected"
          ) {
            window.agentReplay.errors.push(event.data.data);
          }
        });
      }
    }, filename);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "打开笔记聊天", exact: true })
      .click({ timeout: 120000 });
    const card = page.locator(".note-chat-html-card").last();
    await card.locator('[data-app-status="complete"]').waitFor();
    if (process.env.REPLAY_VERIFY_ONLY === "1") {
      await until(() => verificationReports.length > 0, 20000);
      const report = verificationReports.at(-1);
      assert.ok(
        report.errors.some((issue) =>
          /data-node=(?:apiserver|controller|review)/.test(issue),
        ) && report.errors.some((issue) => issue.includes("reading 'label'")),
        `missing review data was not detected before apply: ${JSON.stringify(
          report.errors,
        )}`,
      );
      await page
        .locator(".app-preview-verifier")
        .waitFor({ state: "detached" });
      const artifact = await json(
        `/api/notes/${noteId}/chats/${session.id}/html-artifacts/${artifactId}?version=1`,
      );
      assert.deepEqual(artifact.state, { forms: {}, custom: {} });
      assert.equal(artifact.revision, 0, "verification wrote trial state");
      assert.match(
        await card.frameLocator("iframe").locator("#explanation").textContent(),
        /点击/,
      );
      result.verificationErrors = report.errors;
      result.trialStateUnchanged = true;
      result.ok = true;
      return result;
    }
    await until(() =>
      page.evaluate(() => window.agentReplay.reports.length > 0),
    );
    let layoutErrors = await page.evaluate(
      () => window.agentReplay.reports.at(-1).errors,
    );
    if (process.env.REPLAY_REPAIR === "1") {
      assert.ok(
        layoutErrors.length,
        "fixed regression source unexpectedly has no layout errors",
      );
      result.originalIssues = layoutErrors;
      const previous = session.messages.at(-1).id;
      await nativeClick(
        page,
        card.getByRole("button", { name: "继续修改", exact: true }),
      );
      await page
        .getByRole("textbox", { name: "聊天消息", exact: true })
        .fill(
          "请读取源码并局部修复当前应用中知识节点重叠、遮挡及视口裁切的问题。保留全部知识节点、说明、连线、稳定ID及选择交互，使用自动分组布局避免挪开一对又撞上其他节点。不要重写整份应用。完成后直接给出已保存候选。",
        );
      await nativeClick(
        page,
        page.getByRole("button", { name: "发送消息", exact: true }),
      );
      let answer;
      await until(async () => {
        const current = await json(`/api/notes/${noteId}/chats/${session.id}`);
        const message = current.messages.at(-1);
        if (
          message.role === "assistant" &&
          message.id !== previous &&
          message.status !== "generating"
        ) {
          answer = message;
          return true;
        }
      }, 650000);
      await fs.writeFile(
        path.join(output, "layout-repair-result.json"),
        JSON.stringify(answer, null, 2),
      );
      assert.equal(answer.status, "complete", answer.error);
      const candidate = answer.blocks.findLast(
        (block) => block.type === "html" && block.saved,
      );
      const artifact = await json(
        `/api/notes/${noteId}/chats/${session.id}/html-artifacts/${candidate.ref.artifactId}?version=${candidate.ref.version}`,
      );
      await fs.writeFile(
        path.join(output, "layout-repaired.html"),
        artifact.source,
      );
      assert.equal(
        candidate?.preview?.status,
        "checked",
        "saved candidate was not preview checked",
      );
      assert.ok(
        answer.activities.some(
          (tool) =>
            tool.name === "read_app_source" && tool.status === "complete",
        ),
      );
      assert.ok(
        answer.activities.some(
          (tool) =>
            tool.name === "edit_app_source" && tool.status === "complete",
        ),
      );
      result.sourceRepair = {
        ref: candidate.ref,
        tools: answer.activities.map((tool) => ({
          name: tool.name,
          status: tool.status,
        })),
      };
      await until(() =>
        page.evaluate(
          () => window.agentReplay.reports.at(-1)?.errors.length === 0,
        ),
      );
      layoutErrors = await page.evaluate(
        () => window.agentReplay.reports.at(-1).errors,
      );
    }
    if (process.env.REPLAY_EXPECT_LAYOUT_FAILURE === "1") {
      assert.ok(layoutErrors.length, "the known bad layout was not detected");
      result.rejectedIssues = layoutErrors;
      result.ok = true;
      return result;
    }
    assert.deepEqual(layoutErrors, [], "initial layout/runtime diagnostics");
    if (process.env.REPLAY_IMPORT === "1") {
      const imported = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/notes/${noteId}/apps`) &&
          response.request().method() === "POST",
      );
      await nativeClick(
        page,
        card.getByRole("button", { name: "导入笔记", exact: true }),
      );
      const response = await imported;
      assert.ok(
        response.ok(),
        `import storage ${response.status()}: ${await response.text()}`,
      );
      await page.locator(".html-app-placement").waitFor();
      await page.keyboard.press("Escape");
      await page.locator(".html-app-placement").waitFor({ state: "hidden" });
      result.importPlacement = true;
      if (process.env.REPLAY_IMPORT_ONLY === "1") {
        result.ok = true;
        return result;
      }
    }
    const frame = card.frameLocator("iframe");
    if (record.name === "counter") {
      const before = Number(await frame.locator("#count").textContent());
      await nativeClick(page, frame.locator("#inc"));
      await until(
        async () =>
          Number(await frame.locator("#count").textContent()) === before + 3,
      );
      await nativeClick(page, frame.locator("#reset"));
      await until(
        async () => Number(await frame.locator("#count").textContent()) === 0,
      );
    } else {
      const count = await frame.locator("[data-node]").count();
      const relations = await frame
        .locator("#diagram line,#diagram path,#diagram polyline,[data-edge]")
        .count();
      assert.ok(
        relations >= Math.floor(count / 2),
        `knowledge diagram has ${count} nodes but only ${relations} rendered relation elements`,
      );
      result.relations = relations;
      let previous = "";
      for (let i = 0; i < count; i++) {
        const node = frame.locator("[data-node]").nth(i);
        await nativeClick(page, node);
        const text = (await frame.locator("#explanation").textContent()).trim();
        if (/^(?:👆\s*)?点击/.test(text)) {
          await nativeClick(page, node);
        }
        const previousText = previous;
        await until(async () => {
          const value = (
            await frame.locator("#explanation").textContent()
          ).trim();
          return value.length > 15 && value !== previousText;
        });
        previous = (await frame.locator("#explanation").textContent()).trim();
        if ((await node.getAttribute("data-node")) === "review") {
          assert.match(previous, /自测|检查|复习/);
        }
      }
      result.nodesClicked = count;
    }
    // OS media alone does not switch Excalidraw's explicitly selected theme.
    await page.mouse.click(400, 90);
    await page.keyboard.press("Shift+Alt+d");
    await page.locator(".excalidraw.theme--dark").waitFor();
    await page.setViewportSize({ width: 430, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await nativeClick(
      page,
      frame.locator(record.name === "counter" ? "#inc" : "[data-node]").first(),
      true,
    );
    assert.deepEqual(
      await page.evaluate(() => window.agentReplay.errors),
      [],
      "interaction runtime errors",
    );
    await page.screenshot({
      path: path.join(
        output,
        `${record.cycle}-${record.name}-replay-touch.png`,
      ),
    });
    await until(async () =>
      (await card.locator("header").textContent()).includes("源码已保存"),
    );
    result.ok = true;
  } catch (error) {
    result.error = String(error);
    console.error(`replay ${record.name}: ${result.error}`);
    await page
      .screenshot({
        timeout: 10000,
        path: path.join(
          output,
          `${record.cycle}-${record.name}-replay-failed.png`,
        ),
      })
      .catch(() => {});
  } finally {
    await context.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fs.unlink(path.join(directory, filename)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
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
  return result;
}
(async () => {
  const records = JSON.parse(
    await fs.readFile(path.join(output, "playwright-report.json"), "utf8"),
  );
  if (process.env.REPLAY_PRESSURE === "1") {
    assert.equal(records.length, 1, "pressure replay needs one complete case");
    assert.equal(records[0].name, "network");
    assert.ok(records[0].nodes >= 45, "not a 45-node pressure result");
  } else if (process.env.REPLAY_DIAGNOSTIC !== "1") {
    const cycles = Number(process.env.REPLAY_CYCLES || 2);
    assert.ok(cycles === 1 || cycles === 2);
    assert.equal(
      records.length,
      4 * cycles,
      "finish every requested real Qwen case before replay",
    );
    assert.equal(
      new Set(records.map((record) => `${record.cycle}/${record.name}`)).size,
      records.length,
    );
    for (let cycle = 1; cycle <= cycles; cycle++) {
      for (const name of ["counter", "network", "tcp", "kubernetes"]) {
        assert.ok(
          records.some(
            (record) => record.cycle === cycle && record.name === name,
          ),
        );
      }
    }
  }
  if (process.env.REPLAY_DIAGNOSTIC !== "1") {
    assert.ok(
      records.every((record) => record.ok),
      "do not replay stale files from a failed cycle",
    );
  } else {
    assert.ok(
      process.env.REPLAY_CASE && process.env.REPLAY_CYCLE,
      "diagnostics must identify one recorded source",
    );
  }
  const browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const results = [];
  try {
    for (const record of records) {
      if (process.env.REPLAY_CASE && record.name !== process.env.REPLAY_CASE) {
        continue;
      }
      if (
        process.env.REPLAY_CYCLE &&
        record.cycle !== Number(process.env.REPLAY_CYCLE)
      ) {
        continue;
      }
      const result = await replay(browser, record);
      results.push(result);
      console.log(JSON.stringify(result));
      await fs.writeFile(
        path.join(
          output,
          process.env.REPLAY_VERIFY_ONLY === "1"
            ? "replay-verification.json"
            : process.env.REPLAY_DIAGNOSTIC === "1"
            ? "replay-diagnostic.json"
            : "replay-report.json",
        ),
        JSON.stringify(results, null, 2),
      );
    }
  } finally {
    await browser.close();
  }
  assert.ok(
    results.length && results.every((result) => result.ok),
    JSON.stringify(results),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

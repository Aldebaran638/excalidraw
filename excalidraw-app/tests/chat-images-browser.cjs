/* Fixed 3009, own UUID records only. Mocked model/SSE; real upload, scene renderer and persistence. */
/* eslint-disable no-console */
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:3009";
const root = path.resolve(".local-data/preview/notes");
const output = path.resolve(".local-data/acceptance/chat-canvas-images");
const json = async (url, init) => {
  const r = await fetch(base + url, init);
  assert.ok(
    r.ok,
    `${url}: ${r.status} ${await (r.ok ? Promise.resolve("") : r.text())}`,
  );
  return r.json();
};
(async () => {
  const noteId = randomUUID();
  const filename = `__chat-images-${noteId}.excalidraw`;
  let browser;
  try {
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, "browser-fixture.json"),
      JSON.stringify({ noteId, filename }),
    );
    const element = (type, fields) => ({
      id: randomUUID(),
      type,
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      angle: 0,
      strokeColor: "#ff0000",
      backgroundColor: "#ff0000",
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
      updated: 1,
      link: null,
      locked: false,
      ...fields,
    });
    const shape = element("rectangle", { x: -100, y: -50 });
    const doc = {
      type: "excalidraw",
      version: 2,
      elements: [shape],
      files: {},
      appState: {
        viewBackgroundColor: "#ffffff",
        scrollX: 400,
        scrollY: 350,
        zoom: { value: 1 },
      },
      repositoryMetadata: { version: 1, noteId },
    };
    await json(`/api/notes/${filename}`, {
      method: "PUT",
      body: JSON.stringify(doc),
    });
    const source =
      '<!doctype html><html><head><style>body{margin:0;background:transparent}main{background:#fff;border:1px solid #ddd;border-radius:12px;padding:12px}canvas{display:block}</style></head><body><main><h2>截图测试 · 中文</h2><input id="task" value="初始任务"><canvas id="plot" width="80" height="60"></canvas><script>document.getElementById("plot").getContext("2d").fillStyle="#0000ff";document.getElementById("plot").getContext("2d").fillRect(0,0,80,60);</script></main></body></html>';
    const app = await json(`/api/notes/${noteId}/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        state: { forms: {}, custom: {} },
        title: "截图测试",
      }),
    });
    const embed = element("embeddable", {
      x: 180,
      y: -50,
      width: 300,
      height: 220,
      index: "a1",
      strokeColor: "transparent",
      backgroundColor: "transparent",
      link: "https://apps.excalidraw.local/test",
      customData: {
        htmlApp: {
          formatVersion: 1,
          appId: app.artifactId,
          version: app.version,
          sourceHash: app.sourceHash,
          sourceSnapshot: source,
          runtimeVersion: 3,
          title: "截图测试",
          state: { forms: {}, custom: {} },
        },
        embeddable: {
          frame: "none",
          snapshotRequired: true,
          keepAlive: true,
          contentLocked: true,
          interaction: "controls",
          snapshot:
            '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="220"/>',
        },
      },
    });
    const zlib = require("node:zlib");
    const chunk = (type, bytes) => {
      const b = Buffer.concat([Buffer.from(type), bytes]);
      let crc = 0xffffffff;
      for (const v of b) {
        crc ^= v;
        for (let bit = 0; bit < 8; bit++) {
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
      }
      const n = Buffer.alloc(4);
      const c = Buffer.alloc(4);
      n.writeUInt32BE(bytes.length);
      c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
      return Buffer.concat([n, b, c]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0, 255, 255, 255]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const fileId = randomUUID();
    doc.files[fileId] = {
      id: fileId,
      mimeType: "image/png",
      created: 1,
      dataURL: `data:image/png;base64,${png.toString("base64")}`,
    };
    const picture = element("image", {
      x: 120,
      y: -50,
      width: 40,
      height: 40,
      index: "a2",
      fileId,
      status: "saved",
      scale: [1, 1],
      crop: null,
    });
    const rotated = element("rectangle", {
      x: 70,
      y: 70,
      width: 100,
      height: 20,
      index: "a3",
      angle: Math.PI / 4,
      backgroundColor: "#ff8800",
      strokeColor: "#ff8800",
    });
    const front = element("ellipse", {
      x: 110,
      y: 70,
      width: 20,
      height: 20,
      index: "a4",
      backgroundColor: "#ff00ff",
      strokeColor: "#ff00ff",
    });
    const groupFrame = element("frame", {
      x: -110,
      y: 120,
      width: 160,
      height: 50,
      index: "a5",
      name: "区域分组",
    });
    doc.elements.push(embed, picture, rotated, front, groupFrame);
    await json(`/api/notes/${filename}`, {
      method: "PUT",
      body: JSON.stringify(doc),
    });
    const session = await json(`/api/notes/${noteId}/chats`, {
      method: "POST",
    });
    const sessionFile = path.join(root, ".chats", noteId, `${session.id}.json`);
    browser = await chromium.launch({
      executablePath:
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
    const context = await browser.newContext({
      viewport: { width: 1400, height: 1000 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(
      ({ filename }) => {
        if (window === window.top) {
          localStorage.setItem("aldebaran.repository-note-name", filename);
        }
      },
      { filename },
    );
    let frozen;
    let captureData;
    let sent;
    let toolImage;
    await page.route("**/turns", async (route) => {
      sent = route.request().postDataJSON();
      assert.ok(sent.canvasSnapshotId);
      assert.equal(sent.attachments.length, 1);
      frozen = await json(
        `/api/notes/${noteId}/chats/${session.id}/canvas-snapshots/${sent.canvasSnapshotId}`,
      );
      assert.equal(
        frozen.elements.length,
        doc.elements.length,
        "chat uploads/paste/drop must not insert canvas elements",
      );
      assert.equal(
        frozen.elements.find((e) => e.id === shape.id).backgroundColor,
        "#ff0000",
      );
      assert.equal(
        frozen.elements.find((e) => e.id === embed.id).type,
        "image",
        "HTML must be frozen as actual rendered pixels",
      );
      assert.ok(!frozen.errors[embed.id]);
      // Change the stored live note AFTER send. The subsequent screenshot must stay red.
      const live = await json(`/api/notes/${filename}`);
      const changed = live.scene || live.data || live;
      const liveDoc = changed.elements
        ? changed
        : JSON.parse(await fs.readFile(path.join(root, filename), "utf8"));
      liveDoc.elements.find((e) => e.id === shape.id).backgroundColor =
        "#00ff00";
      await json(`/api/notes/${filename}`, {
        method: "PUT",
        body: JSON.stringify(liveDoc),
      });
      const assistant = {
        id: randomUUID(),
        turnId: sent.turnId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        status: "generating",
        activities: [],
        blocks: [],
      };
      const question = {
        id: randomUUID(),
        turnId: sent.turnId,
        role: "user",
        content: sent.content,
        attachments: sent.attachments,
        canvasSnapshotId: sent.canvasSnapshotId,
        createdAt: Date.now(),
        status: "complete",
      };
      session.messages = [question, assistant];
      session.revision += 1;
      await fs.writeFile(sessionFile, JSON.stringify(session));
      const common = { noteId, sessionId: session.id, turnId: sent.turnId };
      const region = { x1: -120, y1: -70, x2: 500, y2: 200 };
      const activity = {
        id: randomUUID(),
        name: "capture_note_region",
        status: "complete",
        elementIds: [],
        snapshotAt: frozen.capturedAt,
        summary: "画布截图已保存",
        imageDelivery: "unsupported",
        images: [],
      };
      const block = { type: "tool", id: randomUUID(), activityId: activity.id };
      await page.route(
        `**/turns/${sent.turnId}/captures/*`,
        async (feedback) => {
          const body = feedback.request().postDataJSON();
          assert.equal(body.error, undefined, body.error);
          captureData = body.data;
          const image = await json(
            `/api/notes/${noteId}/chats/${session.id}/images`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ data: body.data, name: "画布区域截图" }),
            },
          );
          toolImage = {
            ...image,
            source: "canvas",
            region,
            capturedAt: frozen.capturedAt,
          };
          await fs.writeFile(
            path.join(
              root,
              ".chats",
              noteId,
              "images",
              session.id,
              image.id,
              "metadata.json",
            ),
            JSON.stringify(toolImage),
          );
          // Current page can now accept the mocked tool_end/done below.
          await feedback.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ saved: true, image: toolImage }),
          });
        },
      );
      // Same deterministic ID lets tool_end reference the actual persisted image.
      // Delay is not simulated model streaming; wait for real capture before creating final SSE projection.
      // route.fulfill buffers a finite response, so generate metadata through a stable fixture reference after capture is received via a second event response.
      const imageId = randomUUID();
      activity.images = [
        {
          id: imageId,
          name: "画布区域截图",
          source: "canvas",
          mimeType: "image/png",
          width: 620,
          height: 270,
          bytes: 1,
          sha256: "pending",
          region,
          capturedAt: frozen.capturedAt,
        },
      ];
      const finalized = {
        ...assistant,
        status: "complete",
        activities: [activity],
        blocks: [block],
      };
      const next = {
        ...session,
        revision: session.revision + 1,
        messages: [question, finalized],
      };
      const events = [
        { ...common, type: "start", session: structuredClone(session) },
        {
          ...common,
          type: "capture_request",
          capture: {
            requestId: randomUUID(),
            snapshotId: sent.canvasSnapshotId,
            region,
          },
        },
        { ...common, type: "tool_end", activity },
        { ...common, type: "block", block, sequence: 1 },
        {
          ...common,
          type: "done",
          saved: true,
          session: next,
          message: finalized,
        },
      ];
      // Image GET occurs only after tool expansion; use the real captured image transparently in the fixture.
      await page.route(`**/images/${imageId}*`, async (imageRoute) => {
        assert.ok(toolImage);
        const response = await fetch(
          `${base}/api/notes/${noteId}/chats/${session.id}/images/${toolImage.id}`,
        );
        await imageRoute.fulfill({
          status: response.status,
          contentType: "image/png",
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      Object.assign(session, next);
      await fs.writeFile(sessionFile, JSON.stringify(next));
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
      });
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "打开笔记聊天", exact: true })
      .click({ timeout: 120000 });
    const frame = page.frameLocator(".canvas-html-app iframe");
    await frame.locator("#task").waitFor({ timeout: 30000 });
    await frame.locator("#task").fill("发送时的未提交任务");
    const imageBytes = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 64;
      const x = c.getContext("2d");
      x.fillStyle = "#22aa44";
      x.fillRect(0, 0, 64, 64);
      return c.toDataURL().split(",")[1];
    });
    const input = page.locator('input[aria-label="选择聊天图片"]');
    await input.setInputFiles({
      name: "上传图片.png",
      mimeType: "image/png",
      buffer: Buffer.from(imageBytes, "base64"),
    });
    await page.locator(".note-chat-draft-images img").waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".note-chat-draft-images img").waitFor();
    // The uploaded draft survives reload. Test clipboard and drag/drop independently, then remove those extra images.
    for (const kind of ["paste", "drop"]) {
      await page
        .locator(
          kind === "paste" ? ".note-chat-composer textarea" : ".note-chat",
        )
        .evaluate(
          (node, { kind, data }) => {
            const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
            const file = new File([bytes], `${kind}.png`, {
              type: "image/png",
            });
            const transfer = new DataTransfer();
            transfer.items.add(file);
            const event =
              kind === "paste"
                ? new ClipboardEvent("paste", {
                    clipboardData: transfer,
                    bubbles: true,
                    cancelable: true,
                  })
                : new DragEvent("drop", {
                    dataTransfer: transfer,
                    bubbles: true,
                    cancelable: true,
                  });
            node.dispatchEvent(event);
          },
          { kind, data: imageBytes },
        );
      await page
        .getByRole("button", { name: `移除图片：${kind}.png`, exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: `移除图片：${kind}.png`, exact: true })
        .click();
    }
    await page
      .locator(".note-chat-composer textarea")
      .fill("截图并阅读这个区域");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page
      .getByText("画布截图已保存", { exact: true })
      .waitFor({ timeout: 30000 });
    assert.ok(captureData);
    const pixels = await page.evaluate(async (data) => {
      const image = document.createElement("img");
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const c = document.createElement("canvas");
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      const labelPixels = ctx.getImageData(12, 158, 138, 30).data;
      let frameInk = 0;
      for (let i = 0; i < labelPixels.length; i += 4) {
        if (
          labelPixels[i] < 235 &&
          labelPixels[i + 1] < 235 &&
          labelPixels[i + 2] < 235
        ) {
          frameInk++;
        }
      }
      const all = ctx.getImageData(0, 0, c.width, c.height).data;
      let blue = 0;
      for (let i = 0; i < all.length; i += 4) {
        if (all[i] < 10 && all[i + 1] < 10 && all[i + 2] > 240) {
          blue++;
        }
      }
      return {
        frameInk,
        width: c.width,
        height: c.height,
        red: at(70, 50),
        imagePixel: at(260, 40),
        rotatedPixel: at(254, 164),
        frontPixel: at(240, 150),
        blank: at(5, 5),
        blue,
      };
    }, captureData);
    assert.ok(
      pixels.frameInk > 10,
      `native frame labels missing: ${JSON.stringify(pixels)}`,
    );
    assert.equal(pixels.width, 620);
    assert.equal(pixels.height, 270);
    assert.ok(
      pixels.red[0] > 240 && pixels.red[1] < 20,
      JSON.stringify(pixels),
    );
    assert.ok(pixels.blank[0] > 240 && pixels.blank[1] > 240);
    assert.ok(
      pixels.imagePixel[0] < 20 &&
        pixels.imagePixel[1] > 240 &&
        pixels.imagePixel[2] > 240,
      "ordinary image binary pixels must be captured",
    );
    assert.ok(
      pixels.rotatedPixel[0] > 240 &&
        pixels.rotatedPixel[1] > 100 &&
        pixels.rotatedPixel[1] < 170 &&
        pixels.rotatedPixel[2] < 20,
      `rotated shape ${JSON.stringify(pixels)}`,
    );
    assert.ok(
      pixels.frontPixel[0] > 240 &&
        pixels.frontPixel[1] < 20 &&
        pixels.frontPixel[2] > 240,
      `scene z-order ${JSON.stringify(pixels)}`,
    );
    assert.ok(
      pixels.blue > 1000,
      `HTML Canvas pixels missing: ${JSON.stringify(pixels)}`,
    );
    const details = page
      .locator(".note-chat-reading")
      .filter({ has: page.getByText("画布截图已保存", { exact: true }) });
    assert.equal(await details.getAttribute("open"), null);
    assert.equal(await details.locator("img").isVisible(), false);
    await details.locator("summary").click();
    await details.locator("img").waitFor({ state: "visible" });
    await details
      .getByRole("button", { name: "放大图片：画布区域截图", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "画布区域截图", exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(output, "image-viewer.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "关闭图片", exact: true }).click();
    await page
      .getByRole("dialog", { name: "画布区域截图", exact: true })
      .waitFor({ state: "hidden" });
    await page.screenshot({ path: path.join(output, "light.png") });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("画布截图已保存", { exact: true }).waitFor();
    assert.equal(
      await page
        .locator(".note-chat-reading")
        .filter({ has: page.getByText("画布截图已保存", { exact: true }) })
        .getAttribute("open"),
      null,
    );
    await page.setViewportSize({ width: 430, height: 900 });
    await page.locator(".excalidraw").focus();
    await page.keyboard.press("Alt+Shift+D");
    await page.locator(".excalidraw.theme--dark").waitFor();
    await page.screenshot({ path: path.join(output, "narrow-dark.png") });
    assert.equal(errors.length, 0, errors.join("\n"));
    await fs.writeFile(
      path.join(output, "canvas-region.png"),
      Buffer.from(captureData, "base64"),
    );
    console.log(
      "PASS real uploads (file/paste/drop), image draft reload, frozen scene/HTML Canvas pixels, exact clipping, folded results, zoom dialog, reload, dark/narrow. Model SSE mocked; real Qwen calls 0.",
    );
  } finally {
    await browser?.close();
    await fs.rm(path.join(root, filename), { force: true });
    await fs.rm(path.join(root, ".chats", noteId), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(root, ".apps", noteId), {
      recursive: true,
      force: true,
    });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

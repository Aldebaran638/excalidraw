/* Native pixels, including opposite OS/app themes. Only uniquely owned 3009 fixtures. */
/* eslint-disable no-console */
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:3009";
const directory = path.resolve(".local-data/preview/notes");
const output = path.resolve(
  process.env.TRANSPARENCY_OUTPUT || ".local-data/acceptance/html-transparency",
);
const cardSelector = process.env.HTML_APP_CARD_SELECTOR || "#pom-card";
const fallback =
  '<main style="max-width:360px;margin:auto"><section id="pom-card" style="padding:24px;background:var(--surface);border:1px solid var(--border);border-radius:20px"><h1>番茄钟</h1><input id="task" value="保留输入"><button id="start">开始</button><output id="counter">0</output></section></main><script>window.bootId=Math.random();NoteApp.on("start","pom-card","click","#start",()=>{NoteApp.set("count",NoteApp.get("count",0)+1);document.getElementById("counter").textContent=NoteApp.get("count")})</script>';
const json = async (url, init) => {
  const r = await fetch(base + url, init);
  assert.ok(r.ok, `${url}: ${r.status}`);
  return r.json();
};
const readPixels = async (page, data, points, mime = "image/png") =>
  page.evaluate(
    async ({ data, points, mime }) => {
      const image = new Image();
      image.src = `data:${mime};base64,${data}`;
      await image.decode();
      const c = document.createElement("canvas");
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(image, 0, 0);
      return points.map(([x, y]) => [
        ...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data,
      ]);
    },
    { data: Buffer.from(data).toString("base64"), points, mime },
  );
const delta = (a, b) =>
  Math.max(...a.slice(0, 3).map((x, i) => Math.abs(x - b[i])));
(async () => {
  const noteId = randomUUID();
  const filename = `__transparent-${noteId}.excalidraw`;
  let browser;
  const results = [];
  await fs.mkdir(output, { recursive: true });
  try {
    for (let n = 0; n < 60; n++) {
      try {
        await json("/api/health");
        break;
      } catch (e) {
        if (n === 59) {
          throw e;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const source = process.env.HTML_APP_SOURCE_FILE
      ? await fs.readFile(process.env.HTML_APP_SOURCE_FILE, "utf8")
      : fallback;
    const note = {
      type: "excalidraw",
      version: 2,
      elements: [],
      files: {},
      appState: { scrollX: 0, scrollY: 0, viewBackgroundColor: "#ffffff" },
      repositoryMetadata: { version: 1, noteId },
    };
    await json(`/api/notes/${filename}`, {
      method: "PUT",
      body: JSON.stringify(note),
    });
    const app = await json(`/api/notes/${noteId}/apps`, {
      method: "POST",
      body: JSON.stringify({
        source,
        state: { forms: {}, custom: {} },
        title: "HTML 应用",
      }),
    });
    const common = {
      type: "rectangle",
      angle: 0,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: null,
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
    };
    const element = {
      ...common,
      type: "embeddable",
      id: randomUUID(),
      x: 240,
      y: 180,
      width: 560,
      height: 620,
      link: "https://apps.excalidraw.local/transparency",
      customData: {
        embeddable: {
          frame: "none",
          snapshotRequired: true,
          contentLocked: true,
          keepAlive: true,
          interaction: "controls",
          snapshot:
            '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="620"/>',
        },
        htmlApp: {
          formatVersion: 1,
          appId: app.artifactId,
          version: 1,
          sourceHash: app.sourceHash,
          sourceSnapshot: source,
          title: "HTML 应用",
          runtimeVersion: 3,
          state: { forms: {}, custom: {} },
        },
      },
    };
    const backdrop = {
      ...common,
      id: randomUUID(),
      x: 140,
      y: 160,
      width: 800,
      height: 700,
      backgroundColor: "#a5d8ff",
    };
    const rectangle = {
      ...common,
      id: randomUUID(),
      x: 50,
      y: 300,
      width: 270,
      height: 130,
      strokeColor: "#1e1e1e",
    };
    note.elements = [backdrop, rectangle, element];
    await json(`/api/notes/${filename}`, {
      method: "PUT",
      body: JSON.stringify(note),
    });
    browser = await chromium.launch({
      executablePath:
        "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      headless: true,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
    for (const os of ["dark", "light"]) {
      for (const theme of ["light", "dark"]) {
        const c = await browser.newContext({
          viewport: { width: 1280, height: 1000 },
          colorScheme: os,
          acceptDownloads: true,
        });
        const p = await c.newPage();
        await p.addInitScript(
          ({ filename }) => {
            if (window === window.top) {
              localStorage.setItem("aldebaran.repository-note-name", filename);
              localStorage.setItem("excalidraw-theme", "light");
              delete window.showSaveFilePicker;
              delete window.showOpenFilePicker;
            }
          },
          { filename, theme },
        );
        await p.goto(base, { waitUntil: "domcontentloaded" });
        const root = p.locator(".canvas-html-app");
        await root.waitFor({ timeout: 120000 });
        const frame = p.frameLocator(".canvas-html-app iframe");
        await frame.locator(cardSelector).waitFor();
        await root.locator('[data-app-status="complete"]').waitFor();
        await p.waitForTimeout(300);
        // Repository appState can supersede the local preference on load.
        if (
          (await p.locator(".excalidraw.theme--dark").count()) !==
          Number(theme === "dark")
        ) {
          await p.locator(".excalidraw").focus();
          await p.keyboard.press("Alt+Shift+D");
        }
        await p
          .locator(
            theme === "dark"
              ? ".excalidraw.theme--dark"
              : ".excalidraw:not(.theme--dark)",
          )
          .waitFor();
        await root.locator('[data-app-status="complete"]').waitFor();
        const box = await root.boundingBox();
        const card = await frame.locator(cardSelector).boundingBox();
        assert.ok(card.x > box.x + 40, "fixture must leave an outer gutter");
        const image = await p.screenshot({
          path: path.join(output, `${os}-${theme}.png`),
        });
        const pixels = await readPixels(p, image, [
          [180, 500],
          [260, 500],
          [card.x + card.width / 2, card.y + card.height - 10],
          [320, 350],
        ]);
        const info = {
          os,
          theme,
          outside: pixels[0],
          gutter: pixels[1],
          card: pixels[2],
          rectangle: pixels[3],
        };
        results.push(info);
        await fs.writeFile(
          path.join(output, "result.json"),
          JSON.stringify(results, null, 2),
        );
        assert.ok(
          delta(pixels[0], pixels[1]) <= 2,
          `opaque outside-card surface: ${JSON.stringify(info)}`,
        );
        assert.ok(
          delta(pixels[0], pixels[2]) >= 15,
          `card background was removed: ${JSON.stringify(info)}`,
        );
        assert.ok(
          delta(pixels[0], pixels[3]) >= 30,
          `rectangle edge hidden in iframe gutter: ${JSON.stringify(info)}`,
        );
        // Switch themes in the same live instance; presentation must not reboot it.
        await p.evaluate(
          () =>
            (window.__originalTransparencyFrame = document.querySelector(
              ".canvas-html-app iframe",
            )),
        );
        await p.locator(".excalidraw").focus();
        await p.keyboard.press("Alt+Shift+D");
        await p
          .locator(
            theme === "light"
              ? ".excalidraw.theme--dark"
              : ".excalidraw:not(.theme--dark)",
          )
          .waitFor();
        await p.waitForTimeout(100);
        const changed = await readPixels(p, await p.screenshot(), [
          [180, 500],
          [260, 500],
        ]);
        assert.ok(
          delta(changed[0], changed[1]) <= 2,
          "theme change made frame opaque",
        );
        assert.equal(
          await p.evaluate(
            () =>
              window.__originalTransparencyFrame ===
              document.querySelector(".canvas-html-app iframe"),
          ),
          true,
        );
        await p.locator(".excalidraw").focus();
        await p.keyboard.press("Alt+Shift+D");
        await p
          .locator(
            theme === "dark"
              ? ".excalidraw.theme--dark"
              : ".excalidraw:not(.theme--dark)",
          )
          .waitFor();
        if (os === "dark" && theme === "light") {
          await p.mouse.click(box.x + 12, box.y + 12);
          await root.locator('[aria-label="放大试用"]').click();
          await p.locator(".note-chat-html-dialog.is-expanded").waitFor();
          await p.locator('[aria-label="关闭放大"]').click();
          await p
            .locator(".note-chat-html-dialog.is-expanded")
            .waitFor({ state: "detached" });
          await p.waitForTimeout(100);
          const restored = await readPixels(p, await p.screenshot(), [
            [180, 500],
            [260, 500],
          ]);
          assert.ok(
            delta(restored[0], restored[1]) <= 2,
            "close expansion restored white backdrop",
          );
          await p.mouse.click(1050, 800);
          await p.locator('[data-testid="main-menu-trigger"]').click();
          await p.locator('[data-testid="image-export-button"]').click();
          for (const format of ["PNG", "SVG"]) {
            const downloading = p.waitForEvent("download", { timeout: 60000 });
            await p
              .getByRole("button", { name: `Export to ${format}`, exact: true })
              .click();
            const d = await downloading;
            const file = path.join(output, `current.${format.toLowerCase()}`);
            await d.saveAs(file);
            const data = await fs.readFile(file);
            if (format === "SVG") {
              assert.ok(!/<script|<foreignObject/i.test(data.toString()));
            }
            // Native export adds a 10px margin to the scene's x=50, y=160 bounds.
            const exported = await readPixels(
              p,
              data,
              [
                [140, 350],
                [220, 350],
              ],
              format === "SVG" ? "image/svg+xml" : "image/png",
            );
            assert.ok(
              delta(exported[0], exported[1]) <= 2,
              `${format} has an opaque outer surface`,
            );
          }
        }
        await c.close();
      }
    }
    console.log(
      "PASS: 4 OS/app theme pairs, actual background pixels + complete rectangle, card preserved, live theme change, expansion and PNG/SVG",
    );
  } finally {
    await browser?.close();
    await fs.rm(path.join(directory, filename), { force: true });
    for (const kind of [".apps", ".chats"]) {
      await fs.rm(path.join(directory, kind, noteId), {
        force: true,
        recursive: true,
      });
    }
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

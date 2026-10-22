/* Read failures are injected only into this browser. The shared data mount stays fixed. */
/* eslint-disable no-console */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const puppeteer = require("puppeteer-core");
const base = "http://127.0.0.1:3009";
const name = `__binding-recovery-${randomUUID()}.excalidraw`;
const noteId = randomUUID();
const directory = path.resolve(__dirname, "../../.local-data/preview/notes");
const element = {
  id: randomUUID(),
  type: "rectangle",
  x: 100,
  y: 100,
  width: 120,
  height: 80,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 1,
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
};
const fixture = {
  type: "excalidraw",
  version: 2,
  elements: [element],
  files: {},
  appState: {},
  repositoryMetadata: { version: 1, noteId },
};
const json = async (url, init) => {
  const response = await fetch(base + url, init);
  assert.ok(response.ok, `${response.status} ${url}`);
  return response.json();
};
(async () => {
  await json(`/api/notes/${name}`, {
    method: "PUT",
    body: JSON.stringify(fixture),
  });
  const browser = await puppeteer.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(
      ({ name, element }) => {
        if (
          window !== window.top ||
          localStorage.getItem("binding-test-initialized")
        ) {
          return;
        }
        localStorage.setItem("binding-test-initialized", "true");
        localStorage.setItem("aldebaran.repository-note-name", name);
        localStorage.setItem("excalidraw", JSON.stringify([element]));
        localStorage.setItem(
          "excalidraw-state",
          JSON.stringify({ scrollX: 0, scrollY: 0, zoom: { value: 1 } }),
        );
      },
      { name, element },
    );
    const writes = [];
    const errors = [];
    let mode = "500";
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        request.method() === "PUT" &&
        url.pathname.startsWith("/api/notes/")
      ) {
        writes.push({
          url: url.pathname,
          headers: request.headers(),
          body: JSON.parse(request.postData()),
        });
      }
      if (
        request.method() === "GET" &&
        url.pathname === `/api/notes/${name}` &&
        mode !== "ok"
      ) {
        if (mode === "network") {
          return void request.abort("connectionfailed");
        }
        return void request.respond({
          status: mode === "404" ? 404 : mode === "parse" ? 200 : 500,
          contentType: "application/json",
          body:
            mode === "parse"
              ? "invalid JSON"
              : JSON.stringify({ error: "browser-only fault" }),
        });
      }
      void request.continue();
    });
    const binding = () =>
      page.evaluate(() =>
        localStorage.getItem("aldebaran.repository-note-name"),
      );
    const clickRetry = async () => {
      const handle = await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".RepositorySyncStatus__retry")].find(
            (node) => {
              const box = node.getBoundingClientRect();
              const hit = document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              );
              return (
                box.width > 0 &&
                box.height > 0 &&
                (hit === node || node.contains(hit))
              );
            },
          ),
        { polling: 100 },
      );
      const box = await handle.asElement().boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await handle.dispose();
    };
    const draw = async (x) => {
      await page.keyboard.press("r");
      await page.mouse.move(x, 350);
      await page.mouse.down();
      await page.mouse.move(x + 100, 430, { steps: 5 });
      await page.mouse.up();
      await page.keyboard.press("v");
    };
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector(".RepositorySyncStatus__retry", {
      timeout: 120000,
    });
    assert.equal(await binding(), name);
    await draw(400);
    await page.waitForTimeout(1300);
    assert.equal(
      writes.length,
      0,
      "paused edit must not create or overwrite a file",
    );
    assert.equal(await binding(), name);
    await page.screenshot({
      path: "/tmp/note-binding-paused.png",
      captureBeyondViewport: false,
    });
    console.log(
      "HTTP 500: binding and canvas retained; editing creates no file",
    );

    mode = "ok";
    await clickRetry();
    await page.waitForSelector(".ai-widget-conflict", { timeout: 15000 });
    assert.equal(writes.length, 0);
    await page.evaluate(() =>
      [...document.querySelectorAll(".ai-widget-conflict button")]
        .find((node) => node.textContent.includes("放弃草稿"))
        .click(),
    );
    await page.waitForFunction(
      () =>
        !document.querySelector(".RepositorySyncStatus__retry") &&
        !document.querySelector(".ai-widget-conflict") &&
        document.querySelector(
          ".RepositorySyncStatus--external, .RepositorySyncStatus--synced",
        ),
      { polling: 100 },
    );
    assert.equal(await binding(), name);
    await draw(600);
    await page.waitForFunction(
      () => document.querySelector(".RepositorySyncStatus--synced"),
      { polling: 100 },
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, `/api/notes/${name}`);
    assert.ok(writes[0].headers["if-match"]);
    assert.equal(writes[0].body.repositoryMetadata.noteId, noteId);
    assert.equal(
      (await json(`/api/notes/${name}`)).repositoryMetadata.noteId,
      noteId,
    );
    console.log(
      "retry protects unsaved edits; confirmed reload resumes original-file ETag saves",
    );

    for (const failure of ["404", "network", "parse"]) {
      mode = failure;
      // Independent fault cases, not the persistent-draft recovery case.
      await page.evaluate(() =>
        localStorage.removeItem("aldebaran.repository-note-recovery"),
      );
      await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForSelector(".RepositorySyncStatus__retry", {
        timeout: 30000,
      });
      assert.equal(await binding(), name);
      assert.equal(writes.length, 1);
      const label = await page.$eval(
        ".RepositorySyncStatus",
        (node) => node.textContent,
      );
      assert.ok(label.includes(failure === "404" ? "文件未找到" : "读取失败"));
      console.log(
        `${failure}: original binding retained and explicit recovery shown`,
      );
    }
    await page.setViewport({ width: 390, height: 844 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".RepositorySyncStatus__retry")].some(
          (node) => {
            const box = node.getBoundingClientRect();
            return box.width > 0 && box.x >= 0 && box.right <= 390;
          },
        ),
      { polling: 100 },
    );
    await page.screenshot({
      path: "/tmp/note-binding-paused-mobile.png",
      captureBeyondViewport: false,
    });
    await page.setViewport({ width: 1440, height: 1000 });
    mode = "ok";
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector(".RepositorySyncStatus__retry", {
      timeout: 30000,
    });
    assert.equal(await binding(), name);
    assert.equal(writes.length, 1);
    await clickRetry();
    await page.waitForSelector(".ai-widget-conflict", { timeout: 15000 });
    console.log(
      "refresh after an interrupted load preserves the cached canvas until confirmation",
    );
    // A new browser run refresh must not manufacture a timestamped copy.
    assert.deepEqual(errors, []);
    console.log(
      "PASS: failure, edits, recovery, ETag identity and reload; no duplicate note",
    );
  } finally {
    const force = setTimeout(() => browser.process()?.kill(), 5000);
    await browser.close();
    clearTimeout(force);
    // Remove only this run's explicitly created fixture.
    await fs.unlink(path.join(directory, name));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

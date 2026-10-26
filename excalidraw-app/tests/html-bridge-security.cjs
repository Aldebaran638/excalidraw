/* Privileged bridge tests: no canvas writes and no model requests. */
/* eslint-disable no-console */
/* global BridgeRuntime */
const assert = require("node:assert/strict");

const { buildSync } = require("esbuild");
const { chromium } = require("playwright-core");
(async () => {
  const code = buildSync({
    entryPoints: ["excalidraw-app/data/htmlRuntime.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "BridgeRuntime",
  }).outputFiles[0].text;
  const browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error("iframe:", error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.error(message.text());
      }
    });
    await page.route("**/__bridge-security", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><body></body>",
      }),
    );
    await page.goto("http://127.0.0.1:3009/__bridge-security");
    await page.addScriptTag({ content: code });
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.sandbox = "allow-scripts";
      frame.width = "700";
      frame.height = "480";
      document.body.appendChild(frame);
      window.bridgeFrame = frame;
      window.bridgeEvents = [];
      window.bridgeRejected = 0;
      window.addEventListener("message", async (event) => {
        if (event.source !== frame.contentWindow) {
          return;
        }
        if (event.data?.token !== "private-out") {
          if (event.data?.type === "history") {
            window.bridgeRejected++;
          }
          return;
        }
        window.bridgeEvents.push(event.data);
        if (event.data.type === "library_request") {
          if (event.data.data.name !== "react") {
            return;
          }
          const response = await fetch("/app-libraries/react.js");
          frame.contentWindow.postMessage(
            {
              token: "public-in",
              type: "library_result",
              data: { name: "react", source: await response.text() },
            },
            "*",
          );
        }
      });
      frame.srcdoc = BridgeRuntime.htmlBootstrap(
        "private-out",
        { forms: {}, custom: {} },
        3,
        "",
        "public-in",
      );
    });
    await page.waitForFunction(
      () => window.bridgeEvents.some((event) => event.type === "ready"),
      undefined,
      { polling: 100 },
    );
    await page.evaluate(() => {
      const frame = window.bridgeFrame;
      frame.contentWindow.postMessage(
        { token: "public-in", type: "history_support", data: true },
        "*",
      );
      const source = `<main id="app"><button id="control">控件</button><input id="text"></main><script>(async()=>{
      const realParent=window.parent;window.bridgeLeaks=0;
      const descriptor=Object.getOwnPropertyDescriptor(window,'parent');
      try {Object.defineProperty(window,'parent',{configurable:true,value:{postMessage(){window.bridgeLeaks++}}});NoteApp.load('react');}
      catch {} finally {if(descriptor)Object.defineProperty(window,'parent',descriptor);}
      window.addEventListener('message',event=>{if(!event.isTrusted)return;realParent.postMessage({token:event.data.token,type:'history',data:'undo'},'*');window.dispatchEvent(new MessageEvent('message',{source:realParent,data:{token:event.data.token,type:'dispose'}}));});
      document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));
      document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      const {React}=await NoteApp.load('react');NoteApp.set('reactVersion',React.version);window.bridgeAppReady=true;
      })()</script>`;
      frame.contentWindow.postMessage(
        { token: "public-in", type: "append", data: source },
        "*",
      );
      frame.contentWindow.postMessage(
        { token: "public-in", type: "finish" },
        "*",
      );
    });
    const frame = page.frameLocator("iframe");
    await page.waitForFunction(
      () =>
        window.bridgeEvents.some(
          (event) => event.type === "state" && event.data.custom.reactVersion,
        ),
      undefined,
      { polling: 100 },
    );
    assert.equal(
      await frame
        .locator("body")
        .evaluate((node) => node.ownerDocument.defaultView.bridgeLeaks),
      0,
    );
    assert.ok(
      await page.evaluate(() => window.bridgeRejected > 0),
      "forgery probe did not run",
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.bridgeEvents.filter((event) =>
            ["history", "escape"].includes(event.type),
          ).length,
      ),
      0,
      "synthetic events reached host privileges",
    );
    await frame.locator("#control").focus();
    await page.bringToFront();
    await frame.locator("body").evaluate((node) => {
      const win = node.ownerDocument.defaultView;
      win.keyDescriptor = Object.getOwnPropertyDescriptor(
        win.KeyboardEvent.prototype,
        "key",
      );
      win.ctrlDescriptor = Object.getOwnPropertyDescriptor(
        win.KeyboardEvent.prototype,
        "ctrlKey",
      );
      Object.defineProperty(win.KeyboardEvent.prototype, "key", {
        configurable: true,
        get: () => "z",
      });
      Object.defineProperty(win.KeyboardEvent.prototype, "ctrlKey", {
        configurable: true,
        get: () => true,
      });
    });
    await page.keyboard.press("a");
    assert.equal(
      await page.evaluate(
        () =>
          window.bridgeEvents.filter((event) => event.type === "history")
            .length,
      ),
      0,
      "prototype spoof changed a native key",
    );
    await frame.locator("body").evaluate((node) => {
      const win = node.ownerDocument.defaultView;
      Object.defineProperty(
        win.KeyboardEvent.prototype,
        "key",
        win.keyDescriptor,
      );
      Object.defineProperty(
        win.KeyboardEvent.prototype,
        "ctrlKey",
        win.ctrlDescriptor,
      );
    });
    await page.keyboard.press("Control+z");
    await page.waitForFunction(
      () =>
        window.bridgeEvents.some(
          (event) => event.type === "history" && event.data === "undo",
        ),
      undefined,
      { polling: 100 },
    );
    const count = await page.evaluate(
      () =>
        window.bridgeEvents.filter((event) => event.type === "history").length,
    );
    await frame.locator("#text").focus();
    await page.keyboard.press("Control+z");
    assert.equal(
      await page.evaluate(
        () =>
          window.bridgeEvents.filter((event) => event.type === "history")
            .length,
      ),
      count,
      "text undo reached canvas history",
    );
    assert.deepEqual(
      await page.evaluate(() =>
        window.bridgeEvents.filter((event) => event.type === "error"),
      ),
      [],
    );
    console.log(
      "PASS directional tokens, captured parent/native accessors, forged-message rejection, synthetic-key rejection, actual native undo and text editing",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/* Actual bundled libraries in the same opaque sandbox, no extra preview. */
/* eslint-disable no-console */
/* global HTMLRuntime, HTMLLibraries */
const assert = require("node:assert/strict");

const { buildSync } = require("esbuild");
const puppeteer = require("puppeteer-core");

(async () => {
  const runtime = buildSync({
    entryPoints: ["excalidraw-app/data/htmlRuntime.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "HTMLRuntime",
  }).outputFiles[0].text;
  const browser = await puppeteer.launch({
    executablePath:
      process.env.BROWSER_EXECUTABLE ||
      "/home/aldebaran/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    headless: true,
    pipe: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) =>
      console.log("library page error", String(error)),
    );
    page.on("console", (message) =>
      console.log("library console", message.text()),
    );
    await page.setRequestInterception(true);
    page.on(
      "request",
      (r) =>
        void (r.url().endsWith("/__library-unit")
          ? r.respond({
              status: 200,
              contentType: "text/html",
              body: "<body></body>",
            })
          : r.continue()),
    );
    await page.goto("http://127.0.0.1:3009/__library-unit");
    await page.addScriptTag({ content: runtime });
    await page.addScriptTag({
      content: buildSync({
        entryPoints: ["excalidraw-app/data/htmlLibraryStream.ts"],
        bundle: true,
        write: false,
        format: "iife",
        globalName: "HTMLLibraries",
      }).outputFiles[0].text,
    });
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.sandbox = "allow-scripts";
      frame.width = "700";
      frame.height = "600";
      window.testFrame = frame;
      window.events = [];
      window.addEventListener("message", async (e) => {
        if (e.source !== frame.contentWindow || e.data?.token !== "libraries") {
          return;
        }
        window.events.push(e.data);
        if (e.data.type === "library_request") {
          const name = e.data.data.name;
          if (!["react", "d3", "mermaid"].includes(name)) {
            return;
          }
          const r = await fetch(`/app-libraries/${name}.js`);
          frame.contentWindow.postMessage(
            {
              token: "libraries",
              type: "library_result",
              data: { name, source: await r.text() },
            },
            "*",
          );
        }
      });
      document.body.append(frame);
      frame.srcdoc = HTMLRuntime.htmlBootstrap(
        "libraries",
        {
          forms: { task: { type: "text", value: "恢复的任务" } },
          custom: { count: 3 },
        },
        3,
      );
    });
    await page
      .waitForFunction(() => window.events.some((e) => e.type === "ready"), {
        polling: 100,
        timeout: 10000,
      })
      .catch(async (error) => {
        console.log("parent events", await page.evaluate(() => window.events));
        for (const frame of page.frames()) {
          console.log(
            "boot diagnostic",
            frame.url(),
            await frame
              .evaluate(() => ({
                state: document.readyState,
                html: document.documentElement?.outerHTML.slice(0, 800),
                scripts: document.scripts.length,
              }))
              .catch(String),
          );
        }
        throw error;
      });
    await page.evaluate(async () => {
      const source = `<main><div id="react-root"></div><svg id="d3-root"></svg><div id="mermaid-root"></div></main><script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><script>(async()=>{
      const one=NoteApp.load('react');const two=NoteApp.load('react');if(one!==two)throw new Error('duplicate library installation');
      const {React,ReactDOM}=await one;function Counter(){const [n,set]=React.useState(NoteApp.get('count',0));return React.createElement('div',null,React.createElement('input',{id:'task'}),React.createElement('button',{id:'inc',onClick:()=>{set(n+1);NoteApp.set('count',n+1)}},String(n)))}ReactDOM.createRoot(document.getElementById('react-root')).render(React.createElement(Counter));
      const d3=await NoteApp.load('d3');d3.select('#d3-root').selectAll('circle').data([10,20,30]).join('circle').attr('cx',d=>d).attr('cy',20).attr('r',4);
      const mermaid=await NoteApp.load('mermaid');mermaid.initialize({startOnLoad:false,securityLevel:'strict'});const result=await mermaid.render('test-mermaid','flowchart LR; client-->server; server-->database');document.getElementById('mermaid-root').innerHTML=result.svg;
      })()</script>`;
      const stream = new HTMLLibraries.HtmlLibraryStream();
      for (const piece of stream.push(source, true)) {
        if ("html" in piece) {
          window.testFrame.contentWindow.postMessage(
            { token: "libraries", type: "append", data: piece.html },
            "*",
          );
        } else {
          await new Promise((resolve, reject) => {
            const receive = (e) => {
              if (
                e.source !== window.testFrame.contentWindow ||
                e.data?.token !== "libraries" ||
                e.data.type !== "library_prepared"
              ) {
                return;
              }
              removeEventListener("message", receive);
              e.data.data.error
                ? reject(new Error(e.data.data.error))
                : resolve();
            };
            addEventListener("message", receive);
            window.testFrame.contentWindow.postMessage(
              {
                token: "libraries",
                type: "library_prepare",
                data: { name: piece.library },
              },
              "*",
            );
          });
        }
      }
      window.testFrame.contentWindow.postMessage(
        { token: "libraries", type: "finish" },
        "*",
      );
    });
    const frame = page.frames().find((f) => f.parentFrame());
    await frame.waitForSelector("#inc", { timeout: 45000 });
    assert.equal(await frame.$eval("#inc", (e) => e.textContent), "3");
    assert.equal(await frame.$eval("#task", (e) => e.value), "恢复的任务");
    await frame.$eval("#inc", (el) => el.click());
    await frame.waitForFunction(
      () => document.querySelector("#inc")?.textContent === "4",
      { polling: 100 },
    );
    await frame.waitForFunction(
      () => document.querySelectorAll("#d3-root circle").length === 3,
      { polling: 100, timeout: 45000 },
    );
    await frame.waitForSelector("#mermaid-root svg", { timeout: 45000 });
    const errors = await page.evaluate(() =>
      window.events.filter((e) => e.type === "error"),
    );
    assert.deepEqual(errors, []);
    assert.equal(
      await page.evaluate(
        () =>
          window.events.filter(
            (e) => e.type === "library_request" && e.data.name === "react",
          ).length,
      ),
      1,
    );
    assert.equal(
      await frame.evaluate(
        () =>
          window.parent === window ||
          (() => {
            try {
              return !!window.parent.document;
            } catch {
              return false;
            }
          })(),
      ),
      false,
    );
    console.log(
      "PASS real React interaction/state, async form restore, D3 SVG, Mermaid SVG, one-time loading and host isolation",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

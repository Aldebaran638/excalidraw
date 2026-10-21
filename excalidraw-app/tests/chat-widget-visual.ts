/* Read-only frontend fixture: ALL note/chat APIs are intercepted, no disk writes. */
/* eslint-disable no-console */
import assert from "node:assert/strict";

import puppeteer from "puppeteer-core";

import { ARCHITECTURE } from "../../packages/interactive-widgets/designExamples";
import { EXAMPLES } from "../../packages/interactive-widgets/examples";

const base = process.env.APP_URL || "http://127.0.0.1:3009";
const noteId = "visual-fixture-note";
const sessionId = "visual-fixture-session";
const filename = "__virtual-widget-visual.excalidraw";
const entries = [
  ARCHITECTURE,
  { ...EXAMPLES.matrix, version: 2 as const },
  { ...EXAMPLES.attention, version: 2 as const },
];
const artifacts = entries.map((definition, index) => ({
  noteId,
  sessionId,
  artifactId: `visual-artifact-${index}`,
  version: 1,
  revision: 0,
  turnId: `visual-turn-${index}`,
  toolCallId: `visual-call-${index}`,
  createdAt: 1,
  region: { width: 700, height: 480 },
  document: {
    version: 2,
    catalogVersion: 2,
    definition,
    state: definition.initialState,
    prompt: "只读视觉验收",
  },
  summary: "来自仓库现成示例的视觉验收，不调用模型。",
  versions: [{ version: 1, title: definition.title }],
}));
const messages = artifacts.map((data, index) => ({
  id: `visual-message-${index}`,
  turnId: data.turnId,
  role: "assistant",
  content: "组件库示例",
  status: "complete",
  createdAt: 1,
  activities:
    index === 0
      ? [
          {
            id: "invalid-candidate",
            name: "create_widget_draft",
            status: "complete",
            snapshotAt: 1,
            elementIds: [],
            summary: "组件生成未完成：格式校验失败，本轮可重试",
            details:
              '/root/children/0/style: 不支持属性 "borderRadius"；允许属性：background, color, borderColor, padding, gap, radius, fontSize, align, weight',
          },
          {
            id: "valid-candidate",
            name: "create_widget_draft",
            status: "complete",
            snapshotAt: 1,
            elementIds: [],
            summary: "组件候选已生成并保存",
          },
        ]
      : [],
  artifacts: [
    {
      artifactId: data.artifactId,
      version: 1,
      title: data.document.definition.title,
    },
  ],
}));
const session = {
  version: 1,
  noteId,
  id: sessionId,
  title: "组件库视觉验收",
  manualTitle: false,
  createdAt: 1,
  updatedAt: 1,
  revision: 0,
  messages,
};
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_EXECUTABLE,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/notes")) {
      void request.continue();
      return;
    }
    const headers = {
      "Content-Type": "application/json",
      ETag: '"visual-fixture"',
    };
    let data: unknown;
    if (url.pathname === "/api/notes/events") {
      void request.respond({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: ": visual fixture\n\n",
      });
      return;
    }
    if (url.pathname === "/api/notes") {
      data = { notes: [filename] };
    } else if (url.pathname.endsWith(".excalidraw")) {
      data = {
        type: "excalidraw",
        version: 2,
        source: "fixture",
        elements: [],
        appState: {},
        files: {},
        repositoryMetadata: { version: 1, noteId },
      };
    } else if (url.pathname.endsWith("/chats")) {
      data = { sessions: [{ ...session, generating: false }] };
    } else if (url.pathname.includes("/artifacts/")) {
      data = artifacts.find((entry) => url.pathname.endsWith(entry.artifactId));
    } else {
      data = session;
    }
    void request.respond({ status: 200, headers, body: JSON.stringify(data) });
  });
  await page.evaluateOnNewDocument(
    (name: string) =>
      localStorage.setItem("aldebaran.repository-note-name", name),
    filename,
  );
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
  // Freeze decorative transitions so screenshots show the settled sidebar,
  // rather than a frame midway through its native entrance animation.
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation: none !important; transition: none !important; }",
  });
  await page.waitForSelector('[aria-label="打开笔记聊天"]', {
    timeout: 120000,
  });
  await page.click('[aria-label="打开笔记聊天"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".note-chat-widget .iw-view .iw-node").length >
      10,
    { timeout: 120000 },
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".note-chat-widget .iw-view").length === 3,
    { timeout: 120000 },
  );
  assert.equal(
    await page.$$(".note-chat-widget .iw-error").then((nodes) => nodes.length),
    0,
  );
  await page.click(".note-chat-reading summary");
  const activityText = await page.$eval(
    ".note-chat-reading",
    (node) => node.textContent || "",
  );
  assert.ok(activityText.includes("工具活动 2 次"));
  assert.ok(activityText.includes("组件生成未完成"));
  assert.ok(activityText.includes("组件候选已生成并保存"));
  await page.click(".note-chat-tool-details summary");
  assert.ok(
    await page.$eval(
      ".note-chat-tool-details",
      (node) => (node as HTMLDetailsElement).open,
    ),
  );
  assert.ok(
    await page.$eval(".note-chat-tool-details pre", (node) =>
      node.textContent?.includes('不支持属性 "borderRadius"'),
    ),
  );
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "/tmp/chat-widget-quota-activity.png",
    captureBeyondViewport: false,
  });
  for (let index = 0; index < 3; index++) {
    const cards = await page.$$(".note-chat-widget");
    await cards[index].evaluate((node) =>
      node.scrollIntoView({ block: "start" }),
    );
    await page.screenshot({ path: `/tmp/chat-widget-catalog-${index}.png` });
  }
  assert.ok(
    await page.$$eval(".note-chat-widget input", (nodes) => nodes.length > 0),
  );
  await page.focus(".excalidraw");
  await page.keyboard.down("Shift");
  await page.keyboard.down("Alt");
  await page.keyboard.press("d");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Shift");
  await page.waitForSelector(".excalidraw.theme--dark");
  await page.screenshot({ path: "/tmp/chat-widget-catalog-dark.png" });
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await page.screenshot({ path: "/tmp/chat-widget-catalog-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS architecture, matrix and Attention chat previews, themed/mobile screenshots and no runtime errors (intercepted read-only fixture)",
  );
} finally {
  await browser.close();
}

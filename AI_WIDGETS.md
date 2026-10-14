# Interactive component groups

Open **More tools → AI 组件**, drag a region and describe the app. The region does not replace existing drawings. Generate with Qwen, try the preview, then choose **放入笔记**. The panel also contains five offline examples: Kubernetes cards, calculator, data filter, matrix transform and Attention.

Single-click selects the whole widget. Double-click or **进入交互** enables its controls; Escape exits. Move, resize, copy and delete using ordinary canvas operations. Narrow layouts reflow instead of stretching controls. **放大操作** shares the persisted state with the canvas. **展开完整内容** adjusts the overall height; **重置输入** restores defaults. Changes can be undone and redone.

**AI 修改** sends the current definition and state with your instruction. Modification preview is enabled by default; its setting is saved locally. New widgets always require preview confirmation. **添加选中上下文** sends only explicitly selected text/matrix content. It does not automatically send your entire note or images. Invalid, cancelled or stale AI results never replace the existing widget. When an external note update conflicts with an unconfirmed input or preview, choose to keep a copy or discard the draft before loading it.

## Architecture

- `packages/interactive-widgets`: component catalog, shared JSON Schema, semantic validation, expression evaluation, actions, Worker, shared layout, interactive view and trusted static SVG. No arbitrary JS, HTML, CSS, imports or network requests from a widget definition.
- `excalidraw-app/hooks/useAIWidgets.tsx`: canvas host, selection region, preview, state/history updates and stale-response checks.
- `excalidraw-app/server/ai.ts`: fixed-config Qwen proxy, validation and one repair attempt. `server/notes.ts`: shared revision-aware persistence and SSE.
- Core Excalidraw uses its native `embeddable` and `renderEmbeddable` hook. Generic `customData.embeddable` capabilities protect internal content and provide trusted export snapshots. It contains no Qwen address or widget catalog business logic.

`customData.aiWidget` contains document/catalog versions, definition, state and the recent prompt. A definition has read-only datasets, initial state, derived computations and a root component tree. Bindings use literal/ref/op expressions. Actions are bounded set/toggle/reset/step/batch operations; nested Pressables execute the innermost action only. Repeat instances use stable keys and local scope. Unknown versions or damaged definitions retain their original data and show a readable placeholder. Version 1 is the first persisted catalog; future catalog migrations must be explicit.

Limits: 256KB definition, 300 source nodes, 600 expanded nodes, 100 computations, 20×20 matrices and 2,000 chart points. Computation times out after one second in a Worker. Character/string matrices display normally; numeric operations report the location of nonnumeric cells. Formula SVG is generated through trusted KaTeX MathML and a shared bounded layout, not raw HTML from the model.

The `.excalidraw` file retains all interactivity. PNG/SVG export contains a static snapshot of persistent state and the current outer scroll position. Focus, hover, scroll and animation frames do not cause repeated writes. Control edits commit on confirmation, blur or completion of a slider gesture; buttons and batches commit once. Pausing a player saves its paused step.

## Verification

```bash
corepack yarn vitest run packages/interactive-widgets/widgets.test.ts excalidraw-app/tests/services.test.ts
corepack yarn test:typecheck
corepack yarn build:production
BROWSER_EXECUTABLE=/path/to/chromium corepack yarn test:widgets:browser
TEST_REAL_QWEN=true BROWSER_EXECUTABLE=/path/to/chromium corepack yarn test:widgets:browser
APP_URL=http://127.0.0.1:3102 BROWSER_EXECUTABLE=/path/to/chromium corepack yarn test:widgets:production
```

The browser acceptance runner targets the development server and creates a uniquely named temporary note, removed on completion. It does not edit user notes. See [DOCKER.md](DOCKER.md) for production configuration. The production runner must target a test server with an isolated temporary notes directory; it leaves a uniquely named fixture there for inspection.

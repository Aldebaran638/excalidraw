# HTML chat preview acceptance

The application lives in the app layer, not the canvas element system. Ordinary `delta.content` passes through `HtmlFenceStream` into identified message blocks. A card retains one opaque-origin iframe/parser across stream updates and native dialog enlargement. Only rerun, version changes or unmount replace that parser.

## Compatibility diagnostics

`GET /api/client-info` reports the published entry asset, chat protocol and HTML runtime versions. Compare it with the loaded entry in a card's **版本信息**. Protocol-aware requests send `X-Chat-Protocol: 2` and `X-Chat-Capabilities: html-blocks`. Production and Vite reject incapable clients before a model request. Legacy reads receive an explanatory text projection; the stored conversation is unchanged. Worker activation is user initiated.

Replaying the user's copied todo/calculator/pomodoro records with the pre-HTML entry `index-Bc6mpJFH.js` reproduced zero cards, while the HTML-aware entry showed three. This establishes a reproducible compatibility failure, not proof of the cache version in the user's unconnected original browser tab. Use the displayed loaded/published entries to diagnose that tab. Never regenerate over evidence.

## Runtime v2 contract

- `get(key, fallback)` returns a JSON copy; call `set(key, value)` to commit. Initialization reads defaults rather than unconditionally writing them.
- `once(rootId, setup)` initializes once and accepts a cleanup callback.
- `on(key, rootId, event, selector, handler)` replaces an existing keyed delegate; future controls must actually be descendants of that root.
- `interval(key, callback, ms)` keeps one timer per key; `clearInterval(key)` removes it. Persist absolute deadlines, not per-frame remaining time.
- `patch(id, {text, style, attrs, appendHtml, remove})` validates the whole patch before changing the DOM. Input values, focused editable trees and registered runtime roots cannot be cleared/replaced. Appended markup cannot install code; use a later complete ordinary script for logic. Rejections appear in the card.

Missing runtime versions use v1. Unknown versions retain source and show an upgrade error. Arbitrary generated JavaScript can bypass the patch contract: this runtime does not promise transparent state preservation for arbitrary DOM replacement, closed-over variables, raw timers or deliberately reset defaults. There is no automatic extra generation/repair request.

## Deterministic checks

From the repository root:

```sh
node excalidraw-app/tests/chat-html-runtime.cjs
node excalidraw-app/tests/chat-html-runtime-v2.cjs
node node_modules/vitest/vitest.mjs run excalidraw-app/tests packages/interactive-widgets
```

`chat-preview-recovery.cjs` requires an isolated copy named `/tmp/excalidraw-chat-recovery.*`, including the existing records. Optional `LEGACY_STATIC_DIR` replays the archived frontend without regenerating anything.

`chat-html-live-patch.cjs` checks the production/SSE/card pipeline with `chat-html-fixture.cjs` (`FIXTURE_V2=1`). Bind the fixture privately or execute it inside the preview container; it is an upstream fixture, not another app preview. Use only app port 3009 and a `TEST_NOTES_DIR` starting `/tmp/excalidraw-chat-html-`. It checks interaction before stream completion, late patches, visible conflicts, saved state, refresh and enlargement.

`chat-preview-upgrade.cjs` expects the reliability commit built as `excalidraw-preview-preview:reliability-baseline` and a restartable `excalidraw-preview-preview-1` containing the new build. Both use only 3009, sequentially, with the recovery copy. It retains a real active worker/cache, checks that updating does not force a reload, then explicitly activates the waiting update and verifies draft/card recovery. Its temporary container is removed; the data mount is not deleted. This is separate from replaying the much older pre-HTML frontend.

## Real model checks

`chat-html-contract-real.cjs` requires real Qwen and the same isolated directory prefix. It sends one ordinary request each for a timer, calculator and architecture explainer, feeds actual SSE deltas through the production runtime, and records early visibility, contract use, interaction and errors separately from mocks. Timer state is also replayed against the returned source. Model-authored semantic mistakes must be reported rather than silently replacing the source with fixtures.

After acceptance, restore the previous preview notes/chat mount and real upstream. Do not replace port 3001, delete the user's records, or run fixtures against daily notes. Temporary data is retained for diagnosis, not silently cleaned up.

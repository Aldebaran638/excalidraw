# Guidelines

- For new DOM/browser API usage, use `app.ownerDocument` and `app.ownerWindow` instead of globals; without `app`, derive them from the mounted node's `ownerDocument` and its `defaultView`.

## Project skill

- For design, implementation or review of canvas tools, AI widgets, note workflows and application UI, first read and apply `.agents/skills/excalidraw-product-engineering/SKILL.md`. It defines this project's UX, visual quality, native architecture and acceptance requirements; it does not grant additional execution permissions.

## Preview service

- Keep the daily Excalidraw production service on port 3010 untouched unless explicitly requested; it mounts the original `./notes/`. Port 3001 belongs to another project and must not be stopped or replaced. Use one fixed preview port, 3009, for both development and production acceptance; do not leave parallel application previews on 3002–3008 or allocate additional preview ports. Stop the previous preview before replacing it, and preserve its notes and chat storage. Production and preview data stay independent unless the user explicitly requests a transfer.
- Port 3009 is the shared test application and always mounts `./.local-data/preview/notes/`. Notes, `.chats/` sessions and generated artifacts must persist there across updates, not in `/tmp`. Do not switch this service to another acceptance dataset or create a second application test environment. Back up before risky testing; additive fixtures must have unique names and cleanup may remove only the exact fixtures created by that test, never user records. Unit-test temporary directories/ephemeral ports and private upstream fixture ports remain allowed, but must never replace the running application's data directory.
- If replacing Docker with Vite on 3009, explicitly set `REPOSITORY_NOTES_DIR` to that same project's absolute `.local-data/preview/notes/` path; do not fall back to a different dataset. Older acceptance scripts that demand a disposable application directory must be adapted before use, not used as a reason to switch mounts.
- Real Qwen acceptance tests must run strictly serially: only one test request/agent loop at a time. Wait for it to finish before starting another; do not run parallel real-model test batches or overlap repair/replay requests with them. Mocked unit tests do not consume Qwen capacity.

## Local version management

- The user delegates local commit and branch organization to the agent. Keep `aldebaran` as the integration branch; develop substantial modules on short-lived `feat/*` branches and fast-forward merge only after acceptance. Commit related, independently runnable changes together. Do not push, rewrite existing commits, or include user note/plan edits by default. Record baseline and feature commit IDs in the handoff.

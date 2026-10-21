# Guidelines

- For new DOM/browser API usage, use `app.ownerDocument` and `app.ownerWindow` instead of globals; without `app`, derive them from the mounted node's `ownerDocument` and its `defaultView`.

## Project skill

- For design, implementation or review of canvas tools, AI widgets, note workflows and application UI, first read and apply `.agents/skills/excalidraw-product-engineering/SKILL.md`. It defines this project's UX, visual quality, native architecture and acceptance requirements; it does not grant additional execution permissions.

## Preview service

- Keep the daily service on port 3001 untouched unless explicitly requested. Use one fixed preview port, 3009, for both development and production acceptance; do not leave parallel application previews on 3002–3008 or allocate additional preview ports. Stop the previous preview before replacing it, and preserve its notes and chat storage.
- `docker-compose.preview.yml` requires an explicit isolated `PREVIEW_NOTES_DIR`; never point destructive acceptance scripts at the user's daily notes. Unit-test ephemeral ports and private upstream fixture ports are not application previews.

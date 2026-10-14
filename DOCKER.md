# Docker development and production

The default Compose service runs the `aldebaran` app through Vite so the repository-notes API remains available. The repository is bind-mounted at `/opt/node_app`; changes under `notes/` are therefore written directly to the host and survive container replacement.

## Start

```bash
corepack yarn docker:up
```

Open <http://localhost:3001>. Source edits are hot-reloaded. Changes to the root `package.json` or `yarn.lock` trigger an image rebuild while Compose Watch is active.

To run in the background instead:

```bash
corepack yarn docker:up:detached
```

## Stop

```bash
corepack yarn docker:down
```

Stopping or rebuilding the container does not delete repository notes. The `notes/` directory belongs to the host checkout; dependency volumes contain only `node_modules` data.

## Production

```bash
docker compose -f docker-compose.production.yml up -d --build
```

This builds the front end and a Node HTTP server, serving both from port 3001. Only `./notes` is mounted; the production image does not depend on a Vite dev server or a source bind mount. Stop the existing development service first if it already owns port 3001. Updates are explicit: run this command when you are finished editing, not while a browser has unsaved work. No automatic Git pulls or container replacement are performed during use.

```bash
docker compose -f docker-compose.production.yml down
```

The health check `/api/health` is independent of AI availability. Notes API, ETag conflict checks and SSE `/api/notes/events` work in both modes. Qwen being offline does not disable note saving or already-created interactive widgets.

## Qwen configuration

The server defaults to `http://172.31.69.234:8006/v1`, model `qwen3.8-27b`, without an authentication header. This private address must be reachable from the container. Configuration is server-side only:

```bash
QWEN_BASE_URL=http://172.31.69.234:8006/v1 \
QWEN_MODEL=qwen3.8-27b \
docker compose -f docker-compose.production.yml up -d --build
```

On the machine with the explicitly configured forward, use `QWEN_BASE_URL=http://10.252.221.218:18006/v1`. There is no automatic fallback. `QWEN_API_KEY` optionally enables Bearer authentication; never put a real key in browser/Vite environment variables or commit it. `/api/ai/status` checks the connection and model list, with a five-second timeout.

These services are intended for trusted local/private use. They do not add authentication to the notes or AI APIs. Do not expose port 3001 publicly without an authenticated reverse proxy.

Build-image overrides `NODE_BUILD_IMAGE` and `NODE_RUNTIME_IMAGE` are available for environments that cannot pull the default Node 24 images. Both images must provide a supported Node version (20 or newer); defaults remain Node 24.

Without Docker:

```bash
corepack yarn build:production
QWEN_BASE_URL=http://10.252.221.218:18006/v1 corepack yarn serve:production
```

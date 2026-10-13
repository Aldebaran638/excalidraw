# Docker development

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

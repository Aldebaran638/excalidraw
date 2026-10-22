// One-time, non-destructive recovery of the former preview directories.
// First source is the complete current dataset. Other sources recover user
// note-* files and their chat trees, not __ automated acceptance fixtures.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sources = process.argv.slice(2).map((entry) => path.resolve(entry));
if (
  !sources.length ||
  sources.some((entry) => !entry.startsWith("/tmp/excalidraw-"))
) {
  throw new Error(
    "Pass the former /tmp/excalidraw-* datasets, current dataset first. Stop port 3009 before migrating.",
  );
}
const destination = path.join(project, ".local-data/preview/notes");
const backup = path.join(
  project,
  ".local-data/backups",
  `preview-migration-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const files = new Map();
const exists = async (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
const collect = async (source, relative = "") => {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing symlink: ${source}`);
  }
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(source)) {
      await collect(path.join(source, entry), path.join(relative, entry));
    }
    return;
  }
  const content = await fs.readFile(source);
  if (files.has(relative) && !content.equals(files.get(relative).content)) {
    throw new Error(`Conflicting recovery files: ${relative}`);
  }
  files.set(relative, { source, content });
};
await collect(sources[0]);
for (const source of sources.slice(1)) {
  for (const name of await fs.readdir(source)) {
    if (!/^note-.*\.excalidraw$/.test(name)) {
      continue;
    }
    const file = path.join(source, name);
    const note = JSON.parse(await fs.readFile(file, "utf8"));
    await collect(file, name);
    const id = note.repositoryMetadata?.noteId;
    if (typeof id === "string" && /^[\w-]+$/.test(id)) {
      const relative = path.join(".chats", id);
      if (await exists(path.join(source, relative))) {
        await collect(path.join(source, relative), relative);
      }
    }
  }
}
// Preflight the complete merge before writing any destination file.
for (const [relative, { content }] of files) {
  const target = path.join(destination, relative);
  if ((await exists(target)) && !content.equals(await fs.readFile(target))) {
    throw new Error(`Destination conflict; nothing overwritten: ${relative}`);
  }
}
await fs.mkdir(backup, { recursive: true });
for (const source of sources) {
  await fs.cp(source, path.join(backup, path.basename(source)), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
}
for (const [relative, { content }] of files) {
  const target = path.join(destination, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (!(await exists(target))) {
    await fs.writeFile(target, content, { flag: "wx" });
  }
  if (!content.equals(await fs.readFile(target))) {
    throw new Error(`Verification failed: ${relative}`);
  }
}
const report = { destination, backup, sources, verifiedFiles: files.size };
await fs.writeFile(
  path.join(backup, "migration.json"),
  JSON.stringify(report, null, 2),
  { flag: "wx" },
);
console.log(JSON.stringify(report, null, 2));

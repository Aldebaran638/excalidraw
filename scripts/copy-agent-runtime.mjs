import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const copyNative = promisify(execFile);

/** Keep SDK assets and dynamic imports intact, copying only its installed closure. */
export async function copyAgentRuntime(outputDirectory) {
  const root = process.cwd();
  const output = path.resolve(outputDirectory);
  const visited = new Set();
  const resolvePackage = async (name, from) => {
    for (let folder = from; ; folder = path.dirname(folder)) {
      const candidate = path.join(folder, "node_modules", name);
      try {
        await fs.access(path.join(candidate, "package.json"));
        return candidate;
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      if (path.dirname(folder) === folder) {
        return null;
      }
    }
  };
  const copy = async (name, from, optional = false) => {
    const source = await resolvePackage(name, from);
    if (!source) {
      if (optional) {
        return;
      }
      throw new Error(`Missing agent runtime dependency: ${name}`);
    }
    if (visited.has(source)) {
      return;
    }
    visited.add(source);
    const relative = path.relative(root, source);
    const modules = relative.indexOf(`node_modules${path.sep}`);
    if (modules < 0) {
      throw new Error(`Unexpected runtime workspace: ${name}`);
    }
    const target = path.join(output, relative.slice(modules));
    if (process.platform === "win32") {
      await fs.cp(source, target, {
        recursive: true,
        filter: (file) =>
          !path.relative(source, file).split(path.sep).includes("node_modules"),
      });
    } else {
      await fs.mkdir(target, { recursive: true });
      const entries = (await fs.readdir(source)).filter(
        (name) => name !== "node_modules",
      );
      if (entries.length) {
        await copyNative("cp", [
          "-a",
          ...entries.map((name) => path.join(source, name)),
          target,
        ]);
      }
    }
    const manifest = JSON.parse(
      await fs.readFile(path.join(source, "package.json"), "utf8"),
    );
    for (const dependency of Object.keys(manifest.dependencies || {})) {
      await copy(
        dependency,
        source,
        Boolean(manifest.optionalDependencies?.[dependency]),
      );
    }
    for (const dependency of Object.keys(manifest.optionalDependencies || {})) {
      await copy(dependency, source, true);
    }
  };
  await fs.rm(path.join(output, "node_modules"), {
    recursive: true,
    force: true,
  });
  for (const name of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "typebox",
  ]) {
    await copy(name, path.join(root, "excalidraw-app"));
  }
}

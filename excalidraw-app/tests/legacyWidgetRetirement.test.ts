import fs from "node:fs/promises";
import path from "node:path";

import { expect, it } from "vitest";
import { newEmbeddableElement, newElement } from "@excalidraw/element";

import { retireLegacyWidgets } from "../data/retireLegacyWidgets";

it("uses native tombstones, retains ordinary elements, and doesn't alter the original", () => {
  const old = newEmbeddableElement({
    type: "embeddable",
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    strokeColor: "#000",
    backgroundColor: "transparent",
    customData: { aiWidget: { version: 1 } },
  });
  const ordinary = newElement({
    type: "rectangle",
    x: 250,
    y: 0,
    width: 100,
    height: 100,
    strokeColor: "#000",
    backgroundColor: "transparent",
  });
  const result = retireLegacyWidgets([old, ordinary]);
  expect(result.removed).toEqual([old.id]);
  expect(result.elements[0].isDeleted).toBe(true);
  expect(result.elements[0].version).toBeGreaterThan(old.version);
  expect(result.elements[1]).toEqual(ordinary);
  expect(old.isDeleted).toBe(false);
});

// Explicit one-time operator action only. Normal test runs never touch preview data.
it.runIf(process.env.RETIRE_PREVIEW_JSON_WIDGETS === "confirm")(
  "backs up the fixed preview dataset and retires old canvas widgets only",
  async () => {
    const directory = path.resolve(".local-data/preview/notes");
    const backup = path.resolve(
      ".local-data/backups/html-source-before-retirement",
    );
    await fs.access(backup).then(
      () => {
        throw new Error("Backup already exists; migration won't overwrite it");
      },
      () => {},
    );
    await fs.cp(directory, backup, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const report = [];
    for (const name of await fs.readdir(directory)) {
      if (!name.endsWith(".excalidraw") || name.startsWith("__")) {
        continue;
      }
      const file = path.join(directory, name);
      const note = JSON.parse(await fs.readFile(file, "utf8"));
      const result = retireLegacyWidgets(note.elements || []);
      if (!result.removed.length) {
        continue;
      }
      const next = { ...note, elements: result.elements };
      const temporary = `${file}.retirement.tmp`;
      expect(next.repositoryMetadata).toEqual(note.repositoryMetadata);
      const ordinary = (elements: any[]) =>
        elements
          .filter(
            (element) => !element.isDeleted && !element.customData?.aiWidget,
          )
          .map((element) => ({
            id: element.id,
            type: element.type,
            text: element.text,
            customData: element.customData,
          }));
      expect(ordinary(next.elements)).toEqual(ordinary(note.elements));
      await fs.writeFile(temporary, JSON.stringify(next, null, 2));
      await fs.rename(temporary, file);
      report.push({ name, removed: result.removed });
    }
    await fs.writeFile(
      path.join(backup, "retirement-report.json"),
      JSON.stringify(report, null, 2),
    );
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        backup,
        notes: report.length,
        removed: report.reduce((count, item) => count + item.removed.length, 0),
      }),
    );
  },
);

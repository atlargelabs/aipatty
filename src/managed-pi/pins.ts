import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { managedPi } from "./policy.ts";

const chunks = join(dirname(managedPi.bundleCli), "chunks");
export const settingsChunk = join(chunks, "chunk-KSDI5FD4.js");
export const modelsChunk = join(chunks, "chunk-P5VHIEWH.js");

function pinnedSource(path: string, digest: string): string {
  const source = readFileSync(path, "utf8");
  if (createHash("sha256").update(source).digest("hex") !== digest) {
    throw new Error(`Unexpected source at ${path}. Review the managed settings adapter before changing the dependency pin.`);
  }
  return source;
}

export const piSettingsSource = () => pinnedSource(settingsChunk, "5558c943edf1c00ca788788bc6b041d6a70a50ae7e646be2192ad399f1df7e34");
export const piModelsSource = () => pinnedSource(modelsChunk, "26d7d1663219cb5055cb04f70aad06bd876046ecc95a9bf7566d3c9b8e022c50");
export const delegatesSource = () => pinnedSource(managedPi.delegatesEntry, "c37181de0ba6b90566f0bb5b7f183d4945a026ba2c2f2fc2cf9d5391d41c4bbf");

/** The digests bind these edits to the reviewed pins. Never silently run an unadapted entry. */
export function replaceSection(source: string, start: string, end: string, replacement: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Managed settings adapter could not find ${start}`);
  return source.slice(0, from) + replacement + source.slice(to);
}

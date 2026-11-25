/**
 * Constants and checks that both the server and the page's modules use. The page loads this file as it is (see
 * `pageModules` in ../page.ts), so it may import types only. Server code reads these through ../protocol.ts.
 */
import type { EntryRecord, ModelRef } from "@earendil-works/pi-durable";

export const modelCommand = "/model";

export function isModelCommand(content: string): boolean {
  return content.trimStart().split(/\s/, 1)[0] === modelCommand;
}

export interface ModelSwitchAck {
  modelSwitch: "applied" | "queued";
  model: ModelRef;
}

export function modelSwitchText({ modelSwitch, model }: ModelSwitchAck): string {
  const name = `${model.provider}/${model.modelId}`;
  return modelSwitch === "queued" ? `Queued ${name}; it will apply when this branch goes idle.` : `Model set to ${name}.`;
}

/** The kind of a transcript entry about an upgrade: `data.text` is shown to people and is not model context. */
export const upgradeEntryKind = "aipatty.upgrade";

/** The text of an upgrade entry. */
export function upgradeText(entry: Pick<EntryRecord, "kind" | "data">): string | undefined {
  const { data } = entry;
  if (entry.kind !== upgradeEntryKind || !data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return typeof data.text === "string" ? data.text : undefined;
}

export const piRunApiPath = "/api/pi-runs/";
/** A timestamp to the second, then eight hex digits (see the generator in pi-run.ts). */
export const piRunId = /^\d{8}T\d{6}-[0-9a-f]{8}$/;

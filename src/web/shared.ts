/**
 * Constants and checks that both the server and the page's modules use. The page loads this file as it is (see
 * `pageModules` in ../page.ts), so it may import types only. Server code reads these through ../protocol.ts.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";

export const modelCommand = "/model";

export function isModelCommand(content: string): boolean {
  return content.trimStart().split(/\s/, 1)[0] === modelCommand;
}

/** The kind of a transcript entry about an upgrade: `data.text` is shown to people and is not model context. */
export const upgradeEntryKind = "aipatty.upgrade";
export const appEntryKind = "aipatty.app";

/** Operator notices are visible in the transcript, not in model context. */
export function operatorNotice(entry: Pick<EntryRecord, "kind" | "data">): { label: string; text: string } | undefined {
  const { kind, data } = entry;
  const label = kind === upgradeEntryKind ? "upgrade" : kind === appEntryKind ? "apps" : undefined;
  if (!label || !data || typeof data !== "object" || Array.isArray(data) || typeof data.text !== "string") return undefined;
  return { label, text: data.text };
}

export const piRunApiPath = "/api/pi-runs/";
/** A timestamp to the second, then eight hex digits (see the generator in pi-run.ts). */
export const piRunId = /^\d{8}T\d{6}-[0-9a-f]{8}$/;

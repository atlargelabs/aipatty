import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { defineDoc, type ModelRef } from "@earendil-works/pi-durable";

export const thinkingLevels: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** aipatty's own per-branch state. A fork's `init` writes its title and copies its parent's app list. */
export const BranchDoc = defineDoc<{ title: string; apps: string[] }>({
  kind: "aipatty.branch",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ title: "", apps: [] }),
  checkpointWhen: () => true,
});

/** The root's title when it has none of its own. */
export const ROOT_TITLE = "Main";
export const MAX_TITLE = 100;

/** A trimmed title of at most MAX_TITLE characters without control characters. */
export function validTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.trim().replace(/\s+/g, " ");
  // eslint-disable-next-line no-control-regex
  if (!title || title.length > MAX_TITLE || /[\u0000-\u001f\u007f]/.test(title)) return undefined;
  return title;
}

/** One branch as the list, the page and the model's tools show it. */
export interface BranchInfo {
  id: number;
  title: string;
  /** The branch it was forked from and the last entry it inherits; null for the root and branches started fresh. */
  parent: { id: number; at: number } | null;
  model: ModelRef | null;
  modelStatus: "available" | "unavailable";
  thinking: string;
  busy: boolean;
  /** The branch's own spend in dollars, without what it inherited from its parent. */
  cost: number;
}

/** One search hit: the entry, the role of the matching message and an excerpt around the match. */
export interface SearchMatch {
  entryId: number;
  role: string;
  excerpt: string;
}

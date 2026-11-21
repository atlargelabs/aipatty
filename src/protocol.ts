import type { JsonValue } from "@earendil-works/chord/json";
import { contentText, type Message } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, LiveState, ModelRef, UsageState } from "@earendil-works/pi-durable";

/** A transcript page, in chronological order, and its conversation's current metadata. */
export interface ConversationPage {
  id: number;
  model: ModelRef | null;
  busy: boolean;
  usage: UsageState & { cost: number };
  entries: readonly EntryRecord[];
  before: number | null;
}

/**
 * A stream snapshot, what changed since the previous frame, or the durable result requested by a send client.
 * A stream opens with `state`. An `update` replaces every field it carries and adds `appended` to the client's
 * entries; the client's own oldest entry still says where older pages start, so an update has no `before`.
 */
export type StreamFrame =
  | ({ type: "state"; live: LiveState } & ConversationPage)
  | ({ type: "update"; live: LiveState; appended: readonly EntryRecord[] } & Omit<ConversationPage, "entries" | "before">)
  | { type: "settled"; submissionId: number; status: "done"; answer: string }
  | { type: "settled"; submissionId: number; status: "unanswered"; reason: string; detail?: JsonValue };

/** The dollars spent in a usage ledger: every model and tool bucket. */
export function usageCost(usage: UsageState): number {
  return [...Object.values(usage.models), ...Object.values(usage.tools)]
    .reduce((total, bucket) => total + bucket.cost.total, 0);
}

/** A failed run's reason code and, when the harness recorded one, its cause. */
export function failureText(reason: string, detail?: JsonValue): string {
  if (detail === undefined || detail === null || detail === "") return reason;
  return `${reason}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
}

/** Project a Durable view into a bounded API snapshot. */
export function streamState(view: ConversationView): Extract<StreamFrame, { type: "state" }> {
  const live = (view.docs["pi.live"] ?? {}) as LiveState;
  const model = (view.docs["pi.agent"]?.model ?? null) as ModelRef | null;
  const usage = (view.docs["pi.usage"] ?? { models: {}, tools: {} }) as UsageState;
  const cost = usageCost(usage);
  return {
    type: "state",
    id: view.conversation.id,
    model,
    busy: live.run !== undefined,
    usage: { ...usage, cost },
    entries: view.entries,
    before: view.before === undefined ? null : view.entries[0].id,
    live,
  };
}

/**
 * The frame that takes a client from `previous` to `view`: only the changes when the transcript merely grew, else the
 * whole snapshot. Views are immutable revisions, so an entry is unchanged exactly when it is the same object.
 */
export function streamUpdate(previous: ConversationView, view: ConversationView): Exclude<StreamFrame, { type: "settled" }> {
  const state = streamState(view);
  const last = previous.entries.at(-1)?.id ?? 0;
  // The watch can fold more than a window of commits while the client is busy.
  if (view.before !== undefined && view.before > last) return state;
  const known = new Map(previous.entries.map(entry => [entry.id, entry]));
  const appended: EntryRecord[] = [];
  for (const entry of view.entries) {
    if (entry.id > last) appended.push(entry);
    else if (known.get(entry.id) !== entry) return state;
  }
  const { entries: _entries, before: _before, ...rest } = state;
  return { ...rest, type: "update", appended };
}

/** Fold an `update` into the `state` a client holds. */
export function applyUpdate(
  state: Extract<StreamFrame, { type: "state" }>, update: Extract<StreamFrame, { type: "update" }>,
): Extract<StreamFrame, { type: "state" }> {
  const { appended, ...rest } = update;
  return { ...state, ...rest, type: "state", entries: [...state.entries, ...appended] };
}

/** Extract visible text without printing reasoning, tool calls, or images. */
export function messageText(message: Pick<Message, "content">): string {
  return contentText(message.content, "");
}

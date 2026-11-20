import type { Message } from "@earendil-works/pi-ai";
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

/** A stream snapshot, or the durable result requested by a send client. */
export type StreamFrame =
  | ({ type: "state"; live: LiveState } & ConversationPage)
  | { type: "settled"; submissionId: number; status: "done"; answer: string }
  | { type: "settled"; submissionId: number; status: "unanswered"; reason: string };

/** Project a Durable view into a bounded API snapshot. */
export function streamState(view: ConversationView): Extract<StreamFrame, { type: "state" }> {
  const live = (view.docs["pi.live"] ?? {}) as LiveState;
  const model = (view.docs["pi.agent"]?.model ?? null) as ModelRef | null;
  const usage = (view.docs["pi.usage"] ?? { models: {}, tools: {} }) as UsageState;
  const cost = [...Object.values(usage.models), ...Object.values(usage.tools)]
    .reduce((total, bucket) => total + bucket.cost.total, 0);
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

/** Extract visible text without printing reasoning, tool calls, or images. */
export function messageText(message: Pick<Message, "content">): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(part => part.type === "text" ? part.text : "").join("");
}

/**
 * The card pipeline: how the page turns a branch's data into the cards of its transcript and what surrounds them.
 * docs/WEB-CARDS.md explains the design and how to add a step; this file is the reference for the types.
 *
 *   agent data --initial()--> precards X0, surround Y0 --step 1--> X1, Y1 --step 2--> ... --> cards on screen
 *
 * Everything here is a pure function of its arguments and uses no DOM, so the same input always gives the same
 * cards. The page runs the whole pipeline again whenever its data changes, and keeps a card on screen whose
 * precard came out the same. The page loads this file as it is, so it may import types only, or ./shared.ts.
 */
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState, RunFailure, ToolSlot } from "@earendil-works/pi-durable";
import { operatorNotice } from "./shared.ts";

/** What the pipeline reads: the selected branch's loaded entries, oldest first, and its live state. */
export interface AgentData {
  /** The selected branch's conversation ID. An entry of another conversation was inherited from a parent branch. */
  readonly branch: number;
  readonly entries: readonly EntryRecord[];
  readonly live: LiveState;
}

/**
 * Names a pane to show beside the transcript. `type` selects the pane and the other fields are its arguments.
 * It is plain JSON: the page compares two references as JSON to decide whether the pane changed. The one pane
 * today is `{ type: "pi-run", ... }` (see ./steps.ts).
 */
export interface PaneRef {
  readonly type: string;
  readonly [argument: string]: unknown;
}

/**
 * What a button does when pressed. This is the complete set: a step chooses one, the page carries it out against
 * the selected branch.
 */
export type Action =
  /** Send `content` to the branch as a message, queued as a follow-up if the branch is busy. */
  | { readonly type: "send"; readonly content: string }
  /** Stop the branch's current run. */
  | { readonly type: "abort" }
  /** Ask for a title, then fork the branch with its history through entry `at`. */
  | { readonly type: "fork"; readonly at: number }
  /** Show `pane`, replacing any pane that is open. */
  | { readonly type: "openPane"; readonly pane: PaneRef };

export interface Button {
  readonly label: string;
  readonly action: Action;
}

/**
 * A link. `href` is an absolute `http(s)` URL, which opens in a new tab, or a path on this server starting with
 * one `/`. Any other `href` is shown as plain text.
 */
export interface Link {
  readonly label: string;
  readonly href: string;
}

/** The fields of a precard that a step can change. Nothing else about a card is under a step's control. */
export interface Display {
  /** A hidden card stays in the list, so keys, fork points and the cards around it are unaffected. */
  readonly hidden: boolean;
  /** A CSS class added to the card; `""` for none. */
  readonly style: string;
  /** Which renderer shows `text` in the card's body. Built-in formats are `"text"` and `"markdown"`. */
  readonly format: string;
  readonly buttons: readonly Button[];
  readonly links: readonly Link[];
}

/** What every precard has, set by `initial` and never changed by a step. */
interface Content extends Display {
  /** The branch showing this card (not necessarily the one that wrote its entry). */
  readonly branch: number;
  /** Identifies the card across runs of the pipeline: a card on screen is kept while its key is still produced. */
  readonly key: string;
  /** The small heading of the card, such as `User · 12`; `""` for none. */
  readonly label: string;
  /** The body, shown by the renderer that `format` names. */
  readonly text: string;
}

/** What a precard made from a saved entry has. */
interface Settled extends Content {
  readonly entry: EntryRecord;
  /** The entry belongs to a parent branch. */
  readonly inherited: boolean;
}

type MessageOf<Role extends Message["role"]> = Extract<Message, { role: Role }>;

/**
 * One card before it is drawn: the part of the agent data it came from, its content, and its `Display` fields.
 * `kind` says which part of the data it holds. A precard with an `entry` is settled: it came from the saved
 * transcript, depends on nothing else, and so never changes. The others are live: they come from the live state,
 * are always last in the list, and come and go as it changes.
 */
export type Precard =
  /** The text of a user or system message, or a run of text in an assistant message. */
  | Settled & { readonly kind: "prose"; readonly message: MessageOf<"user" | "assistant" | "system"> }
  /** One tool call of an assistant message. */
  | Settled & { readonly kind: "toolCall"; readonly message: MessageOf<"assistant">; readonly call: ToolCall }
  /**
   * A tool's result. `call` is the newest earlier call with the result's ID among the loaded entries. It is absent
   * when that call is on an older page that is not loaded, or when one message used the ID for two calls.
   */
  | Settled & { readonly kind: "toolResult"; readonly message: MessageOf<"toolResult">; readonly call?: ToolCall }
  /** An entry that is for people and not for the model, such as the report of an upgrade. */
  | Settled & { readonly kind: "notice" }
  /** The answer the model is writing now. */
  | Content & { readonly kind: "liveText"; readonly message: NonNullable<NonNullable<LiveState["generation"]>["message"]> }
  /** A tool call of the current round that has not finished. `call` is found as for a result. */
  | Content & { readonly kind: "liveTool"; readonly slot: ToolSlot; readonly call?: ToolCall }
  /** Why the newest run ended without an answer. */
  | Content & { readonly kind: "runFailure"; readonly failure: RunFailure };

/** A heading item above the transcript: a `Link`, or plain text when it has no `href`. */
export interface HeaderItem {
  readonly label: string;
  readonly href?: string;
}

/** What is drawn around the cards. */
export interface Surround {
  readonly branch: number;
  /** Items shown in a strip above the transcript, in order. The strip is hidden while there are none. */
  readonly header: readonly HeaderItem[];
  /** A CSS class set on the page's `<body>`; `""` for none. */
  readonly style: string;
  /** The pane the reader has open; none when absent. */
  readonly pane?: PaneRef;
}

/**
 * What a step changes on one precard. A field left out is left as it was. `hidden`, `style` and `format` replace
 * the value an earlier step set, so the last step to set one wins. `buttons` and `links` are added after the ones
 * already there, so a step cannot remove what an earlier step added.
 */
export type CardChange = Partial<Display>;

/**
 * What a step changes around the cards: `header` items are added after the ones already there, and `style`
 * replaces. A step cannot set the pane: a pane opens when the reader presses a button with an `openPane` action,
 * and closes when they close it.
 */
export type SurroundChange = Partial<Omit<Surround, "pane" | "branch">>;

/**
 * One transformation of the pipeline. Both functions must be pure: they return a change computed from their
 * arguments alone, and neither modify them nor read anything else, such as the clock or the page.
 */
export interface Step {
  /** Names the step in the error shown when it throws. */
  readonly name: string;
  /**
   * The change to one precard, or nothing to leave it alone. It sees that precard only: not its neighbours, not
   * the surround, and the live state only through a live precard. That is what keeps a settled card from changing.
   */
  card?(precard: Precard): CardChange | undefined;
  /**
   * The change to the surround, or nothing. `precards` are the ones the previous step produced. Unlike a card,
   * the surround may depend on every card and on the live state.
   */
  surround?(surround: Surround, precards: readonly Precard[], live: LiveState): SurroundChange | undefined;
}

export interface Derived {
  readonly precards: readonly Precard[];
  readonly surround: Surround;
}

function plainText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map(block => block.type === "text" ? block.text : block.type === "image" ? "[image]" : "")
    .filter(Boolean).join("\n");
}

function callText(call: Pick<ToolCall, "name" | "arguments">): string {
  return "→ " + call.name + " " + JSON.stringify(call.arguments);
}

/**
 * Step zero: the precards and surround that the data alone gives, before any step. It does all the splitting and
 * joining, so that every later step works on one precard at a time:
 *
 * - an entry becomes a card per message, and an assistant message a card per run of text and per tool call, in
 *   the order they were written. Thinking is left out, as is a user or system message with no text;
 * - a tool result is given the call it answers, when that call is loaded;
 * - the live state adds, after the last entry: the answer being written, each unfinished tool call of the current
 *   round, and the failure of the newest run. A finished call has no live card: its result is in the transcript.
 *
 * Every settled card starts with a "Fork here" button. `pane` is the pane the reader has open, if any.
 */
export function initial(data: AgentData, pane?: PaneRef): Derived {
  const precards: Precard[] = [];
  const display = { branch: data.branch, hidden: false, style: "", format: "text", buttons: [], links: [] } as const;
  // The newest call of each ID so far. Null when one message used the ID twice: a result cannot tell which it answers.
  const calls = new Map<string, ToolCall | null>();

  for (const entry of data.entries) {
    const heading = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1)} · ${entry.id}`;
    const settled = {
      ...display, entry, inherited: entry.conversationId !== data.branch,
      buttons: [{ label: "Fork here", action: { type: "fork", at: entry.id } }],
    } as const;
    const notice = operatorNotice(entry);
    if (notice) {
      precards.push({ ...settled, kind: "notice", key: `${entry.id}:notice`, label: heading(notice.label), text: notice.text });
    }
    (entry.model ?? []).forEach((message, index) => {
      const key = `${entry.id}:${index}`;
      if (message.role === "toolResult") {
        const call = calls.get(message.toolCallId) ?? undefined;
        const label = heading(message.isError ? "Tool error" : "Tool result");
        precards.push({ ...settled, kind: "toolResult", key, label, text: plainText(message.content), message, call });
        return;
      }
      const label = heading(message.role);
      if (message.role !== "assistant") {
        const text = plainText(message.content);
        if (text) precards.push({ ...settled, kind: "prose", key, label, text, message });
        return;
      }
      const ids = new Set<string>();
      let lines: string[] = [];
      let first = 0;
      const prose = () => {
        if (lines.length) precards.push({ ...settled, kind: "prose", key: `${key}:${first}`, label, text: lines.join("\n"), message });
        lines = [];
      };
      message.content.forEach((block, at) => {
        if (block.type === "text" && block.text) {
          if (!lines.length) first = at;
          lines.push(block.text);
        } else if (block.type === "toolCall") {
          prose();
          calls.set(block.id, ids.has(block.id) ? null : block);
          ids.add(block.id);
          precards.push({ ...settled, kind: "toolCall", key: `${key}:${at}`, label: heading("Tool call"), text: callText(block), message, call: block });
        }
      });
      prose();
    });
  }

  const { generation, tools, runFailure } = data.live;
  if (generation?.message) {
    // A call the model has not finished writing is still text here: it is a call once its message is saved.
    const text = generation.message.content
      .map(block => block.type === "text" ? block.text : block.type === "toolCall" ? callText(block) : "")
      .filter(Boolean).join("\n");
    if (text) precards.push({ ...display, kind: "liveText", key: "live:text", label: "Assistant · writing", text, message: generation.message });
  }
  (tools ?? []).forEach((slot, index) => {
    if (slot.status === "done") return;
    precards.push({
      ...display, kind: "liveTool", key: `live:tool:${index}`, label: `Tool · ${slot.status}`, text: "→ " + slot.name,
      slot, call: calls.get(slot.callId) ?? undefined,
    });
  });
  if (runFailure) {
    const text = "Run failed: " + runFailure.reason + (runFailure.detail ? ": " + runFailure.detail : "");
    precards.push({ ...display, kind: "runFailure", key: "live:failure", label: "", text, failure: runFailure });
  }
  return { precards, surround: { branch: data.branch, header: [], style: "", pane } };
}

function changeCard(precard: Precard, change: CardChange | undefined): Precard {
  if (!change) return precard;
  return {
    ...precard,
    hidden: change.hidden ?? precard.hidden,
    style: change.style ?? precard.style,
    format: change.format ?? precard.format,
    buttons: change.buttons?.length ? [...precard.buttons, ...change.buttons] : precard.buttons,
    links: change.links?.length ? [...precard.links, ...change.links] : precard.links,
  };
}

function changeSurround(surround: Surround, change: SurroundChange | undefined): Surround {
  if (!change) return surround;
  return {
    header: change.header?.length ? [...surround.header, ...change.header] : surround.header,
    style: change.style ?? surround.style,
    pane: surround.pane,
    branch: surround.branch,
  };
}

/** Scope a reviewed app's steps to its own tool cards and additive header items. Not a sandbox. */
export function scopeAppStep(id: string, step: Step): Step {
  const prefix = id + "_";
  const own = (card: Precard) => {
    const name = card.kind === "toolCall" ? card.call.name : card.kind === "toolResult" ? card.message.toolName
      : card.kind === "liveTool" ? card.slot.name : undefined;
    return name?.startsWith(prefix);
  };
  return {
    name: `${id}/${step.name}`,
    card: step.card && (card => own(card) ? step.card!(card) : undefined),
    surround: step.surround && ((surround, precards) => {
      // The header can use this branch and the app's cards, not the raw live state or another app's cards.
      const change = step.surround!(surround, precards.filter(own), {});
      return change && { header: change.header };
    }),
  };
}

/**
 * Run the pipeline: `initial`, then each of `steps` in order. A step first changes the surround, reading the
 * precards it was given, and then changes each of those precards.
 *
 * A step that throws is skipped where it threw, for that one precard or for the surround, and `report` is told.
 * The card is then drawn as the steps before it left it.
 */
export function derive(
  data: AgentData, steps: readonly Step[],
  { pane, report }: { pane?: PaneRef; report?: (step: string, error: unknown) => void } = {},
): Derived {
  let { precards, surround } = initial(data, pane);
  for (const step of steps) {
    if (step.surround) {
      try { surround = changeSurround(surround, step.surround(surround, precards, data.live)); }
      catch (error) { report?.(step.name, error); }
    }
    if (step.card) {
      precards = precards.map(precard => {
        try { return changeCard(precard, step.card!(precard)); }
        catch (error) { report?.(step.name, error); return precard; }
      });
    }
  }
  return { precards, surround };
}

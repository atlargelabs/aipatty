import { awaitWithContext, type Context } from "@earendil-works/chord/context";
import {
  defineExtension, defineTool, ROOT_CONVERSATION_ID,
  type Conversation, type Cursor, type EntryId, type EntryRecord, type Page,
} from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { thinkingLevels, type BranchInfo } from "./branches.ts";
import type { AgentHost } from "./host.ts";
import { messageText } from "./protocol.ts";
import { transcriptPage } from "./transcript.ts";



const maxReadEntries = 50;
const maxEntryText = 4_000;

function text(value: string) {
  return { output: [{ type: "text" as const, text: value }] };
}

function money(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

/** One line per branch, as the model and the CLI show the list. */
export function branchLine(branch: BranchInfo): string {
  const model = branch.model ? `${branch.model.provider}/${branch.model.modelId}` : "(no model)";
  const from = branch.parent ? `, forked from ${branch.parent.id} at entry ${branch.parent.at}` : "";
  const flags = [branch.busy ? "busy" : "", branch.modelStatus === "unavailable" ? "model unavailable" : ""].filter(Boolean);
  return `${branch.id}: ${branch.title} (${model}, ${money(branch.cost)}${from}${flags.length ? `, ${flags.join(", ")}` : ""})`;
}

/**
 * Wait for a host call that queues on the admission line. An abort holds that line while it waits for this very tool
 * call to end, and cancels `context`: that ends the wait here, and the host, given the same context, then drops the
 * queued call instead of running it after the abort.
 */
function queued<T>(call: Promise<T>, context: Context): Promise<T> {
  // awaitWithContext() does not observe the call when the context is already cancelled; its rejection is expected.
  call.catch(() => {});
  return awaitWithContext(call, context);
}

/** The ID of the entry holding the assistant message that made tool call `callId`, searched newest first. */
async function callEntry(conversation: Conversation, callId: string, context: Context): Promise<EntryId | undefined> {
  let cursor: Cursor | undefined;
  do {
    const page: Page<EntryRecord, Cursor> = await conversation.entries({}, maxReadEntries, cursor, context);
    const found = page.items.find(entry => entry.model?.some(message => message.role === "assistant"
      && message.content.some(content => content.type === "toolCall" && content.id === callId)));
    if (found) return found.id;
    cursor = page.next;
  } while (cursor);
  return undefined;
}

/** The tree tools. They take the host lazily: the Harness that runs them must be open before the host exists. */
export function treeExtension(getHost: () => AgentHost) {
  const target = async (id: number | undefined, own: number, context: Context): Promise<Conversation> => {
    const found = await awaitWithContext(getHost().conversation(String(id ?? own)), context);
    if (!found) throw new Error(`No branch ${id}. Call list_branches for the IDs.`);
    return found;
  };

  const listBranches = defineTool({
    name: "list_branches",
    description: "List every conversation branch: ID, title, model, own cost, where it was forked from, and whether it is busy.",
    parameters: obj({}),
    replay: "safe",
    async execute(_args, api, context) {
      const { branches, totalCost } = await awaitWithContext(getHost().branches(), context);
      const lines = branches.map(branch => `${branchLine(branch)}${branch.id === api.conversationId ? "  ← this branch" : ""}`);
      return text(`${lines.join("\n")}\nTotal spend: ${money(totalCost)}`);
    },
  });

  const readBranch = defineTool({
    name: "read_branch",
    description: "Read a branch's transcript, newest entries last, or search it for text (case-insensitive). "
      + "Page backwards with `before`, the entry ID a previous result says to continue from.",
    parameters: obj({
      branch: opt(int({ minimum: 1, description: "Branch ID; default this branch" })),
      query: opt(str({ minLength: 1, maxLength: 200, description: "Text to search for instead of reading in order" })),
      before: opt(int({ minimum: 1, description: "Only entries with a lower ID" })),
      limit: opt(int({ minimum: 1, maximum: maxReadEntries, description: `Entries or matches to return, default 20, at most ${maxReadEntries}` })),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const host = getHost();
      const conversation = await target(args.branch, api.conversationId, context);
      const limit = args.limit ?? 20;
      if (args.query !== undefined) {
        const { matches, before } = await awaitWithContext(host.search(conversation, args.query, { limit, before: args.before }), context);
        if (!matches.length) return text(`No matches for "${args.query}" in branch ${conversation.id}.`);
        const lines = matches.map(match => `[${match.entryId}] ${match.role}: ${match.excerpt}`);
        if (before !== null) lines.push(`More matches may be older: continue with before=${before}.`);
        return text(lines.join("\n"));
      }
      const { entries, before } = await transcriptPage(conversation, context, limit, args.before);
      const lines: string[] = [];
      if (before !== null) lines.push(`Older entries exist: continue with before=${before}.`);
      for (const entry of entries) {
        for (const message of entry.model ?? []) {
          let body = messageText(message);
          if (!body) continue;
          if (body.length > maxEntryText) body = `${body.slice(0, maxEntryText)}… (${body.length - maxEntryText} more characters)`;
          lines.push(`[${entry.id}] ${message.role}: ${body}`);
        }
      }
      return text(lines.length ? lines.join("\n") : `Branch ${conversation.id} has no messages${args.before ? " before that entry" : ""}.`);
    },
  });

  const forkBranch = defineTool({
    name: "fork_branch",
    description: "Start a new branch, an independent workstream that shares this branch's history up to this call. "
      + "It gets this branch's model. Optionally send it a first message, which it starts working on at once. "
      + "Nothing reports back here: read it later with read_branch.",
    parameters: obj({
      title: str({ minLength: 1, maxLength: 100, description: "A short title for the branch list" }),
      message: opt(str({ minLength: 1, description: "First message for the new branch" })),
      from: opt(int({ minimum: 1, description: "Branch to fork; default this branch" })),
      at: opt(int({ minimum: 1, description: "Last entry the fork inherits; default all of them" })),
    }),
    async execute(args, api, context) {
      const host = getHost();
      const from = await target(args.from, api.conversationId, context);
      // This call has no result yet. A fork that inherited the message making it would show the new branch a call
      // that never completed, which reads as a failed fork: by default this branch is forked just before that message.
      const before = args.at === undefined && from.id === api.conversationId
        ? await callEntry(from, api.callId, context) : undefined;
      if (args.at === undefined && from.id === api.conversationId && before === undefined) {
        throw new Error("Cannot find this tool call's entry; refusing an unsafe self-fork.");
      }
      const created = await host.fork(from, { title: args.title, at: args.at, before }, context);
      const summary = `Created branch ${created.id}, "${created.title}".`;
      if (args.message === undefined) return text(summary);
      try {
        const conversation = (await host.conversation(String(created.id)))!;
        await queued(host.submit(conversation, { type: "input", content: args.message }, context), context);
      } catch (error) {
        context.abortSignal?.throwIfAborted();
        throw new Error(`${summary} First message admission failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      return text(`${summary} It is working on the message.`);
    },
  });

  const setModel = defineTool({
    name: "set_model",
    description: "Set the model of a branch, from the IDs `aipatty models` lists. On this branch it applies from the next model request; "
      + "on another branch it applies when that branch is idle. Only include thinking if the target is idle or this branch.",
    parameters: obj({
      modelId: str({ minLength: 1 }),
      provider: opt(str({ minLength: 1, description: "Needed only when two providers have the model ID" })),
      branch: opt(int({ minimum: 1, description: "Branch ID; default this branch" })),
      thinking: opt(str({ description: "Thinking level: off, minimal, low, medium, high, xhigh or max" })),
    }),
    async execute(args, api, context) {
      const host = getHost();
      const conversation = await target(args.branch, api.conversationId, context);
      const matches = host.models().filter(model => model.modelId === args.modelId
        && (args.provider === undefined || model.provider === args.provider));
      if (!matches.length) throw new Error(`Unknown model ${args.modelId}`);
      if (matches.length > 1) throw new Error(`Ambiguous model ${args.modelId}; give the provider: ${matches.map(m => m.provider).join(", ")}`);
      const thinkingLevel = args.thinking === undefined ? undefined : thinkingLevels.find(level => level === args.thinking);
      if (args.thinking !== undefined && !thinkingLevel) throw new Error(`Expected a thinking level: ${thinkingLevels.join(", ")}`);
      const model = { provider: matches[0].provider, modelId: matches[0].modelId };
      const name = conversation.id === ROOT_CONVERSATION_ID ? "the main branch" : `branch ${conversation.id}`;
      const selection = `${model.provider}/${model.modelId}${thinkingLevel ? ` with thinking ${thinkingLevel}` : ""}`;
      if (conversation.id === api.conversationId) {
        // Avoid this branch's admission line: an abort can hold it while waiting for this call.
        await conversation.configure({ model, ...(thinkingLevel ? { thinkingLevel } : {}) }, context);
      } else if (await queued(host.setModel({ ...model, thinkingLevel }, conversation, context), context) === "queued") {
        return text(`Queued ${selection} for ${name}; it will apply when that branch goes idle.`);
      }
      return text(`Set ${name} to ${selection}.`);
    },
  });

  return defineExtension({ name: "aipatty-tree", tools: [listBranches, readBranch, forkBranch, setModel] });
}

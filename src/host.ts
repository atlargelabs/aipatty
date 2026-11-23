import { BACKGROUND_CONTEXT as ctx, type Context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createRegistry, Harness, LiveDoc, ROOT_CONVERSATION_ID, UsageDoc,
  type Conversation, type ConversationId, type EntryId, type InputSubmissionDraft, type ModelRef, type Submission,
  type ConversationRecord, type Cursor, type EntryRecord, type Page, type Tx, type UsageState,
} from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BranchDoc, ROOT_TITLE, thinkingLevels, validTitle, type BranchInfo, type SearchMatch } from "./branches.ts";
import type { Config } from "./config.ts";
import { ownDataDir } from "./ownership.ts";
import { openModels } from "./models.ts";
import { openPiRuns, type PiRuns } from "./pi-run.ts";
import { piExtension } from "./pi-tool.ts";
import { failureText, messageText, usageCost } from "./protocol.ts";
import { treeExtension } from "./tools.ts";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** What a new root conversation starts with. Afterwards `model set` and `thinking set` change the saved values. */
const newRoot = { model: { provider: "openai", modelId: "gpt-6.2-sol" }, thinkingLevel: "high" } as const;
const fauxModel = { provider: "faux", modelId: "faux-1" };
const searchScanPage = 200;

export interface ModelStatus {
  modelStatus: "available" | "unavailable";
  model: ModelRef | null;
  thinking: ModelThinkingLevel;
}

export interface AgentHost {
  harness: Harness;
  /** The `pi` run slot. */
  runs: PiRuns;
  /** Stop the active `pi` run, leaving its result to the next start, then close the harness. */
  close(): Promise<void>;
  /** `root` or a branch's numeric ID; task-owned conversations are not branches. */
  conversation(id: string): Promise<Conversation | undefined>;
  /** A branch's saved model and thinking level, and whether the local catalog has that model; the root by default. */
  modelStatus(conversation?: Conversation): Promise<ModelStatus>;
  models(): { provider: string; modelId: string; name: string }[];
  /**
   * `setModel`, `setThinking` and `submit` wait their turn on one admission line, behind any abort. Given the caller's
   * `context`, a call whose context was cancelled while it waited rejects when its turn comes and changes nothing.
   */
  setModel(model: ModelRef & { thinkingLevel?: ModelThinkingLevel }, conversation?: Conversation, context?: Context): Promise<void>;
  setThinking(level: string, conversation?: Conversation, context?: Context): Promise<void>;
  /** Every branch, oldest first, and the spend of the whole session. */
  branches(): Promise<{ branches: BranchInfo[]; totalCost: number }>;
  branch(conversation: Conversation): Promise<BranchInfo>;
  /**
   * Start a branch from `from`'s history through entry `at`, with `from`'s current model and thinking level. Without
   * `at`, the history through its newest entry, or through the newest one below `before`. No such entry starts an
   * empty branch.
   */
  fork(from: Conversation, options: { title: string; at?: number; before?: number }, context?: Context): Promise<BranchInfo>;
  rename(conversation: Conversation, title: string): Promise<void>;
  /** Newest matches first; `before` continues below an entry ID, and the result's `before` is where the next page starts. */
  search(conversation: Conversation, query: string, options?: { limit?: number; before?: number }):
    Promise<{ matches: SearchMatch[]; before: number | null }>;
  totalCost(): Promise<number>;
  submit(conversation: Conversation, draft: InputSubmissionDraft, context?: Context): Promise<Submission>;
  /** Withdraw queued inputs and abort the running turn; resolves once the conversation is idle. */
  abort(conversation: Conversation): Promise<void>;
  /** Throw 409 unless scheduling runs: a wait or an abort would resume work blocked on an unavailable model. */
  assertRunning(): Promise<void>;
  /** Throw 409 unless scheduling runs and the branch's saved model is available. */
  assertAvailable(conversation?: Conversation): Promise<void>;
  /** Requires no live tasks or pending submissions; blocks all mutations and Pi admission until released. */
  reserveUpgrade(conversation: Conversation): Promise<() => void>;
  /** Open scheduling only after the startup guard has committed the chosen release. */
  activate(): void;
}

/** Open paused, so an unavailable saved model never executes interrupted work. */
export async function openHost(config: Config, options: {
  paused?: boolean; validation?: boolean; beforeOpen?: () => void | Promise<void>;
} = {}): Promise<AgentHost> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const release = ownDataDir(config.dataDir);
  try {
    await options.beforeOpen?.();
    const agent = await openOwnedHost(config, options.paused === true || options.validation === true, options.validation === true);
    void agent.harness.closed.then(release);
    return agent;
  } catch (error) {
    release();
    throw error;
  }
}

function branchRef(id: number): string {
  return id === ROOT_CONVERSATION_ID ? "" : ` --branch ${id}`;
}

/** Select an immutable fork point and check that its last assistant tool exchange has every result. */
async function forkPoint(from: Conversation, at: number | undefined, before: number | undefined, context: Context): Promise<EntryId | undefined> {
  const last = at ?? (before === undefined ? undefined : before - 1);
  const query = last === undefined ? {} : { maxEntryId: last as EntryId };
  const results = new Set<string>();
  let cursor: Cursor | undefined;
  let point: EntryId | undefined;
  do {
    context.abortSignal?.throwIfAborted();
    const page: Page<EntryRecord, Cursor> = await from.entries(query, 50, cursor, context);
    if (cursor === undefined) {
      point = page.items[0]?.id;
      if (at !== undefined && point !== at) throw new HttpError(400, `Entry ${at} is not in branch ${from.id}`);
      if (point === undefined) return undefined;
    }
    let groups = page.items.map(entry => entry.model ?? []);
    cursor = page.next;
    if (page.items.some(entry => entry.head !== undefined || entry.edits?.length)) {
      // A reset, compaction or edit changes which messages contribute. Ask Durable for the active history *before*
      // it synthesizes missing tool results. Ordinary histories only scan back to the most recent assistant.
      groups = (await from.context(context, { at: point })).contributions.toReversed();
      results.clear();
      cursor = undefined;
    }
    for (const group of groups) {
      for (let i = group.length - 1; i >= 0; i--) {
        const message = group[i];
        if (message.role === "toolResult") results.add(message.toolCallId);
        if (message.role !== "assistant" || ["aborted", "deferred", "error"].includes(message.stopReason)) continue;
        if (message.content.some(part => part.type === "toolCall" && !results.has(part.id))) {
          throw new HttpError(400, `Cannot fork at entry ${point}: tool exchange is incomplete; choose an earlier entry or wait for all tool results.`);
        }
        return point;
      }
    }
  } while (cursor);
  return point;
}

async function openOwnedHost(config: Config, paused: boolean, validation: boolean): Promise<AgentHost> {
  const models = await openModels(config);
  // A gated candidate cannot repair or clear Pi state. Normal startup recovers it before resuming work.
  const runs = await openPiRuns(config, { recover: !validation });
  await mkdir(config.workDir, { recursive: true, mode: 0o700 });
  const database = await openNodeSqliteDatabase(join(config.dataDir, "aipatty.sqlite"));
  const storage = await (async () => {
    try {
      // The adapter defaults to WAL/NORMAL. Managed installs also acknowledge writes in an fsynced
      // journal outside SQLite; those acknowledgements must not outlive the Durable transactions.
      if (config.installDir && config.port !== 0) await database.exec("PRAGMA synchronous = FULL");
      return await SqliteStorage.open(database);
    } catch (error) {
      await database.close().catch(() => {});
      throw error;
    }
  })();
  const registry = createRegistry();
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
  // The model's own tools work in `work/`, for inspection and scratch files. Work meant for a PR goes through `pi`.
  registry.install(createCodingTools());
  registry.install(createCodemodeExtension({ sandbox }));
  registry.install(createToolSearchExtension());
  registry.install(piExtension(() => runs));
  // The tools need the host, which needs the open Harness: they reach it through this binding.
  let host: AgentHost | undefined;
  registry.install(treeExtension(() => {
    if (!host) throw new Error("aipatty is still starting");
    return host;
  }));
  const harness = await Harness.open(storage, {
    models,
    registry,
    env: () => new NodeExecutionEnv({ cwd: config.workDir }),
    settings: { afterFailedRun: "withdraw" },
    onReport: report => console.error("pi-durable:", report),
  }, ctx).catch(async error => {
    await storage.close(ctx).catch(() => {});
    await sandbox.close();
    throw error;
  });
  try {
    const root = await harness.root(ctx, { agent: config.faux ? { ...newRoot, model: fauxModel } : newRoot });
    const available = (model: ModelRef | null | undefined) => !!model && !!models.getModel(model.provider, model.modelId);
    const status = async (conversation: Conversation = root, context = ctx): Promise<ModelStatus> => {
      const agent = await conversation.agent(context);
      const saved = agent.model ?? null;
      return { modelStatus: available(saved) ? "available" : "unavailable", model: saved, thinking: agent.thinkingLevel };
    };
    const modelName = (model: ModelRef | null) => model ? `${model.provider}/${model.modelId}` : "(none)";

    // Branches whose interrupted work waits for a model the catalog lacks. While any does, scheduling stays paused,
    // so that work is neither run nor failed; switching that branch's model withdraws it.
    const blocked = new Set<ConversationId>();
    {
      const inspection = await harness.inspect(ctx);
      const busy = new Set<ConversationId>([
        ...inspection.tasks.map(task => task.record.conversationId),
        ...inspection.submissions.map(submission => submission.conversationId),
      ]);
      for (const id of busy) {
        const conversation = await harness.conversation(id, ctx);
        if (conversation && (await status(conversation)).modelStatus === "unavailable") blocked.add(id);
      }
    }
    let serving = !paused;
    let upgrading = false;
    if (serving && !blocked.size) harness.resume();
    const admit = () => {
      if (!serving || upgrading) throw new HttpError(409, "An upgrade is pending; new work is not admitted");
    };
    // Branches recovered while others were still blocked: their aborted work settles once scheduling resumes.
    const recovered: Conversation[] = [];

    // Serialize admission, aborts and model changes: no input may slip between the busy check and configure(),
    // or be admitted while aborted work is still settling, where it would never start. A call made by a turn that was
    // aborted while the call waited here is dropped: its `context` is cancelled by the time the abort lets it through.
    let tail = Promise.resolve();
    function exclusive<T>(fn: () => Promise<T>, context?: Context): Promise<T> {
      const result = tail.then(() => {
        context?.abortSignal?.throwIfAborted();
        return fn();
      });
      tail = result.then(() => {}, () => {});
      return result;
    }
    const unavailableError = async (id: ConversationId) => {
      const conversation = await harness.conversation(id, ctx);
      const { model } = conversation ? await status(conversation) : { model: null };
      const where = id === ROOT_CONVERSATION_ID ? "" : ` of branch ${id}`;
      return new HttpError(409, `Model ${modelName(model)}${where} is unavailable. Run 'aipatty models' then 'aipatty model set${branchRef(id)} <modelId>'.`);
    };
    const assertRunning = async (target?: ConversationId) => {
      if (!blocked.size) return;
      const first = target !== undefined && blocked.has(target) ? target : [...blocked][0];
      const error = await unavailableError(first);
      if (first !== target) {
        error.message = `Branch ${first} has interrupted work waiting for an unavailable model, so nothing runs until it is resolved. ${error.message}`;
      }
      throw error;
    };
    const assertAvailable = async (conversation: Conversation = root) => {
      await assertRunning(conversation.id);
      if ((await status(conversation)).modelStatus === "unavailable") throw await unavailableError(conversation.id);
    };
    // Log a failed run once, whether or not a client is streaming it and however often the client retries the
    // request. A closing harness rejects the wait.
    const logged = new Set<number>();
    const logFailure = (submission: Submission) => {
      void submission.wait(ctx).then(result => {
        if (result.status !== "unanswered" || result.reason === "aborted" || logged.has(result.id)) return;
        logged.add(result.id);
        console.error(`Run failed (submission ${result.id}): ${failureText(result.reason, result.detail)}`);
      }, () => {});
    };
    const conversation = async (id: string) => {
      if (id === "root") return root;
      const number = Number(id);
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(number)) return undefined;
      const record = await harness.commit(tx => tx.conversation(number as ConversationId), ctx);
      if (!record || record.owner) return undefined;
      return harness.conversation(number as ConversationId, ctx);
    };
    const branch = async (target: Conversation): Promise<BranchInfo> => {
      const record = await harness.commit(tx => tx.conversation(target.id), ctx);
      const [title, live, usage, model] = await Promise.all([
        harness.snapshot(BranchDoc, target.id, ctx), harness.snapshot(LiveDoc, target.id, ctx),
        harness.snapshot(UsageDoc, target.id, ctx), status(target),
      ]);
      return {
        id: target.id,
        title: title?.title || (target.id === ROOT_CONVERSATION_ID ? ROOT_TITLE : `Branch ${target.id}`),
        parent: record?.parent ? { id: record.parent.conversationId, at: record.parent.at } : null,
        model: model.model,
        modelStatus: model.modelStatus,
        thinking: model.thinking,
        busy: live?.run !== undefined,
        cost: usage ? usageCost(usage as UsageState) : 0,
      };
    };
    const totalCost = async () => usageCost(await harness.usage(ctx));

    void harness.closed.then(() => sandbox.close()).catch(() => {});
    host = {
      harness,
      runs,
      async close() {
        // First, so the run is left for the next start to report, not settled as an abort.
        await runs.close();
        await harness.close(ctx);
      },
      modelStatus: status,
      models: () => models.getModels()
        .map(m => ({ provider: m.provider, modelId: m.id, name: m.name }))
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId)),
      assertRunning: () => assertRunning(),
      assertAvailable,
      activate() {
        if (serving) return;
        serving = true;
        if (!blocked.size) harness.resume();
      },
      reserveUpgrade(target) {
        return exclusive(async () => {
          admit();
          let release: () => void;
          try { release = runs.reserveUpgrade(); } catch (error) {
            throw new HttpError(409, error instanceof Error ? error.message : String(error));
          }
          upgrading = true;
          let held = true;
          const unblock = () => {
            if (!held) return;
            held = false;
            upgrading = false;
            release();
          };
          try {
            await assertAvailable();
            await assertAvailable(target);
            const { tasks, submissions } = await harness.inspect(ctx);
            if (tasks.length || submissions.length) throw new HttpError(409, "Wait for all branches to finish before requesting an upgrade");
            return unblock;
          } catch (error) {
            unblock();
            throw error;
          }
        });
      },
      async setModel({ thinkingLevel, ...next }, target = root, context) {
        await exclusive(async () => {
          admit();
          if (!models.getModel(next.provider, next.modelId)) {
            throw new HttpError(400, `Unknown model ${next.provider}/${next.modelId}; list available models with 'aipatty models'`);
          }
          const inspection = await harness.inspect(ctx);
          const tasks = inspection.tasks.filter(t => t.record.conversationId === target.id);
          const pending = inspection.submissions.filter(s => s.conversationId === target.id);
          const recovering = blocked.has(target.id);
          if (!recovering && (tasks.length || pending.length)) {
            throw new HttpError(409, `Cannot switch model while the conversation has active work. Wait for the turn to finish, or run 'aipatty abort${branchRef(target.id)}', before switching.`);
          }
          if (recovering) {
            // The scheduler is paused. Withdraw queued submissions and mark all the branch's tasks before
            // configuring or resuming. Their abort handlers may run; interrupted turns are not replayed.
            for (const submission of pending) {
              if (submission.status === "queued") await harness.abortSubmission(submission.id, ctx);
            }
            for (const task of tasks) await harness.abortTask(task.record.id, ctx);
          }
          await target.configure({ model: next, thinkingLevel }, ctx);
          if (!recovering) return;
          blocked.delete(target.id);
          recovered.push(target);
          if (blocked.size) return;
          harness.resume();
          // An input admitted while the aborted tasks are still settling would never start.
          for (const done of recovered.splice(0)) await done.waitForIdle(ctx);
        }, context);
      },
      setThinking(level, target = root, context) {
        return exclusive(async () => {
          admit();
          const thinkingLevel = thinkingLevels.find(value => value === level);
          if (!thinkingLevel) throw new HttpError(400, `Expected a thinking level: ${thinkingLevels.join(", ")}`);
          await target.configure({ thinkingLevel }, ctx);
        }, context);
      },
      async branches() {
        const records = [];
        let cursor: Cursor | undefined;
        do {
          const page: Page<ConversationRecord, Cursor> = await harness.commit(tx => tx.scanConversations({}, 200, cursor), ctx);
          records.push(...page.items.filter(record => !record.owner));
          cursor = page.next;
        } while (cursor);
        const branches = await Promise.all(records.map(async record => branch((await harness.conversation(record.id, ctx))!)));
        return { branches, totalCost: await totalCost() };
      },
      branch,
      fork(from, { title, at, before }, context = ctx) {
        return exclusive(async () => {
          admit();
          const name = validTitle(title);
          if (!name) throw new HttpError(400, "Expected a title of 1 to 100 characters");
          const { model, thinking } = await status(from, context);
          const agent = { thinkingLevel: thinking, ...(model ? { model } : {}) };
          const init = async (tx: Tx, id: ConversationId) => {
            (await tx.doc(BranchDoc, id)).title = name;
            context.abortSignal?.throwIfAborted();
          };
          const point = await forkPoint(from, at, before, context);
          context.abortSignal?.throwIfAborted();
          const created = point === undefined
            ? await harness.createConversation({ ownership: { kind: "ownerless" }, agent, init }, context)
            : await from.fork(point, { ownership: { kind: "ownerless" }, agent, init }, context);
          return branch(created);
        }, context);
      },
      rename(target, title) {
        return exclusive(async () => {
          admit();
          const name = validTitle(title);
          if (!name) throw new HttpError(400, "Expected a title of 1 to 100 characters");
          await target.commit(async tx => { (await tx.doc(BranchDoc, target.id)).title = name; }, ctx);
        });
      },
      async search(target, query, { limit = 20, before } = {}) {
        const needle = query.trim().toLowerCase();
        if (!needle) throw new HttpError(400, "Expected a non-empty query");
        const matches: SearchMatch[] = [];
        let cursor: Cursor | undefined;
        do {
          const page: Page<EntryRecord, Cursor> = await target.entries(before === undefined ? {} : { maxEntryId: (before - 1) as EntryId }, searchScanPage, cursor, ctx);
          for (const entry of page.items) {
            for (const message of entry.model ?? []) {
              const text = messageText(message).replace(/\s+/g, " ");
              const index = text.toLowerCase().indexOf(needle);
              if (index < 0) continue;
              const start = Math.max(0, index - 80);
              const end = Math.min(text.length, index + needle.length + 80);
              matches.push({
                entryId: entry.id, role: message.role,
                excerpt: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
              });
              break;
            }
            if (matches.length === limit) return { matches, before: entry.id };
          }
          cursor = page.next;
        } while (cursor);
        return { matches, before: null };
      },
      totalCost,
      submit(target, draft, context) {
        return exclusive(async () => {
          admit();
          await assertAvailable(target);
          const submission = await target.submit(draft, ctx);
          logFailure(submission);
          return submission;
        }, context);
      },
      abort(target) {
        return exclusive(async () => {
          admit();
          await assertRunning(target.id);
          await target.abort(ctx);
        });
      },
      conversation,
    };
    return host;
  } catch (error) {
    await harness.close(ctx);
    await sandbox.close();
    throw error;
  }
}

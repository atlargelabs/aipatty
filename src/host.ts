import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createRegistry, Harness, type Conversation, type ConversationId, type InputSubmissionDraft, type ModelRef, type Submission,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { ownDataDir } from "./ownership.ts";
import { openModels } from "./models.ts";
import { failureText } from "./protocol.ts";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const thinkingLevels: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** What a new root conversation starts with. Afterwards `model set` and `thinking set` change the saved values. */
const newRoot = { model: { provider: "openai", modelId: "gpt-6.2-sol" }, thinkingLevel: "high" } as const;
const fauxModel = { provider: "faux", modelId: "faux-1" };

export interface AgentHost {
  harness: Harness;
  conversation(id: string): Promise<Conversation | undefined>;
  /** The root conversation's saved model and thinking level, and whether the local catalog has that model. */
  modelStatus(): Promise<{
    modelStatus: "available" | "unavailable"; model: ModelRef | null; thinking: ModelThinkingLevel;
  }>;
  models(): { provider: string; modelId: string; name: string }[];
  setModel(model: ModelRef): Promise<void>;
  setThinking(level: string): Promise<void>;
  submit(conversation: Conversation, draft: InputSubmissionDraft): Promise<Submission>;
  /** Withdraw queued inputs and abort the running turn; resolves once the conversation is idle. */
  abort(conversation: Conversation): Promise<void>;
  assertAvailable(): Promise<void>;
}

/** Open paused, so an unavailable saved model never executes interrupted work. */
export async function openHost(config: Config): Promise<AgentHost> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const release = ownDataDir(config.dataDir);
  try {
    const agent = await openOwnedHost(config);
    void agent.harness.closed.then(release);
    return agent;
  } catch (error) {
    release();
    throw error;
  }
}

async function openOwnedHost(config: Config): Promise<AgentHost> {
  const models = await openModels(config);
  const storage = await openNodeSqliteStorage(join(config.dataDir, "aipatty.sqlite"));
  const harness = await Harness.open(storage, {
    models,
    registry: createRegistry(),
    settings: { afterFailedRun: "withdraw" },
    onReport: report => console.error("pi-durable:", report),
  }, ctx);
  try {
    const root = await harness.root(ctx, { agent: config.faux ? { ...newRoot, model: fauxModel } : newRoot });
    const status: AgentHost["modelStatus"] = async () => {
      const agent = await root.agent(ctx);
      const saved = agent.model ?? null;
      const available = saved !== null && models.getModel(saved.provider, saved.modelId);
      return { modelStatus: available ? "available" : "unavailable", model: saved, thinking: agent.thinkingLevel };
    };
    let blocked = (await status()).modelStatus === "unavailable";
    if (!blocked) harness.resume();
    // Serialize admission, aborts and model changes: no input may slip between the busy check and configure(),
    // or be admitted while aborted work is still settling, where it would never start.
    let tail = Promise.resolve();
    function exclusive<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn);
      tail = result.then(() => {}, () => {});
      return result;
    }
    const assertAvailable = async () => {
      if (blocked) {
        const { model: saved } = await status();
        throw new HttpError(409, `Model ${saved ? `${saved.provider}/${saved.modelId}` : "(none)"} is unavailable. Run 'aipatty models' then 'aipatty model set <modelId>'.`);
      }
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
    return {
      harness,
      modelStatus: status,
      models: () => models.getModels()
        .map(m => ({ provider: m.provider, modelId: m.id, name: m.name }))
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId)),
      assertAvailable,
      async setModel(next) {
        await exclusive(async () => {
          if (!models.getModel(next.provider, next.modelId)) {
            throw new HttpError(400, `Unknown model ${next.provider}/${next.modelId}; list available models with 'aipatty models'`);
          }
          const inspection = await harness.inspect(ctx);
          const tasks = inspection.tasks.filter(t => t.record.conversationId === root.id);
          const pending = inspection.submissions.filter(s => s.conversationId === root.id);
          if (!blocked && (tasks.length || pending.length)) {
            throw new HttpError(409, "Cannot switch model while the conversation has active work. Wait for the turn to finish, or run 'aipatty abort', before switching.");
          }
          if (blocked) {
            // The scheduler is paused. Withdraw queued submissions and mark all root tasks before
            // configuring or resuming. Their abort handlers may run; interrupted turns are not replayed.
            for (const submission of pending) {
              if (submission.status === "queued") await harness.abortSubmission(submission.id, ctx);
            }
            for (const task of tasks) await harness.abortTask(task.record.id, ctx);
          }
          await root.configure({ model: next }, ctx);
          const recovering = blocked;
          blocked = false;
          harness.resume();
          // An input admitted while the aborted tasks are still settling would never start.
          if (recovering) await root.waitForIdle(ctx);
        });
      },
      setThinking(level) {
        return exclusive(async () => {
          const thinkingLevel = thinkingLevels.find(value => value === level);
          if (!thinkingLevel) throw new HttpError(400, `Expected a thinking level: ${thinkingLevels.join(", ")}`);
          await root.configure({ thinkingLevel }, ctx);
        });
      },
      submit(conversation, draft) {
        return exclusive(async () => {
          await assertAvailable();
          const submission = await conversation.submit(draft, ctx);
          logFailure(submission);
          return submission;
        });
      },
      abort(conversation) {
        return exclusive(async () => {
          await assertAvailable();
          await conversation.abort(ctx);
        });
      },
      async conversation(id) {
        if (id === "root") return root;
        const number = Number(id);
        if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(number)) return undefined;
        return harness.conversation(number as ConversationId, ctx);
      },
    };
  } catch (error) {
    await harness.close(ctx);
    throw error;
  }
}

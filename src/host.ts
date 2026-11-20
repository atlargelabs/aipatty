import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  createRegistry, Harness, type Conversation, type ConversationId, type InputSubmissionDraft, type ModelRef, type Submission,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_THINKING, type Config } from "./config.ts";
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

export interface AgentHost {
  harness: Harness;
  conversation(id: string): Promise<Conversation | undefined>;
  modelStatus(): Promise<{ modelStatus: "available" | "unavailable"; model: ModelRef | null }>;
  models(): { provider: string; modelId: string; name: string }[];
  setModel(model: ModelRef): Promise<void>;
  submit(conversation: Conversation, draft: InputSubmissionDraft): Promise<Submission>;
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
  const model = { provider: config.provider, modelId: config.model };
  const storage = await openNodeSqliteStorage(join(config.dataDir, "aipatty.sqlite"));
  const harness = await Harness.open(storage, {
    models,
    registry: createRegistry(),
    settings: { afterFailedRun: "withdraw" },
    onReport: report => console.error("pi-durable:", report),
  }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model, thinkingLevel: config.thinking ?? DEFAULT_THINKING } });
    // root() applies `agent` only when it creates the root; an explicit level also changes an existing one.
    if (config.thinking && (await root.agent(ctx)).thinkingLevel !== config.thinking) {
      await root.configure({ thinkingLevel: config.thinking }, ctx);
    }
    const status: AgentHost["modelStatus"] = async () => {
      const saved = (await root.agent(ctx)).model ?? null;
      const available = saved !== null && models.getModel(saved.provider, saved.modelId);
      return { modelStatus: available ? "available" : "unavailable", model: saved };
    };
    let blocked = (await status()).modelStatus === "unavailable";
    if (!blocked) harness.resume();
    // Serialize admission and model changes: no input may slip between the busy check and configure().
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
    // Log a failed run once, whether or not a client is streaming it. A closing harness rejects the wait.
    const awaited = new Set<number>();
    const logFailure = (submission: Submission) => {
      if (awaited.has(submission.id)) return;
      awaited.add(submission.id);
      void submission.wait(ctx).then(result => {
        if (result.status === "unanswered" && result.reason !== "aborted") {
          console.error(`Run failed (submission ${result.id}): ${failureText(result.reason, result.detail)}`);
        }
      }, () => {}).finally(() => awaited.delete(submission.id));
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
            throw new HttpError(409, "Cannot switch model while the conversation has active work. Wait for the turn to finish or abort it before switching.");
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
          blocked = false;
          harness.resume();
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

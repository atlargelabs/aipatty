import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, type Conversation, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { openModels, requireModel } from "./models.ts";

/** The running harness and the conversation lookup shared by API transports. */
export interface AgentHost {
  harness: Harness;
  conversation(id: string): Promise<Conversation | undefined>;
}

/** Open the SQLite session, create the root if needed, and resume durable work. */
export async function openHost(config: Config): Promise<AgentHost> {
  const models = await openModels(config);
  const model = { provider: config.provider, modelId: config.model };
  requireModel(models, model);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const storage = await openNodeSqliteStorage(join(config.dataDir, "aipatty.sqlite"));
  const harness = await Harness.open(storage, {
    models,
    registry: createRegistry(),
    settings: { afterFailedRun: "withdraw" },
    onReport: report => console.error("pi-durable:", report),
  }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model, thinkingLevel: config.thinking } });
    const agent = await root.agent(ctx);
    if (agent.model) requireModel(models, agent.model);
    harness.resume();
    return {
      harness,
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

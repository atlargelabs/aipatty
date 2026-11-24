import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type Context } from "@earendil-works/pi-ai";
import { configure, createRegistry, defineExtension, defineTool, Harness, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj } from "@earendil-works/pi-schema";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.ts";

// Exercise the pinned Durable version through real Faux requests, including the prompt it sends, not just stored config.
test("Durable changes extensions and prompt for existing, forked and reopened conversations", { timeout: 15_000 }, async t => {
  const path = join(await fixture(t), "durable.sqlite");
  const requests: Context[] = [];
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const response = (tool?: string) => {
    faux.appendResponses([request => {
      requests.push(request);
      return tool ? fauxAssistantMessage(fauxToolCall(tool, {}), { stopReason: "toolUse" }) : fauxAssistantMessage("ok");
    }]);
  };
  const text = (value: unknown) => ({ output: [{ type: "text" as const, text: String(value) }] });
  const base = defineExtension({ name: "base", tools: [defineTool({
    name: "nested_probe", description: "Try a nested app call", parameters: obj({}),
    async execute(_args, api, context) {
      const agent = await api.agent(context);
      const result = await api.executeTool("app_probe", {}, context);
      return text(`callable=${agent.callable.some(tool => tool.name === "app_probe")}, error=${result.isError}`);
    },
  })] });
  const app = defineExtension({ name: "app", tools: [defineTool({
    name: "app_probe", description: "An opt-in app tool", parameters: obj({}),
    async execute() { return text("app data"); },
  })] });
  const open = async (installed: boolean) => {
    const registry = createRegistry();
    registry.install(base);
    if (installed) registry.install(app);
    return Harness.open(await openNodeSqliteStorage(path), { registry, models, settings: { extensions: [base] } }, ctx);
  };
  const send = async (conversation: Conversation, attached: boolean, nested = false) => {
    response(nested ? "nested_probe" : undefined);
    if (nested) response();
    const submission = await conversation.submit({ type: "input", content: "next turn" }, ctx);
    assert.equal((await submission.wait(ctx)).status, "done");
    const request = requests.at(-1)!;
    assert.deepEqual(getCurrentTools(request.messages).map(tool => tool.name), attached ? ["nested_probe", "app_probe"] : ["nested_probe"]);
    assert.equal(getCurrentSystemPrompt(request.messages).includes("Opt-in app instructions"), attached);
    if (nested) {
      const result = request.messages.at(-1);
      assert.equal(result?.role, "toolResult");
      assert.deepEqual(result.content, [{ type: "text", text: `callable=${attached}, error=${!attached}` }]);
    }
  };
  const enabled = { extensions: { add: [app] }, instructions: "Opt-in app instructions" };
  const fallback = { extensions: null, instructions: null };
  const original = await open(false);
  const root = await original.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  await send(root, false);
  await original.close(ctx);

  const second = await open(true);
  let forkId: Conversation["id"];
  try {
    const existing = await second.root(ctx);
    await send(existing, false, true); // Installing the app must not grant it to a historical default agent.
    await existing.configure(enabled, ctx);
    await send(existing, true, true);
    const last = (await existing.entries({}, 1, undefined, ctx)).items[0].id;
    const fork = await existing.fork(last, {
      ownership: { kind: "ownerless" }, init: (tx, id) => configure(tx, id, enabled),
    }, ctx);
    forkId = fork.id;
    await send(fork, true);
    await existing.configure(fallback, ctx);
    await send(existing, false, true); // A tool result from the app era is still in history.
  } finally { await second.close(ctx); }

  const third = await open(false);
  try {
    const fork = (await third.conversation(forkId, ctx))!;
    // A startup pass also clears instructions when the selected app could not open.
    await fork.configure(fallback, ctx);
    await send(fork, false, true);
  } finally { await third.close(ctx); }

  const restored = await open(true);
  try {
    const fork = (await restored.conversation(forkId, ctx))!;
    await fork.configure(enabled, ctx);
    await send(fork, true, true);
    await send(await restored.root(ctx), false, true);
  } finally { await restored.close(ctx); }
});

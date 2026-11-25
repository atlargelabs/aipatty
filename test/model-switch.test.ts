import { awaitWithContext, BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type SubmissionId } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { startApi } from "../src/api.ts";
import { openHost } from "../src/host.ts";
import { connect, fauxConfig, fixture, until } from "./helpers.ts";

test("/model leaves the whole turn alone and applies the latest valid choice at idle", { timeout: 10_000 }, async t => {
  const ref = (modelId: string) => ({ provider: "faux", modelId });
  const faux = fauxProvider({ models: ["faux-1", "next", "last"].map(id => ({ id })) });
  const models = createModels();
  models.setProvider(faux.provider);
  let started = Promise.withResolvers<void>();
  let finish = Promise.withResolvers<void>();
  const extension = defineExtension({ name: "test-idle-model", tools: [defineTool({
    name: "hold_tool", description: "Wait for the test", parameters: obj({}),
    async execute(_args, _api, context) {
      started.resolve();
      await awaitWithContext(finish.promise, context);
      return { output: [{ type: "text", text: "tool finished" }] };
    },
  })] });
  const host = await openHost(fauxConfig(await fixture(t)), { models, extensions: [extension] });
  const api = await startApi(host, { ok: true, commit: "test", startedAt: "now", version: "0" }, 0);
  t.after(async () => { finish.resolve(); await api.close(); await host.close(); });
  const base = `http://127.0.0.1:${api.port}`;
  const root = (await host.conversation("root"))!;
  const post = (content: string) => fetch(`${base}/api/conversations/root/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }),
  });

  const applied = await post(" /model next\n");
  assert.equal(applied.status, 200);
  assert.deepEqual(await applied.json(), { modelSwitch: "applied", model: ref("next"), notice: "Model set to faux/next." });
  assert.equal((await post("/model\nfaux/last")).status, 400);
  assert.deepEqual((await root.entries({}, 10, undefined, ctx)).items, []);
  const stream = connect(t, base);
  await stream.opened;

  const callTool = fauxAssistantMessage(fauxToolCall("hold_tool", {}), { stopReason: "toolUse" });
  faux.setResponses([
    callTool,
    (context, _options, _state, model) => {
      const inputs = context.messages.filter(message => message.role === "user").map(message => message.content);
      const result = context.messages.find(message => message.role === "toolResult");
      return fauxAssistantMessage(JSON.stringify({ model: model.id, inputs, result: result?.content }));
    },
  ]);
  const { submissionId } = await (await post("/models")).json() as { submissionId: SubmissionId };
  await started.promise;
  const queued = await post("/model faux/faux-1");
  assert.equal(queued.status, 202);
  assert.deepEqual(await queued.json(), {
    modelSwitch: "queued", model: ref("faux-1"), notice: "Queued faux/faux-1; it will apply when this branch goes idle.",
  });
  assert.equal(await host.setModel(ref("last"), root), "queued");
  await assert.rejects(host.setModel({ ...ref("faux-1"), thinkingLevel: "low" }, root), /omit thinking/);
  assert.equal((await post("/model faux/invalid")).status, 400);
  assert.deepEqual((await host.modelStatus()).model, ref("next"));
  assert.deepEqual((await host.harness.inspect(ctx)).submissions.map(s => s.id), [submissionId]);

  finish.resolve();
  const submission = (await host.harness.submission(submissionId, ctx))!;
  assert.equal((await submission.wait(ctx)).status, "done");
  await until(() => stream.state()?.model?.modelId === "last");
  const answer = stream.state()?.entries.at(-1)?.model?.[0];
  assert.equal(answer?.role, "assistant");
  assert.deepEqual(answer?.content, [{ type: "text", text: JSON.stringify({
    model: "next", inputs: ["/models"], result: [{ type: "text", text: "tool finished" }],
  }) }]);

  started = Promise.withResolvers<void>();
  finish = Promise.withResolvers<void>();
  faux.setResponses([callTool]);
  const aborted = await host.submit(root, { type: "input", content: "abort this one" });
  await started.promise;
  assert.equal((await post("/model faux/faux-1")).status, 202);
  await host.abort(root);
  assert.equal((await aborted.status(ctx)).status, "unanswered");
  assert.deepEqual((await host.modelStatus()).model, ref("last"), "abort discards the unapplied selection");
});

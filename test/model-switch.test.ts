import { awaitWithContext, BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { GenerationTask, hook, LiveDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { test } from "node:test";
import { startApi } from "../src/api.ts";
import type { BranchInfo } from "../src/branches.ts";
import type { ModelStatus } from "../src/host.ts";
import { PendingModelDoc } from "../src/model-switch.ts";
import { messageText } from "../src/protocol.ts";
import { modelSwitchFixture, nextModel, oldModel, otherModel } from "./fixtures/model-switch.ts";
import { connect, fixture, requestJson as json, until } from "./helpers.ts";

const health = { ok: true as const, commit: "test", startedAt: "now", version: "0" };
const rootModel = "/api/model";
const rootPath = "/api/conversations/root";

test("the latest queued model applies to the same submission after an entire parallel tool round", { timeout: 15_000 }, async t => {
  const { faux, tools, open, start } = modelSwitchFixture(await fixture(t), 2);
  const boundary = Promise.withResolvers<void>();
  const leaveBoundary = Promise.withResolvers<void>();
  const host = await open({ name: "test-tool-boundary", hooks: [hook(GenerationTask, {
    async afterTools(_assistant, _results, api, context) {
      if (api.conversationId === ROOT_CONVERSATION_ID) {
        boundary.resolve();
        await awaitWithContext(leaveBoundary.promise, context);
      }
      return undefined;
    },
  })] });
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });
  const base = `http://127.0.0.1:${api.port}`;
  const { root, submission } = await start(host);
  const stream = connect(t, base, `?submissionId=${submission.id}`);
  await stream.opened;
  await until(stream.state);
  assert.deepEqual(stream.state()?.model, oldModel);

  const first = await json<ModelStatus>(base, rootModel, "PUT", otherModel);
  assert.deepEqual(first, { status: 202, body: { modelStatus: "available", model: oldModel, thinking: "high", pendingModel: otherModel } });
  const scoped = await json<BranchInfo>(base, `${rootPath}/model`, "PUT", nextModel);
  assert.equal(scoped.status, 202);
  assert.deepEqual(scoped.body.model, oldModel);
  assert.deepEqual(scoped.body.pendingModel, nextModel);
  assert.equal((await json(base, rootModel, "PUT", { modelId: "missing" })).status, 400);
  assert.equal((await json(base, rootModel, "PUT", { provider: "offline", modelId: oldModel.modelId })).status, 400);
  assert.deepEqual((await host.modelStatus()).pendingModel, nextModel, "invalid selections do not replace the queue");

  // The fork inherits the effective model, not the queued one. It can change model and use its own while the root waits.
  const { items } = await root.entries({}, 10, undefined, ctx);
  const at = items.find(entry => entry.model?.some(message => message.role === "user"))!.id;
  const fork = await json<BranchInfo>(base, `${rootPath}/fork`, "POST", { title: "Independent", at });
  assert.equal(fork.status, 201);
  assert.deepEqual(fork.body.model, oldModel);
  assert.equal(fork.body.pendingModel, undefined);
  const side = (await host.conversation(String(fork.body.id)))!;
  const idle = await json<BranchInfo>(base, `/api/conversations/${side.id}/model`, "PUT", nextModel);
  assert.equal(idle.status, 200);
  assert.deepEqual(idle.body.model, nextModel);
  assert.equal(idle.body.pendingModel, undefined);

  tools[0].done.resolve();
  await until(async () => (await host.harness.snapshot(LiveDoc, root.id, ctx))?.tools?.[0]?.status === "done");
  assert.deepEqual((await host.modelStatus()).model, oldModel, "one finished parallel tool is not a boundary");
  // A cross-branch tool uses the same path and reports a queue, not a switch. Its request wins over the two PUTs.
  faux.appendResponses([
    fauxAssistantMessage(fauxToolCall("set_model", { ...otherModel, branch: root.id, thinking: "low" }), { stopReason: "toolUse" }),
    (context, _options, _state, model) => {
      assert.equal(model.id, nextModel.modelId);
      return fauxAssistantMessage(messageText(context.messages.at(-1)!));
    },
  ]);
  const sideResult = await (await host.submit(side, { type: "input", content: "Change the root model" })).wait(ctx);
  assert.equal(sideResult.status, "done");
  const sideEntries = (await side.entries({}, 1, undefined, ctx)).items;
  assert.match(messageText(sideEntries[0].model![0]), /Queued faux\/faux-other with thinking low for the main branch/);
  const list = await json<{ branches: BranchInfo[] }>(base, "/api/branches");
  assert.deepEqual(list.body.branches[0].pendingModel, otherModel);
  assert.deepEqual(list.body.branches[0].model, oldModel);
  assert.equal(list.body.branches[0].thinking, "high");
  const standalone = await json<ModelStatus>(base, "/api/thinking", "PUT", { level: "medium" });
  assert.equal(standalone.status, 200);
  assert.equal(standalone.body.thinking, "medium");
  assert.deepEqual(standalone.body.pendingModel, otherModel);

  faux.appendResponses([(context, _options, _state, model) => {
    assert.equal(model.id, otherModel.modelId, "the first actual request after the tools uses the latest model");
    assert.deepEqual(context.messages.filter(m => m.role === "toolResult").map(messageText), tools.map(tool => tool.result));
    assert.deepEqual(context.messages.filter(m => m.role === "user").map(messageText), ["Run the tools"]);
    return fauxAssistantMessage("Same turn, new model");
  }]);
  tools[1].done.resolve();
  await boundary.promise;
  assert.deepEqual(await host.modelStatus(), { modelStatus: "available", model: otherModel, thinking: "medium" });
  // The slots still exist, but the hook has already run. Do not accept a switch that would miss the boundary.
  assert.equal((await json(base, rootModel, "PUT", nextModel)).status, 409);
  await until(() => stream.state()?.model?.modelId === otherModel.modelId);
  assert.equal(stream.state()?.busy, true, "the new effective model is streamed before the assistant turn finishes");
  leaveBoundary.resolve();
  assert.equal((await submission.wait(ctx)).status, "done");
  await until(() => stream.frames.find(f => f.type === "settled" && f.status === "done" && f.answer === "Same turn, new model"));
  assert.deepEqual((await host.modelStatus(side)).model, nextModel);
});

test("abort cancels a queued switch and an idle selection is immediately effective", { timeout: 10_000 }, async t => {
  const { open, start } = modelSwitchFixture(await fixture(t));
  const host = await open();
  t.after(() => host.close());
  const { root, submission } = await start(host);
  const taskId = (await host.harness.snapshot(LiveDoc, root.id, ctx))!.run!.taskId;
  assert.deepEqual((await host.setModel(nextModel))?.pendingModel, nextModel);
  await host.abort(root);
  const result = await submission.wait(ctx);
  assert.ok(result.status === "unanswered" && result.reason === "aborted", JSON.stringify(result));
  assert.deepEqual(await host.modelStatus(), { modelStatus: "available", model: oldModel, thinking: "high" });
  assert.equal(await host.harness.snapshot(PendingModelDoc, taskId, ctx), undefined);
  assert.equal(await host.setModel(otherModel), undefined);
  assert.deepEqual(await host.modelStatus(), { modelStatus: "available", model: otherModel, thinking: "high" });
});

for (const removed of [false, true]) {
  test(removed ? "reopen drops a queued selection that is no longer available" : "a queued switch survives reopen and applies when the interrupted tool round settles", { timeout: 10_000 }, async t => {
    const { faux, models, tools, open, start } = modelSwitchFixture(await fixture(t));
    const first = await open();
    let closed = false;
    t.after(async () => { if (!closed) await first.close(); });
    const { submission } = await start(first);
    assert.deepEqual((await first.setModel(nextModel))?.pendingModel, nextModel);
    await first.close();
    closed = true;
    if (removed) models.setProvider({ ...faux.provider, getModels: () => [faux.getModel()] });
    const reopened = await open();
    t.after(() => reopened.close());
    assert.deepEqual(await reopened.modelStatus(), { modelStatus: "available", model: oldModel, thinking: "high", pendingModel: nextModel });
    const expected = removed ? oldModel : nextModel;
    faux.appendResponses([(context, _options, _state, model) => {
      assert.equal(model.id, expected.modelId);
      assert.equal(messageText(context.messages.at(-1)!), tools[0].result);
      return fauxAssistantMessage("Continued after reopen");
    }]);
    tools[0].done.resolve();
    const reacquired = (await reopened.harness.submission(submission.id, ctx))!;
    assert.equal((await reacquired.wait(ctx)).status, "done");
    assert.deepEqual(await reopened.modelStatus(), { modelStatus: "available", model: expected, thinking: "high" });
  });
}

test("set_model can select a model for its own branch without waiting on host admission", { timeout: 10_000 }, async t => {
  const { faux, open } = modelSwitchFixture(await fixture(t));
  const host = await open();
  t.after(() => host.close());
  const root = (await host.conversation("root"))!;
  faux.appendResponses([
    fauxAssistantMessage(fauxToolCall("set_model", nextModel), { stopReason: "toolUse" }),
    (context, _options, _state, model) => {
      assert.match(messageText(context.messages.at(-1)!), /Queued faux\/faux-next for the main branch/);
      assert.equal(model.id, nextModel.modelId);
      return fauxAssistantMessage("Continued");
    },
  ]);
  const submission = await host.submit(root, { type: "input", content: "Change your own model" });
  assert.equal((await submission.wait(ctx)).status, "done");
  assert.deepEqual(await host.modelStatus(), { modelStatus: "available", model: nextModel, thinking: "high" });
});

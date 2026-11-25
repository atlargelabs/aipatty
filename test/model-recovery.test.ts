import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { test } from "node:test";
import { startApi } from "../src/api.ts";
import { openHost } from "../src/host.ts";
import { messageText } from "../src/protocol.ts";
import { connect, fixture, fauxConfig, realConfig, until } from "./helpers.ts";

const health = { ok: true as const, commit: "test", startedAt: "now", version: "0" };
test("unavailable interrupted work is withdrawn on switch and cannot replay after restart or new input", async t => {
  const dir = await fixture(t);
  const initial = await openHost(fauxConfig(dir));
  const root = (await initial.conversation("root"))!;
  const first = await initial.submit(root, { type: "input", content: "old ".repeat(300) });
  await until(async () => (await initial.harness.inspect(ctx)).tasks.some(task => task.state.kind === "running"));
  await initial.harness.close(ctx);

  const config = realConfig(dir);
  const blocked = await openHost(config);
  const api = await startApi(blocked, health, 0);
  const base = `http://127.0.0.1:${api.port}`;
  try {
    const status = await (await fetch(`${base}/health`)).json() as { modelStatus: string; model: { modelId: string } };
    assert.equal(status.modelStatus, "unavailable");
    assert.equal(status.model.modelId, "faux-1");
    assert.equal((await fetch(`${base}/api/conversations/root`)).status, 200);
    assert.equal((await fetch(`${base}/api/models`)).status, 200);
    const rejected = await fetch(`${base}/api/conversations/root/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "no" }) });
    assert.equal(rejected.status, 409);
    assert.match((await rejected.json() as { error: string }).error, /aipatty model set/);
    const set = await fetch(`${base}/api/model`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openai", modelId: "gpt-6.1-sol" }) });
    assert.equal(set.status, 200);
    await until(async () => (await (await blocked.harness.submission(first.id, ctx))!.status(ctx)).status === "unanswered");
  } finally { await api.close(); await blocked.harness.close(ctx); }

  const again = await openHost(fauxConfig(dir));
  assert.equal((await again.modelStatus()).modelStatus, "unavailable");
  await again.setModel({ provider: "faux", modelId: "faux-1" });
  const current = (await again.conversation("root"))!;
  const next = await again.submit(current, { type: "input", content: "new" });
  assert.equal((await next.wait(ctx)).status, "done");
  const entries = await current.entries({}, 100, undefined, ctx);
  const texts = entries.items.flatMap(entry => (entry.model ?? []).map(messageText));
  assert.ok(texts.includes("Faux reply: new"));
  assert.ok(!texts.some(text => text.startsWith("Faux reply: old")));
  assert.equal((await (await again.harness.submission(first.id, ctx))!.status(ctx)).status, "unanswered");
  await again.harness.close(ctx);
});

test("settled frame is delivered while a later submission is still running", async t => {
  const dir = await fixture(t);
  const host = await openHost(fauxConfig(dir));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.harness.close(ctx); });
  const base = `http://127.0.0.1:${api.port}`;
  const post = (content: string) => fetch(`${base}/api/conversations/root/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }),
  });
  const first = await (await post("first")).json() as { submissionId: number };
  await post("x".repeat(900));
  const ws = connect(t, base, `?submissionId=${first.submissionId}`);
  await until(async () => ws.frames.some(frame => frame.type === "settled"));
  assert.ok((await host.harness.inspect(ctx)).submissions.length > 0, "later submission must still be pending");
});

test("switching a busy branch does not resume work blocked on a different branch's unavailable model", async t => {
  const dir = await fixture(t);
  const config = fauxConfig(dir);
  const host = await openHost(config);
  const root = (await host.conversation("root"))!;
  const fork = await host.fork(root, { title: "Unavailable" });
  const side = (await host.conversation(String(fork.id)))!;
  await host.submit(root, { type: "input", content: "x".repeat(900) });
  await host.submit(side, { type: "input", content: "y".repeat(900) });
  await side.configure({ model: { provider: "missing", modelId: "offline" } }, ctx);
  await host.close();

  const reopened = await openHost(config);
  t.after(() => reopened.close());
  await assert.rejects(reopened.setModel({ provider: "faux", modelId: "faux-1" }), /has interrupted work waiting/);
  const inspection = await reopened.harness.inspect(ctx);
  assert.equal(inspection.scheduling, "paused");
  assert.equal(inspection.submissions.length, 2);
});

test("a message sent right behind a recovering model switch, or during an abort, is not stranded", { timeout: 20_000 }, async t => {
  const dir = await fixture(t);
  const initial = await openHost(fauxConfig(dir));
  await initial.submit((await initial.conversation("root"))!, { type: "input", content: "old ".repeat(300) });
  await until(async () => (await initial.harness.inspect(ctx)).tasks.some(task => task.state.kind === "running"));
  await initial.harness.close(ctx);

  // The saved faux model is not in the real catalog, so the interrupted run stays paused until a switch aborts it.
  const blocked = await openHost(realConfig(dir));
  const settles = async (submission: Awaited<ReturnType<typeof blocked.submit>>) =>
    (await submission.wait(withAbortSignal(AbortSignal.timeout(5_000), ctx))).status;
  try {
    const root = (await blocked.conversation("root"))!;
    const switched = blocked.setModel({ provider: "openai", modelId: "gpt-6.1-sol" });
    const behind = await blocked.submit(root, { type: "input", content: "new" });
    await switched;
    assert.equal(await settles(behind), "unanswered", "no login: the run fails, but it must run");
  } finally {
    await blocked.harness.close(ctx);
  }

  const host = await openHost(fauxConfig(dir));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.harness.close(ctx); });
  await host.setModel({ provider: "faux", modelId: "faux-1" });
  const messages = `http://127.0.0.1:${api.port}/api/conversations/root`;
  const post = (path: string, body: unknown) => fetch(messages + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  for (let round = 0; round < 5; round++) {
    await post("/messages", { content: "x".repeat(900) });
    await until(async () => (await host.harness.inspect(ctx)).tasks.some(task => task.state.kind === "running"));
    const [aborted, sent] = await Promise.all([post("/abort", {}), post("/messages", { content: `after abort ${round}` })]);
    assert.equal(aborted.status, 200);
    const { submissionId } = await sent.json() as { submissionId: number };
    const submission = (await host.harness.submission(submissionId as Parameters<typeof host.harness.submission>[0], ctx))!;
    assert.notEqual((await submission.wait(withAbortSignal(AbortSignal.timeout(5_000), ctx))).status, undefined);
  }
});

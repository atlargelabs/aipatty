import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { startApi } from "../src/api.ts";
import { readConfig } from "../src/config.ts";
import { openHost } from "../src/host.ts";
import { messageText } from "../src/protocol.ts";
import { connect, fixture, fixtureEnv, fauxConfig } from "./helpers.ts";

const health = { ok: true as const, commit: "test", startedAt: "now", version: "0" };
async function waitFor(fn: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await fn()) { if (Date.now() > end) throw Error("timeout"); await sleep(20); }
}

test("unavailable interrupted work is withdrawn on switch and cannot replay after restart or new input", async t => {
  const dir = await fixture(t);
  const initial = await openHost(fauxConfig(dir));
  const root = (await initial.conversation("root"))!;
  const first = await initial.submit(root, { type: "input", content: "old ".repeat(300) });
  await waitFor(async () => (await initial.harness.inspect(ctx)).tasks.some(task => task.state.kind === "running"));
  await initial.harness.close(ctx);

  const config = readConfig(fixtureEnv(dir, { AIPATTY_FAUX: "0" }));
  const blocked = await openHost(config);
  const api = await startApi(blocked, health, "127.0.0.1", 0);
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
    await waitFor(async () => (await (await blocked.harness.submission(first.id, ctx))!.status(ctx)).status === "unanswered");
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
  const api = await startApi(host, health, "127.0.0.1", 0);
  t.after(async () => { await api.close(); await host.harness.close(ctx); });
  const base = `http://127.0.0.1:${api.port}`;
  const post = (content: string) => fetch(`${base}/api/conversations/root/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }),
  });
  const first = await (await post("first")).json() as { submissionId: number };
  await post("x".repeat(900));
  const ws = connect(t, base, `?submissionId=${first.submissionId}`);
  await waitFor(async () => ws.frames.some(frame => frame.type === "settled"));
  assert.ok((await host.harness.inspect(ctx)).submissions.length > 0, "later submission must still be pending");
});

test("available existing model ignores invalid new-root default and active switch conflicts", async t => {
  const dir = await fixture(t);
  const host = await openHost(fauxConfig(dir));
  const root = (await host.conversation("root"))!;
  await host.submit(root, { type: "input", content: "x".repeat(900) });
  await waitFor(async () => (await host.harness.inspect(ctx)).tasks.length > 0);
  await assert.rejects(host.setModel({ provider: "faux", modelId: "faux-1" }), /active work/);
  await host.harness.close(ctx);
  const reopened = await openHost({ ...fauxConfig(dir), model: "missing" });
  assert.equal((await reopened.modelStatus()).modelStatus, "available");
  await waitFor(async () => (await reopened.harness.inspect(ctx)).submissions.length === 0);
  await reopened.harness.close(ctx);
});

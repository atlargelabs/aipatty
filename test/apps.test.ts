import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type Context } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { startApi } from "../src/api.ts";
import { openHost } from "../src/host.ts";
import { appEntryKind, messageText } from "../src/protocol.ts";
import { fixtureApp } from "./fixtures/app.ts";
import { connect, fauxConfig, fixture, until } from "./helpers.ts";

const health = { ok: true as const, commit: "test", startedAt: "now", version: "0" };

// Run actual turns through the pinned Durable registry, and inspect the requests seen by Faux.
test("apps opt branches into tools, discovery and instructions, including forks and interrupted work", { timeout: 30_000 }, async t => {
  const config = fauxConfig(await fixture(t));
  const requests: Context[] = [];
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  type Response = ReturnType<typeof fauxAssistantMessage>;
  const script = (...replies: Response[]) => faux.setResponses(replies.map(reply => request => {
    requests.push(request);
    return reply;
  }));
  const alpha = fixtureApp("alpha");
  const beta = fixtureApp("beta");
  let host = await openHost(config, { apps: [alpha, beta], models });
  const root = () => host.conversation("root").then(value => value!);
  let api = await startApi(host, health, 0);
  const endpoint = () => `http://127.0.0.1:${api.port}`;
  const post = (id: string | number, content: string) => fetch(`${endpoint()}/api/conversations/${id}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }),
  });
  async function command(id: string | number, content: string) {
    const count = requests.length;
    const response = await post(id, content);
    assert.equal(response.status, 202);
    const body = await response.json() as { notice: string };
    assert.deepEqual(Object.keys(body), ["notice"]);
    assert.equal(requests.length, count, "operator commands never go to the model");
    return body.notice;
  }
  const stream = connect(t, endpoint());
  const reply = fauxAssistantMessage("OK from Faux");
  const search = fauxToolCall("tool_search", { query: "alpha_deferred" }, { id: "search" });
  const codemode = fauxToolCall("codemode", { code: `
    console.log("discovered=" + (await searchTools("alpha_deferred")).some(tool => tool.name === "alpha_deferred"));
    try { console.log("nested=" + await tools.alpha_deferred({})); } catch { console.log("nested=unavailable"); }
  ` }, { id: "code" });
  const prompt = (expected: string[]) => {
    const request = requests.at(-1)!;
    const text = getCurrentSystemPrompt(request.messages);
    const instructions = [...text.matchAll(/Instruction for fixture (\w+)\./g)].map(match => match[1]);
    assert.deepEqual(instructions, expected);
    const names = getCurrentTools(request.messages).map(tool => tool.name);
    for (const builtIn of ["bash", "pi", "codemode", "tool_search"]) assert.ok(names.includes(builtIn), builtIn);
    assert.deepEqual(names.filter(name => name.endsWith("_probe")), expected.map(id => id + "_probe"));
    return names;
  };
  const send = async (conversation: Conversation) => {
    const submission = await host.submit(conversation, { type: "input", content: "check settings" });
    assert.equal((await submission.wait(ctx)).status, "done");
  };
  const discover = async (conversation: Conversation, expected: string[], active: boolean) => {
    const first = requests.length;
    script(fauxAssistantMessage([search, codemode], { stopReason: "toolUse" }), reply);
    await send(conversation);
    assert.equal(prompt(expected).includes("alpha_deferred"), active);
    const current = requests.at(-1)!.messages.filter(message => message.role === "toolResult");
    const [searchResult, codeResult] = current.slice(-2);
    const alreadyLoaded = getCurrentTools(requests[first].messages).some(tool => tool.name === "alpha_deferred");
    assert.match(messageText(searchResult), active && !alreadyLoaded ? /alpha_deferred/ : /No matching tools/);
    assert.equal(codeResult.isError, false, messageText(codeResult));
    assert.match(messageText(codeResult), active ? /nested=alpha deferred works/ : /nested=unavailable/);
    assert.match(messageText(codeResult), active ? /discovered=true/ : /discovered=false/);
  };

  try {
    await stream.opened;
    const original = await root();
    await discover(original, [], false);
    assert.match(await command("root", "/connect"), /Connected apps: none.*alpha.*available/s);
    assert.match(await command("root", "/connect absent"), /not included in this release/);
    await command("root", "/connect beta");
    await command("root", "/connect alpha");
    assert.match(await command("root", "/connect beta"), /already connected/);
    const attached = await host.branch(original);
    assert.deepEqual(attached.apps, ["beta", "alpha"]);
    assert.deepEqual(attached.availableApps, ["alpha", "beta"]);
    await until(() => stream.state()?.apps?.join(",") === "beta,alpha");
    await discover(original, ["beta", "alpha"], true);
    script(fauxAssistantMessage(fauxToolCall("beta_probe", { fail: true }), { stopReason: "toolUse" }), reply);
    await send(original);
    assert.match(messageText(requests.at(-1)!.messages.at(-1)!), /beta tool failed/);
    const child = await host.fork(original, { title: "Both apps" });
    const fork = (await host.conversation(String(child.id)))!;
    assert.deepEqual(child.apps, ["beta", "alpha"]);
    await discover(fork, ["beta", "alpha"], true);
    await command("root", "/disconnect alpha");
    await command("root", "/disconnect beta");
    assert.match(await command("root", "/disconnect beta"), /not connected/);
    await until(() => stream.state()?.apps?.length === 0);
    await discover(original, [], false); // Still off even after tool_search loaded the deferred tool into this branch.
    assert.ok(!(requests.at(-1)!.messages.some(message => messageText(message).includes("Disconnected Fixture"))));
    assert.ok(stream.state()?.entries.some(entry => entry.kind === appEntryKind && !entry.model));

    // Pause on a real streaming turn. Changing apps is refused; an optional app failing on restart must not
    // leak its saved instructions or tools into the first resumed request, or remove either marker.
    const slow = fauxProvider({ tokensPerSecond: 10, tokenSize: { min: 1, max: 1 } });
    let started = false;
    slow.setResponses([() => { started = true; return fauxAssistantMessage("slow ".repeat(500)); }]);
    models.setProvider(slow.provider);
    const interrupted = await host.submit(fork, { type: "input", content: "interrupted" });
    await until(() => started);
    assert.equal((await post(child.id, "/disconnect alpha")).status, 409);
    assert.equal((await post(child.id, "/connect alpha")).status, 409);
    assert.match(await command(child.id, "/connect"), /Connected apps: beta, alpha/);
    await api.close();
    await host.close();

    models.setProvider(faux.provider);
    script(reply);
    const before = requests.length;
    host = await openHost(config, { apps: [fixtureApp("alpha", { unavailable: true })], models });
    api = await startApi(host, health, 0);
    const resumed = (await host.harness.submission(interrupted.id, ctx))!;
    assert.equal((await resumed.wait(ctx)).status, "unanswered");
    assert.equal(requests.length, before, "a suspended request with stale declarations must not be sent");
    const unavailable = (await host.conversation(String(child.id)))!;
    await discover(unavailable, [], false);
    const summary = await host.branch(unavailable);
    assert.deepEqual([summary.connectedApps, summary.apps], [["beta", "alpha"], []]);
    const status = await (await fetch(`${endpoint()}/health`)).json() as { ok: boolean; appProblems: string[]; problems?: string[] };
    assert.equal(status.ok, true);
    assert.equal(status.problems, undefined, "optional apps must not count as a failed upgrade health check");
    assert.match(status.appProblems.join("\n"), /apps\/alpha: fixture could not open.*apps\/beta/s);
    assert.match(await command(child.id, "/connect"), /beta, alpha.*fixture could not open.*not included/s);
    await api.close();
    await host.close();

    host = await openHost(config, { apps: [alpha, beta], models });
    api = await startApi(host, health, 0);
    const restored = (await host.conversation(String(child.id)))!;
    assert.deepEqual((await host.branch(restored)).apps, ["beta", "alpha"]);
    await discover(restored, ["beta", "alpha"], true);
    await discover(await root(), [], false);
  } finally { await api.close(); await host.close(); }
});

test("only valid namespaced apps open; app requests keep the host trust and error boundary", async t => {
  const dir = await fixture(t);
  let rejectedClosed = false;
  const host = await openHost(fauxConfig(dir), { apps: [
    fixtureApp("good"), fixtureApp("../invalid"), fixtureApp("duplicate"), fixtureApp("duplicate"),
    fixtureApp("bad", { toolName: "good_other", close: () => { rejectedClosed = true; } }),
  ] });
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });
  assert.equal(rejectedClosed, true);
  assert.deepEqual((await host.appProblems()).map(problem => problem.split(" unavailable")[0]), ['"../invalid"', '"duplicate"', '"bad"']);
  const base = `http://127.0.0.1:${api.port}`;
  const route = `${base}/apps/good/`;
  const response = await fetch(route, { headers: { Origin: base } });
  assert.equal(response.status, 200);
  const dataDir = join(dir, "apps", "good");
  assert.deepEqual(await response.json(), { id: "good", dataDir });
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-security-policy"), (await fetch(base)).headers.get("content-security-policy"));
  assert.equal((await fetch(route, { headers: { Origin: "https://outside.example" } })).status, 403);
  const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
    get(route, { headers: { Host: `outside.example:${api.port}` } }, res => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await fetch(`${base}/apps/bad/`)).status, 404);
  assert.equal((await fetch(route + "throw")).status, 500);
  await assert.rejects(async () => (await fetch(route + "partial")).text());
  assert.equal((await fetch(route)).status, 200);
});

import { BACKGROUND_CONTEXT as ctx, withCancel } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { startApi } from "../src/api.ts";
import type { BranchInfo } from "../src/branches.ts";
import { openHost, type AgentHost } from "../src/host.ts";
import { pageModules } from "../src/page.ts";
import { messageText, type ConversationPage } from "../src/protocol.ts";
import { checkout, fauxConfig, fixture, realConfig, until } from "./helpers.ts";

const health = { ok: true as const, commit: "test", startedAt: "now", version: "0" };
const exec = promisify(execFile);

async function server(t: TestContext, dir?: string) {
  const host = await openHost(fauxConfig(dir ?? await fixture(t)));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.harness.close(ctx); });
  const base = `http://127.0.0.1:${api.port}`;
  const call = async <T = unknown>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(base + path, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as T };
  };
  return { host, base, call };
}

/** Send and wait for the answer. */
async function say(host: AgentHost, id: string, content: string): Promise<void> {
  const conversation = (await host.conversation(id))!;
  const result = await (await host.submit(conversation, { type: "input", content })).wait(ctx);
  assert.equal(result.status, "done", JSON.stringify(result));
}

async function texts(host: AgentHost, id: string): Promise<string[]> {
  const { items } = await (await host.conversation(id))!.entries({}, 100, undefined, ctx);
  return items.toReversed().flatMap(entry => (entry.model ?? []).map(messageText).filter(Boolean));
}

test("a fork shares history to the fork point, then diverges, and every branch stays listed", async t => {
  const { host, call } = await server(t);
  await say(host, "root", "one");
  await say(host, "root", "two");
  const root = (await host.conversation("root"))!;
  const firstAnswer = (await root.entries({}, 100, undefined, ctx)).items
    .find(entry => entry.model?.some(message => messageText(message) === "Faux reply: one"))!;

  const latest = await call<BranchInfo>("/api/conversations/root/fork", "POST", { title: "  Side   quest " });
  assert.equal(latest.status, 201);
  assert.equal(latest.body.title, "Side quest");
  assert.deepEqual(latest.body.model, { provider: "faux", modelId: "faux-1" });
  const early = await call<BranchInfo>("/api/conversations/root/fork", "POST", { title: "Early", at: firstAnswer.id });
  assert.equal(early.status, 201);
  assert.deepEqual(early.body.parent, { id: root.id, at: firstAnswer.id });

  await say(host, String(latest.body.id), "three");
  assert.deepEqual(await texts(host, String(latest.body.id)), [
    "one", "Faux reply: one", "two", "Faux reply: two", "three", "Faux reply: three",
  ]);
  assert.deepEqual(await texts(host, String(early.body.id)), ["one", "Faux reply: one"]);
  assert.ok(!(await texts(host, "root")).includes("three"), "the parent does not see the fork's turns");

  // A fork of a fork, and the list in creation order with the root titled "Main".
  const nested = await call<BranchInfo>(`/api/conversations/${latest.body.id}/fork`, "POST", { title: "Deeper" });
  const { body } = await call<{ branches: BranchInfo[]; totalCost: number }>("/api/branches");
  assert.deepEqual(body.branches.map(branch => branch.title), ["Main", "Side quest", "Early", "Deeper"]);
  assert.equal(body.branches[3].parent?.id, latest.body.id);
  assert.equal(nested.body.parent?.id, latest.body.id);

  const renamed = await call<BranchInfo>(`/api/conversations/${early.body.id}/title`, "PUT", { title: "Renamed" });
  assert.equal(renamed.body.title, "Renamed");
  assert.equal((await call("/api/conversations/root/fork", "POST", { title: "" })).status, 400);
  assert.equal((await call("/api/conversations/root/fork", "POST", { title: "x".repeat(101) })).status, 400);
  assert.equal((await call("/api/conversations/root/fork", "POST", { title: "bad\u0007" })).status, 400);
  assert.equal((await call("/api/conversations/root/fork", "POST", { title: "Missing", at: 99_999 })).status, 400);
  assert.equal((await call("/api/conversations/999/fork", "POST", { title: "x" })).status, 404);
});

test("HTTP and read_branch page the same fork history without gaps or duplicates", { timeout: 30_000 }, async t => {
  const { host, call } = await server(t);
  await say(host, "root", "inherited");
  const root = (await host.conversation("root"))!;
  const fork = (await call<BranchInfo>("/api/conversations/root/fork", "POST", { title: "Paged fork" })).body;
  const id = String(fork.id);
  const target = (await host.conversation(id))!;
  assert.notEqual(target.id, root.id);
  await say(host, "root", "parent only"); // A gap in the global IDs, not part of the fork's history.
  await say(host, id, "local one");
  // Limits count raw entries, even when a page has no visible model messages.
  const silent = await target.commit(tx => tx.appendEntry(target.id, { kind: "test" }), ctx);
  await say(host, id, "local two");
  const all = (await target.entries({}, 100, undefined, ctx)).items.toReversed();
  assert.deepEqual(await texts(host, id), [
    "inherited", "Faux reply: inherited", "local one", "Faux reply: local one", "local two", "Faux reply: local two",
  ]);
  assert.ok(all.some(entry => entry.id === silent.id && !entry.model?.length));

  const read = async (limit: number, before?: number) => {
    // Run the real tool from a different branch so these calls cannot move the target's pages.
    await say(host, "root", `call read_branch ${JSON.stringify({ branch: fork.id, limit, before })}`);
    const recent = (await root.entries({}, 10, undefined, ctx)).items;
    const result = recent.flatMap(entry => entry.model ?? [])
      .find(message => message.role === "toolResult" && message.toolName === "read_branch");
    assert.ok(result?.role === "toolResult" && !result.isError);
    const output = messageText(result);
    const cursor = /^Older entries exist: continue with before=(\d+)\./.exec(output);
    const ids = [...output.matchAll(/^\[(\d+)\] /gm)].map(match => Number(match[1]));
    return { output, ids, before: cursor ? Number(cursor[1]) : null };
  };

  // Single entries exercise invisible pages; three entries span the fork boundary; a large page ends immediately.
  for (const limit of [1, 3, 50]) {
    let before: number | undefined;
    let end = all.length;
    let seen: number[] = [];
    do {
      const start = Math.max(0, end - limit);
      const expected = all.slice(start, end);
      const expectedBefore = start > 0 ? expected[0].id : null;
      const url = `/api/conversations/${id}?limit=${limit}${before === undefined ? "" : `&before=${before}`}`;
      const http = await call<ConversationPage>(url);
      assert.equal(http.status, 200);
      assert.deepEqual(http.body.entries.map(entry => entry.id), expected.map(entry => entry.id));
      assert.equal(http.body.before, expectedBefore);
      assert.ok(http.body.entries.every(entry => before === undefined || entry.id < before));

      const tool = await read(limit, before);
      const visible = expected.flatMap(entry => (entry.model ?? []).flatMap(message => {
        const body = messageText(message);
        return body ? [{ id: entry.id, line: `[${entry.id}] ${message.role}: ${body}` }] : [];
      }));
      assert.deepEqual(tool.ids, visible.map(message => message.id));
      assert.equal(tool.before, http.body.before);
      const lines = [
        ...(expectedBefore === null ? [] : [`Older entries exist: continue with before=${expectedBefore}.`]),
        ...visible.map(message => message.line),
      ];
      assert.equal(tool.output, lines.length ? lines.join("\n")
        : `Branch ${id} has no messages${before === undefined ? "" : " before that entry"}.`);
      seen = [...http.body.entries.map(entry => entry.id), ...seen];
      end = start;
      before = expectedBefore ?? undefined;
    } while (before !== undefined);
    assert.equal(end, 0);
    assert.deepEqual(seen, all.map(entry => entry.id));
    assert.equal(new Set(seen).size, seen.length);
  }

  const oldest = all[0].id;
  const empty = await call<ConversationPage>(`/api/conversations/${id}?limit=1&before=${oldest}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.entries, []);
  assert.equal(empty.body.before, null);
  assert.deepEqual(await read(1, oldest), {
    output: `Branch ${id} has no messages before that entry.`, ids: [], before: null,
  });
  assert.deepEqual((await target.entries({}, 100, undefined, ctx)).items.toReversed(), all);
});

test("fork points reject incomplete multi-call exchanges, including the latest entry", async t => {
  const { host, call } = await server(t);
  await say(host, "root", 'call list_branches {}');
  const root = (await host.conversation("root"))!;
  const history = (await root.entries({}, 100, undefined, ctx)).items;
  const assistant = history.flatMap(entry => entry.model ?? []).find(message => message.role === "assistant"
    && message.content.some(part => part.type === "toolCall"));
  const result = history.flatMap(entry => entry.model ?? []).find(message => message.role === "toolResult");
  assert.ok(assistant?.role === "assistant" && result?.role === "toolResult");
  const first = assistant.content.find(part => part.type === "toolCall")!;
  assert.ok(first.type === "toolCall");
  const callEntry = await root.commit(tx => tx.appendEntry(root.id, {
    kind: "test", model: [{ ...assistant, content: [first, { ...first, id: "second" }] }],
  }), ctx);
  const partial = await root.commit(tx => tx.appendEntry(root.id, {
    kind: "test", model: [result],
  }), ctx);
  for (const at of [callEntry.id, partial.id, undefined]) {
    const response = await call<{ error: string }>("/api/conversations/root/fork", "POST", { title: "unsafe", at });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /tool exchange is incomplete/);
  }
  const complete = await root.commit(tx => tx.appendEntry(root.id, {
    kind: "test", model: [{ ...result, toolCallId: "second" }],
  }), ctx);
  assert.equal((await call("/api/conversations/root/fork", "POST", { title: "safe", at: complete.id })).status, 201);
  await root.commit(tx => tx.appendEntry(root.id, { kind: "test", edits: [{ target: complete.id, action: "omit" }] }), ctx);
  assert.equal((await call("/api/conversations/root/fork", "POST", { title: "result omitted" })).status, 400);
  await root.commit(tx => tx.appendEntry(root.id, { kind: "test", head: "self" }), ctx);
  assert.equal((await call("/api/conversations/root/fork", "POST", { title: "after reset" })).status, 201);
});

test("forking a branch with no messages yet starts an empty branch", async t => {
  const { call } = await server(t);
  const created = await call<BranchInfo>("/api/conversations/root/fork", "POST", { title: "Fresh" });
  assert.equal(created.status, 201);
  assert.equal(created.body.parent, null);
  const page = await call<ConversationPage>(`/api/conversations/${created.body.id}`);
  assert.deepEqual(page.body.entries, []);
});

test("each branch keeps its own model and thinking level, and a queued switch does not block another branch", async t => {
  const { host, call } = await server(t);
  const fork = (await call<BranchInfo>("/api/conversations/root/fork", "POST", { title: "Fork" })).body;
  const set = await call<BranchInfo>(`/api/conversations/${fork.id}/thinking`, "PUT", { level: "low" });
  assert.equal(set.body.thinking, "low");
  assert.equal((await host.modelStatus()).thinking, "high", "the root keeps its own level");
  assert.equal((await call(`/api/conversations/${fork.id}/model`, "PUT", { modelId: "nope" })).status, 400);

  const branch = (await host.conversation(String(fork.id)))!;
  await host.submit(branch, { type: "input", content: "x".repeat(900) });
  await until(async () => (await host.branch(branch)).busy);
  const busy = await call(`/api/conversations/${fork.id}/model`, "PUT", { modelId: "faux-1" });
  assert.equal(busy.status, 202);
  assert.deepEqual(busy.body, { modelSwitch: "queued", model: { provider: "faux", modelId: "faux-1" } });
  // The root is not busy, so its model can still change.
  assert.equal((await call("/api/model", "PUT", { modelId: "faux-1" })).status, 200);
  await call(`/api/conversations/${fork.id}/abort`, "POST");
});

test("search finds text in a branch, including what it inherited, newest first and paged", async t => {
  const { host, call } = await server(t);
  await say(host, "root", "the Apple tree");
  await say(host, "root", "an orange");
  await say(host, "root", "apple pie");
  const fork = (await call<BranchInfo>("/api/conversations/root/fork", "POST", { title: "Fork" })).body;
  await say(host, String(fork.id), "crab APPLE");

  type Result = { matches: { entryId: number; role: string; excerpt: string }[]; before: number | null };
  const all = await call<Result>(`/api/conversations/${fork.id}/search?q=apple`);
  assert.deepEqual(all.body.matches.map(match => match.excerpt), [
    "Faux reply: crab APPLE", "crab APPLE", "Faux reply: apple pie", "apple pie", "Faux reply: the Apple tree", "the Apple tree",
  ]);
  assert.equal(all.body.before, null);
  const first = await call<Result>(`/api/conversations/${fork.id}/search?q=apple&limit=2`);
  assert.equal(first.body.matches.length, 2);
  assert.ok(first.body.before !== null);
  const next = await call<Result>(`/api/conversations/${fork.id}/search?q=apple&limit=2&before=${first.body.before}`);
  assert.deepEqual(next.body.matches.map(match => match.excerpt), ["Faux reply: apple pie", "apple pie"]);
  const root = await call<Result>("/api/conversations/root/search?q=crab");
  assert.deepEqual(root.body.matches, []);
  assert.equal((await call("/api/conversations/root/search?q=")).status, 400);

  const long = `${"a".repeat(300)} needle ${"b".repeat(300)}`;
  await say(host, "root", long);
  const excerpt = (await call<Result>("/api/conversations/root/search?q=needle&limit=1")).body.matches[0].excerpt;
  assert.ok(excerpt.startsWith("…") && excerpt.endsWith("…") && excerpt.includes("needle") && excerpt.length < 200, excerpt);
});

test("the model's tree tools list, read, search, fork and set models", { timeout: 20_000 }, async t => {
  const { host, call } = await server(t);
  await say(host, "root", "remember the walrus");
  await say(host, "root", "call list_branches {}");
  assert.match((await texts(host, "root")).at(-1)!, /Faux tool result: 1: Main \(faux\/faux-1, \$0\.00, busy\)  ← this branch\nTotal spend: \$0\.00/);

  await say(host, "root", 'call fork_branch {"title":"Walrus research","message":"look into walruses"}');
  assert.match((await texts(host, "root")).at(-1)!, /Created branch (\d+), "Walrus research"\. It is working on the message\./);
  const { body } = await call<{ branches: BranchInfo[] }>("/api/branches");
  const created = body.branches.find(branch => branch.title === "Walrus research")!;
  assert.ok(created);
  const id = String(created.id);
  await until(async () => (await texts(host, id)).at(-1) === "Faux reply: look into walruses");
  // The new branch starts before the call that created it: that call has no result yet, and would read as a failed one.
  const inherited = (await (await host.conversation(id))!.context(ctx)).messages;
  assert.deepEqual(inherited.flatMap(message => message.role === "assistant"
    ? message.content.flatMap(content => content.type === "toolCall" ? [content.name] : []) : []), ["list_branches"]);
  assert.ok(!inherited.some(message => message.role === "toolResult" && message.isError), JSON.stringify(inherited));
  assert.deepEqual((await texts(host, id)).slice(-3), [
    'call fork_branch {"title":"Walrus research","message":"look into walruses"}', "look into walruses", "Faux reply: look into walruses",
  ]);

  await say(host, "root", `call read_branch {"branch":${id},"limit":2}`);
  const read = (await texts(host, "root")).at(-1)!;
  assert.match(read, /Older entries exist: continue with before=\d+\./);
  assert.match(read, /user: look into walruses\n\[\d+\] assistant: Faux reply: look into walruses$/);

  await say(host, "root", `call read_branch {"branch":${id},"query":"WALRUS"}`);
  assert.match((await texts(host, "root")).at(-1)!, /assistant: Faux reply: look into walruses/);
  await say(host, "root", 'call read_branch {"branch":999}');
  assert.match((await texts(host, "root")).at(-1)!, /No branch 999/);

  await say(host, "root", `call set_model {"modelId":"faux-1","branch":${id},"thinking":"minimal"}`);
  assert.match((await texts(host, "root")).at(-1)!, new RegExp(`Set branch ${id} to faux/faux-1 with thinking minimal\\.`));
  assert.equal((await host.modelStatus((await host.conversation(id))!)).thinking, "minimal");
  await say(host, "root", 'call set_model {"modelId":"nope"}');
  assert.match((await texts(host, "root")).at(-1)!, /Unknown model nope/);
});

test("fork_branch reports the committed branch ID when first message admission fails", async t => {
  const { host } = await server(t);
  const source = await host.fork((await host.conversation("root"))!, { title: "Offline" });
  const offline = (await host.conversation(String(source.id)))!;
  await offline.configure({ model: { provider: "missing", modelId: "offline" } }, ctx);
  await say(host, "root", `call fork_branch ${JSON.stringify({ from: source.id, title: "Child", message: "start" })}`);
  const { branches } = await host.branches();
  assert.equal(branches.length, 3);
  const child = branches.find(branch => branch.title === "Child")!;
  const reply = (await texts(host, "root")).at(-1)!;
  assert.ok(reply.includes(`Created branch ${child.id}, "Child". First message admission failed:`), reply);
  assert.match(reply, /missing\/offline.*unavailable/);
  assert.deepEqual(await texts(host, String(child.id)), []);
});

test("a call cancelled while it waits behind its branch's abort does nothing when its turn comes", async t => {
  const { host } = await server(t);
  const root = (await host.conversation("root"))!;
  await host.submit(root, { type: "input", content: "x".repeat(900) });
  await until(async () => (await host.branch(root)).busy);

  // The abort holds this branch's admission line until the turn has ended. The calls wait behind it,
  // and the abort can cancel their context while they wait.
  const { context, cancel } = withCancel(ctx);
  const aborting = host.abort(root);
  const queued = Promise.allSettled([
    host.submit(root, { type: "input", content: "too late" }, context),
    host.setModel({ provider: "faux", modelId: "faux-1" }, root, context),
    host.setThinking("low", root, context),
  ]);
  cancel();
  await aborting;
  assert.deepEqual((await queued).map(result => result.status), ["rejected", "rejected", "rejected"]);
  await root.waitForIdle(ctx);
  assert.ok(!(await texts(host, "root")).some(text => text.includes("too late")), "the cancelled message never started a turn");
  assert.equal((await host.modelStatus(root)).thinking, "high");

  // Without a cancelled context the same calls go through.
  await host.setThinking("low", root);
  assert.equal((await host.modelStatus(root)).thinking, "low");
  await say(host, "root", "in time");
});

test("fork cancellation during point lookup prevents creation", async t => {
  const { host } = await server(t);
  await say(host, "root", "hello");
  const root = (await host.conversation("root"))!;
  const { context, cancel } = withCancel(ctx);
  const entries = root.entries.bind(root);
  t.mock.method(root, "entries", async (...args: Parameters<typeof entries>) => {
    const page = await entries(...args);
    cancel();
    return page;
  });
  await assert.rejects(host.fork(root, { title: "cancelled lookup" }, context), { name: "AbortError" });
  assert.ok(!(await host.branches()).branches.some(item => item.title === "cancelled lookup"));
});

test("model and thinking change in one configure operation", async t => {
  const { host } = await server(t);
  const root = (await host.conversation("root"))!;
  const configure = t.mock.method(root, "configure");
  await host.setModel({ provider: "faux", modelId: "faux-1", thinkingLevel: "low" }, root, ctx);
  assert.deepEqual(configure.mock.calls.map(call => call.arguments[0]), [{
    model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "low",
  }]);
});

test("the page shows the branch's own cost and the session total", async t => {
  const { host, call } = await server(t);
  await say(host, "root", "hello");
  const fork = (await call<BranchInfo>("/api/conversations/root/fork", "POST", { title: "Fork" })).body;
  await say(host, String(fork.id), "more");
  const root = await call<{ branch: BranchInfo; totalCost: number; usage: { cost: number } }>("/api/conversations/root");
  const branch = await call<{ branch: BranchInfo; totalCost: number; usage: { cost: number } }>(`/api/conversations/${fork.id}`);
  assert.equal(root.body.branch.title, "Main");
  assert.equal(branch.body.branch.cost, branch.body.usage.cost);
  assert.equal(root.body.totalCost, branch.body.totalCost);
  assert.ok(Math.abs(root.body.totalCost - (root.body.branch.cost + branch.body.branch.cost)) < 1e-12);
});

test("the web page is served with a strict policy and its script and style", async t => {
  const { base } = await server(t);
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /text\/html/);
  assert.match(page.headers.get("content-security-policy")!, /default-src 'none'; script-src 'self'/);
  assert.match(await page.text(), /<script type="module" src="\/app\.js"><\/script>/);
  // Every script must parse, and import only scripts that are served: either failure would leave the page blank.
  const scripts = ["/app.js", ...Object.keys(pageModules)];
  for (const path of scripts) {
    const script = await fetch(base + path);
    assert.equal(script.status, 200, path);
    assert.match(script.headers.get("content-type")!, /text\/javascript/, path);
    assert.equal(script.headers.get("x-content-type-options"), "nosniff", path);
    const source = await script.text();
    assert.doesNotThrow(() => stripTypeScriptTypes(source), path);
    for (const [, from] of source.matchAll(/^import .* from "(.+)";$/gm)) {
      assert.ok(scripts.includes(new URL(from, base + path).pathname), `${path} imports ${from}`);
    }
  }
  assert.equal((await fetch(base + "/web/nothing.ts")).status, 404);
  assert.equal((await fetch(base + "/markdown-it.js.map")).status, 404);
  assert.equal((await fetch(base + "/app.css")).status, 200);
  assert.equal((await fetch(base + "/", { method: "POST" })).status, 405);
});

test("a task-owned conversation is not a branch, and an unknown ID is 404", async t => {
  const { call } = await server(t);
  assert.equal((await call("/api/conversations/2")).status, 404);
  assert.equal((await call("/api/conversations/abc")).status, 404);
});

test("CLI lists, reads, searches, forks and renames branches, and sends to one", { timeout: 15_000 }, async t => {
  const dir = await fixture(t);
  const { host, base } = await server(t, dir);
  const cli = (...args: string[]) => exec(process.execPath, ["src/cli.ts", "--port", new URL(base).port, ...args], { cwd: checkout, env: {} });
  await say(host, "root", "hello there");
  const forked = JSON.parse((await cli("fork", "From the CLI")).stdout) as BranchInfo;
  assert.equal(forked.title, "From the CLI");
  const id = String(forked.id);
  assert.equal((await cli("--branch", id, "send", "only here")).stdout, "Faux reply: only here\n");
  const list = (await cli("branches")).stdout;
  assert.match(list, new RegExp(`^1: Main \\(faux/faux-1, \\$0\\.00\\)\\n${id}: From the CLI \\(faux/faux-1, \\$0\\.00, forked from 1 at entry \\d+\\)\\nTotal spend: \\$0\\.00\\n$`));
  const read = (await cli("branches", "read", id, "--limit", "2")).stdout;
  assert.match(read, /^\[\d+\] user: only here\n\[\d+\] assistant: Faux reply: only here\n$/);
  assert.match((await cli("branches", "search", id, "THERE")).stdout, /^\[\d+\] assistant: Faux reply: hello there\n\[\d+\] user: hello there\n$/);
  assert.equal((await cli("branches", "search", "1", "only here")).stdout, "No matches\n");
  assert.equal(JSON.parse((await cli("--branch", id, "rename", "Renamed")).stdout).title, "Renamed");
  assert.equal(JSON.parse((await cli("--branch", id, "thinking", "set", "low")).stdout).thinking, "low");
  assert.doesNotMatch((await cli("log")).stdout, /only here/);
  await assert.rejects(cli("--branch", "x", "log"), /Expected a branch ID: x/);
  await assert.rejects(cli("branches", "frob"), /Usage: aipatty/);
});

test("interrupted work on a branch with an unavailable model blocks only until that branch switches", { timeout: 20_000 }, async t => {
  const dir = await fixture(t);
  const initial = await openHost(fauxConfig(dir));
  const fork = await initial.fork((await initial.conversation("root"))!, { title: "Fork" });
  const branch = (await initial.conversation(String(fork.id)))!;
  await initial.submit(branch, { type: "input", content: "old ".repeat(300) });
  await until(async () => (await initial.harness.inspect(ctx)).tasks.some(task => task.state.kind === "running"));
  await initial.harness.close(ctx);

  // Without faux, the saved faux model is missing from the catalog. The root has no interrupted work.
  const blocked = await openHost(realConfig(dir));
  try {
    const root = (await blocked.conversation("root"))!;
    await assert.rejects(blocked.submit(root, { type: "input", content: "no" }), new RegExp(`Branch ${fork.id} has interrupted work.*model set --branch ${fork.id}`));
    const list = await blocked.branches();
    assert.equal(list.branches.length, 2, "reads still work");
    const reopened = (await blocked.conversation(String(fork.id)))!;
    await blocked.setModel({ provider: "openai", modelId: "gpt-6.1-sol" }, reopened);
    await assert.rejects(blocked.submit(root, { type: "input", content: "no" }), /Model faux\/faux-1 is unavailable/);
    assert.equal((await blocked.harness.inspect(ctx)).tasks.length, 0, "the interrupted turn was withdrawn, not replayed");
  } finally {
    await blocked.harness.close(ctx);
  }
});

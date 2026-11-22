import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import WebSocket from "ws";
import { startApi } from "../src/api.ts";
import { openHost } from "../src/host.ts";
import { messageText, streamUpdate, type ConversationPage } from "../src/protocol.ts";
import { connect, fauxConfig, fixture, until } from "./helpers.ts";

const health = { ok: true as const, commit: "test", startedAt: "now", version: "0" };

/** Start a faux-model server on a free port over `dir`. */
async function start(dir: string, heartbeatMs?: number) {
  const host = await openHost(fauxConfig(dir));
  const api = await startApi(host, health, 0, { heartbeatMs });
  let closed = false;
  return {
    base: `http://127.0.0.1:${api.port}`,
    async close() {
      if (closed) return;
      closed = true;
      await api.close();
      await host.harness.close(ctx);
    },
  };
}

async function server(t: TestContext, dir?: string, heartbeatMs?: number) {
  const running = await start(dir ?? await fixture(t), heartbeatMs);
  t.after(() => running.close());
  return running;
}

function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/conversations/root/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The root's page, without the branch summary and total that only the HTTP page carries. */
async function page(base: string): Promise<ConversationPage> {
  const { branch: _branch, totalCost: _total, ...rest } = await (await fetch(`${base}/api/conversations/root`)).json() as
    ConversationPage & { branch: unknown; totalCost: number };
  return rest;
}

/**
 * The visible text of every model message, as `role: text`. Messages without text, such as the system entry that
 * announces the tree tools on the first turn, are left out.
 */
function lines(state: ConversationPage): string[] {
  return state.entries.flatMap(entry => (entry.model ?? []).flatMap(message => {
    const text = messageText(message);
    return text ? [`${message.role}: ${text}`] : [];
  }));
}

const idleWith = (count: number) => (state: ConversationPage) => !state.busy && lines(state).length >= count;

test("a message is admitted at once and answered", async t => {
  const { base } = await server(t);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), {
    ...health, modelStatus: "available", model: { provider: "faux", modelId: "faux-1" }, thinking: "high",
  });

  const response = await post(base, { content: "hello" });
  assert.equal(response.status, 202);
  assert.equal(typeof (await response.json() as { submissionId: number }).submissionId, "number");

  const state = await until(() => page(base), idleWith(2));
  assert.deepEqual(lines(state), ["user: hello", "assistant: Faux reply: hello"]);
  assert.equal(state.model?.modelId, "faux-1");
  assert.equal(typeof state.usage.cost, "number");
});

test("the stream delivers the answer, and a late joiner gets the current state", async t => {
  const { base } = await server(t);
  const early = connect(t, base);
  await early.opened;
  const { submissionId } = await (await post(base, { content: "stream me" })).json() as { submissionId: number };

  const settled = connect(t, base, `?submissionId=${submissionId}`);
  const frame = await until(
    () => settled.frames.find(candidate => candidate.type === "settled"),
    candidate => candidate !== undefined,
  );
  assert.deepEqual(frame, { type: "settled", submissionId, status: "done", answer: "Faux reply: stream me" });

  const last = await until(() => early.state(), candidate => candidate !== undefined && idleWith(2)(candidate));
  assert.ok(last);
  assert.equal(lines(last).at(-1), "assistant: Faux reply: stream me");

  // Only the first frame carries the window; the rest carry what changed, and fold to the same page.
  const [first, ...updates] = early.frames;
  assert.equal(first.type, "state");
  assert.ok(updates.length > 2, "expected live updates between the first and last state");
  assert.ok(updates.every(update => update.type === "update" && !("entries" in update)));
  assert.equal(updates.flatMap(update => update.type === "update" ? update.appended : []).length, last.entries.length);
  const { live: _live, type: _type, ...folded } = last;
  assert.deepEqual(folded, await page(base));

  const late = connect(t, base);
  const joined = await until(() => late.frames[0], candidate => candidate !== undefined);
  assert.ok(joined?.type === "state");
  assert.equal(joined.busy, false);
  assert.deepEqual(lines(joined), ["user: stream me", "assistant: Faux reply: stream me"]);
});

test("a retried request with the same requestId is not submitted twice", async t => {
  const { base } = await server(t);
  const body = { content: "once", requestId: "retry-1" };
  const first = await (await post(base, body)).json() as { submissionId: number };
  const second = await (await post(base, body)).json() as { submissionId: number };
  assert.equal(second.submissionId, first.submissionId);

  const state = await until(() => page(base), idleWith(2));
  await sleep(200);
  assert.deepEqual(lines(await page(base)), lines(state));
  assert.equal(lines(state).filter(line => line === "user: once").length, 1);
});

test("the transcript survives a restart, and a run cut off by a close is finished", async t => {
  const dir = await fixture(t);
  const first = await start(dir);
  t.after(() => first.close());
  await post(first.base, { content: "before" });
  await until(() => page(first.base), idleWith(2));

  // The faux model streams about 80 three-character tokens a second, so this answer takes seconds.
  const long = "x".repeat(900);
  await post(first.base, { content: long });
  await until(() => page(first.base), state => state.busy);
  await first.close();

  const second = await server(t, dir);
  const state = await until(() => page(second.base), idleWith(4));
  const transcript = lines(state);
  assert.deepEqual(transcript.slice(0, 2), ["user: before", "assistant: Faux reply: before"]);
  assert.equal(transcript.at(-1), `assistant: Faux reply: ${long}`);
});

test("paging backwards returns older entries", async t => {
  const { base } = await server(t);
  await post(base, { content: "one" });
  await until(() => page(base), idleWith(2));
  await post(base, { content: "two" });
  const all = await until(() => page(base), idleWith(4));

  const newest = await (await fetch(`${base}/api/conversations/root?limit=1`)).json() as ConversationPage;
  assert.equal(newest.entries.length, 1);
  assert.equal(newest.entries[0].id, all.entries.at(-1)?.id);
  assert.notEqual(newest.before, null);

  const older = await (await fetch(`${base}/api/conversations/root?limit=1&before=${newest.before}`)).json() as ConversationPage;
  assert.equal(older.entries.length, 1);
  assert.equal(older.entries[0].id, all.entries.at(-2)?.id);
});

test("invalid requests and foreign origins are rejected", async t => {
  const { base } = await server(t);
  const status = async (response: Promise<Response>) => (await response).status;

  assert.equal(await status(post(base, { content: "" })), 400);
  assert.equal(await status(post(base, { content: "x", whenBusy: "never" })), 400);
  assert.equal(await status(post(base, "{not json")), 400);
  assert.equal(await status(post(base, { content: "x" }, { "Content-Type": "text/plain" })), 415);
  assert.equal(await status(post(base, { content: "x".repeat(70_000) })), 413);
  assert.equal(await status(fetch(`${base}/api/conversations/999999`)), 404);
  assert.equal(await status(fetch(`${base}/api/conversations/root?limit=0`)), 400);
  assert.equal(await status(fetch(`${base}/nope`)), 404);
  assert.equal(await status(fetch(`${base}/health`, { method: "POST" })), 405);

  assert.equal(await status(post(base, { content: "x" }, { Origin: "http://evil.example" })), 403);
  assert.equal(await status(fetch(`${base}/health`, { headers: { Origin: base } })), 200);

  const foreign = connect(t, base);
  await foreign.opened;
  foreign.ws.terminate();
  const rejected = new WebSocket(`${base.replace("http:", "ws:")}/api/conversations/root/stream`, {
    origin: "http://evil.example",
  });
  t.after(() => rejected.terminate());
  const code = await new Promise<number>(resolve => {
    rejected.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    rejected.on("open", () => resolve(101));
    rejected.on("error", () => {});
  });
  assert.equal(code, 403);

  assert.deepEqual(lines(await page(base)), []);
});

test("shutdown is requested once even with a stuck acknowledgement", { timeout: 5_000 }, async t => {
  const host = await openHost(fauxConfig(await fixture(t)));
  const queued = Promise.withResolvers<void>();
  const stop = Promise.withResolvers<void>();
  let healthCalls = 0, stopCalls = 0;
  const api = await startApi({ ...host, modelStatus() {
    if (++healthCalls === 2) queued.resolve();
    return new Promise(() => {});
  } }, health, 0, { onShutdown() { stopCalls++; stop.resolve(); } });
  t.after(async () => { await api.close(); await host.close(); });
  const authority = `127.0.0.1:${api.port}`;
  const socket = createConnection({ host: "127.0.0.1", port: api.port });
  t.after(() => socket.destroy());
  const closed = once(socket, "close");
  await once(socket, "connect");
  // The first health response stalls the acknowledgement; the last request signals that the POST was handled.
  const get = `GET /health HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;
  const post = `POST /api/shutdown HTTP/1.1\r\nHost: ${authority}\r\nX-Aipatty-Shutdown: 1\r\nContent-Length: 0\r\n\r\n`;
  socket.write(get + post + get);
  await queued.promise;
  const duplicate = await fetch(`http://${authority}/api/shutdown`, {
    method: "POST", headers: { "X-Aipatty-Shutdown": "1" },
  });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: "Shutdown already requested" });
  await stop.promise;
  await api.close();
  await closed;
  assert.equal(stopCalls, 1);
});

test("a stream longer than its window still sends only what changed", { timeout: 20_000 }, async t => {
  const { base } = await server(t);
  const stream = connect(t, base);
  await stream.opened;
  const turns = 27; // Two entries a turn: past the 50-entry window, so its oldest entries drop.
  for (let turn = 0; turn < turns; turn++) await post(base, { content: `turn ${turn}` });
  const last = await until(() => stream.state(), candidate => candidate !== undefined && idleWith(turns * 2)(candidate));
  assert.ok(last);
  assert.ok(stream.frames.slice(1).every(frame => frame.type === "update"));
  assert.equal(lines(last).length, turns * 2);
  assert.equal(new Set(last.entries.map(entry => entry.id)).size, last.entries.length);
  const newest = await page(base);
  assert.equal(newest.entries.length, 50);
  assert.deepEqual(last.entries.slice(-50), newest.entries);
});

test("an entry that changes in place, or a window that moved back, resends the whole snapshot", () => {
  const entry = (id: number, text = "x") => ({ id, model: [{ role: "user", content: text }] });
  const view = (...entries: unknown[]) => ({ conversation: { id: 1 }, entries, docs: {} }) as unknown as Parameters<typeof streamUpdate>[0];
  const [one, two, three] = [entry(1), entry(2), entry(3)];
  const grown = streamUpdate(view(one, two), view(two, three));
  assert.ok(grown.type === "update" && !("entries" in grown) && !("before" in grown));
  assert.deepEqual(grown.appended, [three]);
  assert.deepEqual(streamUpdate(view(), view(one)).type, "update");
  assert.equal(streamUpdate(view(one, two), view(one, entry(2, "edited"), three)).type, "state");
  assert.equal(streamUpdate(view(two, three), view(one, two, three)).type, "state");
});

test("a folded watch that skipped entries resets the page and its history cursor", () => {
  const window = (start: number, before?: number) => ({
    conversation: { id: 1 }, docs: {}, before,
    entries: Array.from({ length: 50 }, (_, i) => ({ id: start + i })),
  }) as unknown as Parameters<typeof streamUpdate>[0];
  const previous = window(1);
  // Entry IDs can have holes: the predecessor, not the distance between IDs, proves continuity.
  assert.equal(streamUpdate(previous, window(101, 50)).type, "update");
  const frame = streamUpdate(previous, window(101, 100));
  assert.equal(frame.type, "state");
  assert.equal(frame.before, 101);
  assert.equal(frame.entries.length, 50);
});

test("closing mid-answer with a send stream open is not reported as a stream failure", async t => {
  const running = await server(t);
  const { submissionId } = await (await post(running.base, { content: "x".repeat(900) })).json() as { submissionId: number };
  const stream = connect(t, running.base, `?submissionId=${submissionId}`);
  await until(() => stream.state(), candidate => candidate?.live.generation !== undefined);
  const logged = t.mock.method(console, "error", () => {});
  await running.close();
  await sleep(50);
  assert.deepEqual(logged.mock.calls.map(call => String(call.arguments[0])), []);
});

test("a stream whose client stops answering pings is dropped; a live one stays", async t => {
  const { base } = await server(t, undefined, 100);
  const silent = connect(t, base, "", { autoPong: false });
  const live = connect(t, base);
  await Promise.all([silent.opened, live.opened]);
  await once(silent.ws, "close", { signal: AbortSignal.timeout(2_000) });
  await sleep(350);
  assert.equal(live.ws.readyState, live.ws.OPEN);
});

test("a frame that cannot be written ends the stream without reporting a failure", async t => {
  const { base } = await server(t);
  const logged = t.mock.method(console, "error", () => {});
  // The server's sockets are this class too; the test clients never send.
  const write = WebSocket.prototype.send as (this: WebSocket, data: string, done: (error?: Error) => void) => void;
  let failAt = 0, sends = 0;
  t.mock.method(WebSocket.prototype, "send", function (this: WebSocket, data: string, done: (error?: Error) => void) {
    if (++sends === failAt) done(new Error("write ECANCELED"));
    else write.call(this, data, done);
  });
  for (const frame of [1, 2]) { // The attachment snapshot, then the first update, sent from the watch listener.
    [failAt, sends] = [frame, 0];
    const client = connect(t, base);
    await client.opened;
    const closed = once(client.ws, "close", { signal: AbortSignal.timeout(3_000) });
    if (frame === 2) await post(base, { content: "change" });
    await closed;
    assert.equal(client.frames.length, frame - 1);
  }
  await until(() => page(base), idleWith(2));
  assert.deepEqual(logged.mock.calls.map(call => call.arguments.map(String).join(" ")), []);
});

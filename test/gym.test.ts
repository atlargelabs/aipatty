import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { startApi } from "../src/api.ts";
import { BranchDoc } from "../src/branches.ts";
import { openHost } from "../src/host.ts";
import { openModels } from "../src/models.ts";
import { appEntryKind, messageText, operatorText, type ConversationPage } from "../src/protocol.ts";
import { checkout, fauxConfig, fixture } from "./helpers.ts";

const gymPath = "/apps/gym/";
const health = { ok: true as const, commit: "test", startedAt: "now", version: "0" };

async function start(t: TestContext, dir: string) {
  const host = await openHost(fauxConfig(dir));
  const api = await startApi(host, health, 0);
  const base = `http://127.0.0.1:${api.port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await api.close();
    await host.close();
  };
  t.after(close);
  const branchPath = (id: number | "root") => `/api/conversations/${id}`;
  const request = (path: string, method = "GET", body?: unknown, headers?: Record<string, string>) => fetch(base + path, {
    method, headers: { ...body === undefined ? {} : { "Content-Type": "application/json" }, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const message = (id: number | "root", content: string) => request(branchPath(id) + "/messages", "POST", { content });
  const page = async (id: number | "root") => (await (await request(branchPath(id))).json()) as ConversationPage & { branch: { app?: string } };
  const fork = async (id: number | "root", title: string, at?: number) => {
    const response = await request(branchPath(id) + "/fork", "POST", { title, at });
    assert.equal(response.status, 201);
    return (await response.json() as { id: number }).id;
  };
  const command = async (id: number | "root", content: string) => {
    const response = await message(id, content);
    assert.equal(response.status, 202);
    const { appNotice, submissionId } = await response.json() as { appNotice: string; submissionId?: number };
    assert.equal(submissionId, undefined);
    assert.ok(appNotice);
    return appNotice;
  };
  const wait = async (id: SubmissionId) => {
    const submission = (await host.harness.submission(id, ctx))!;
    const result = await submission.wait(withAbortSignal(AbortSignal.timeout(8_000), ctx));
    assert.equal(result.status, "done");
  };
  const send = async (id: number | "root", content: string) => {
    const response = await message(id, content);
    assert.equal(response.status, 202);
    await wait((await response.json() as { submissionId: SubmissionId }).submissionId);
  };
  const tool = async (id: number | "root", name: string, args: object) => {
    await send(id, `call ${name} ${JSON.stringify(args)}`);
    const result = (await page(id)).entries.flatMap(entry => entry.model ?? []).findLast(message => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    assert.equal(result.toolName, name);
    return { error: result.isError, text: messageText(result) };
  };
  return { host, api, base, request, message, page, fork, command, wait, send, tool, close };
}

const workout = {
  date: "2026-11-24",
  sets: [
    { exercise: "Back squat", reps: 5, amount: 60, unit: "kg" },
    { exercise: "Plank", amount: 1.5, unit: "min" },
  ],
};
const workoutsPath = gymPath + "api/workouts";
const overviewPath = gymPath + "api/overview";
const query = { sql: "SELECT count(*) AS n FROM workouts" };

async function assertSelection(host: Awaited<ReturnType<typeof openHost>>, id: number | "root", attached: boolean) {
  const target = (await host.conversation(String(id)))!;
  const { messages } = await target.context(ctx);
  const tools = getCurrentTools(messages).map(tool => tool.name);
  assert.ok(tools.includes("list_branches") && tools.includes("codemode") && tools.includes("tool_search"));
  assert.deepEqual(tools.filter(tool => tool.startsWith("gym_")).sort(),
    attached ? ["gym_delete_workout", "gym_query", "gym_save_plan", "gym_save_workout"] : []);
  assert.equal(getCurrentSystemPrompt(messages).includes("Steve's workout coach"), attached);
}

test("Gym phone and coach share one log, with an explicit idle-only attachment that follows forks", { timeout: 40_000 }, async t => {
  const actual = await start(t, await fixture(t));
  const { base, host, request, message, page, fork, command, send, tool } = actual;
  const phone = await request(gymPath);
  assert.equal(phone.status, 200);
  assert.equal(phone.headers.get("content-security-policy"), (await request("/")).headers.get("content-security-policy"));
  assert.equal(phone.headers.get("x-content-type-options"), "nosniff");
  const phoneWorkout = workoutsPath + "/phone-1";
  assert.equal((await request(phoneWorkout, "PUT", workout, { Origin: "https://foreign.example" })).status, 403);
  const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
    get(base + gymPath, { headers: { Host: "foreign.example" } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal((await request(phoneWorkout, "PUT", workout, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await request(phoneWorkout, "POST", workout)).status, 405);
  assert.equal((await request(phoneWorkout, "PUT", { ...workout, date: "2026-02-30" })).status, 400);
  assert.deepEqual(await (await request(overviewPath)).json(), { latestWorkout: null, plan: "" });
  for (let i = 0; i < 2; i++) assert.equal((await request(phoneWorkout, "PUT", workout, { Origin: base })).status, 200);

  assert.match(await command("root", "/connect"), /Connected app: none.*gym \(Gym\) — available/s);
  assert.equal((await tool("root", "gym_query", query)).error, true);
  assert.match((await tool("root", "tool_search", { query: "gym_query" })).text, /No matching tools/);
  const discovery = await tool("root", "codemode", {
    code: 'console.log((await searchTools("gym_query")).some(tool => tool.name.startsWith("gym_"))); await tools.gym_query({sql:"SELECT 1"});',
  });
  assert.equal(discovery.error, true, discovery.text);
  assert.match(discovery.text, /<console_output>\s*false\s*<\/console_output>.*tools\.gym_query does not exist/s);
  assert.match(discovery.text, /No tool calls were made/);
  await assertSelection(host, "root", false);

  const id = await fork("root", "Training");
  await send(id, "before attaching");
  const earlier = (await page(id)).entries.at(-1)!.id;
  assert.match(await command(id, "/connect gym"), /Connected.*Gym/);
  assert.match(await command(id, " /connect\t gym "), /Connected.*Gym/);
  assert.match(await command(id, "/connect other"), /Run \/disconnect gym/);
  assert.equal((await page(id)).branch.app, "gym");
  const active = await message(id, "busy ".repeat(160));
  assert.equal(active.status, 202);
  assert.equal((await message(id, "/disconnect gym")).status, 409);
  assert.equal((await message(id, "/connect gym")).status, 409);
  assert.match(await command(id, "/connect"), /Connected app: gym/);
  assert.equal((await request(`/api/conversations/${id}/abort`, "POST", {})).status, 200);

  const joined = await tool(id, "gym_query", {
    sql: `SELECT w.id, count(*) AS sets FROM workouts w JOIN sets s ON s.workout_id=w.id GROUP BY w.id`,
  });
  assert.deepEqual(JSON.parse(joined.text), { columns: ["id", "sets"], rows: [["phone-1", 2]], truncated: false });
  await assertSelection(host, id, true);
  const nested = await tool(id, "codemode", { code: 'console.log(await tools.gym_query({sql: "SELECT count(*) AS n FROM workouts"}));' });
  assert.match(nested.text, /"rows":\[\[1\]\]/);
  assert.equal((await tool(id, "gym_query", { sql: "DELETE FROM workouts RETURNING id" })).error, true);
  assert.equal((await tool(id, "gym_save_plan", { plan: "Add 2.5 kg next week.\nRest on Friday." })).error, false);
  assert.equal((await tool(id, "gym_save_workout", { id: "coach-1", ...workout, date: "2026-11-25" })).error, false);
  const edited = { ...workout, date: "2026-11-26", sets: [{ ...workout.sets[0], amount: 62.5 }, workout.sets[1]] };
  assert.equal((await request(phoneWorkout, "PUT", edited)).status, 200);
  assert.deepEqual(await (await request(overviewPath)).json(), {
    latestWorkout: { id: "phone-1", ...edited, sets: [edited.sets[0], { ...edited.sets[1], reps: null }] },
    plan: "Add 2.5 kg next week.\nRest on Friday.",
  });

  // Fork at a point *before* the parent attached: use the current marker, not Durable's historical AgentDoc.
  const copy = await fork(id, "Same log", earlier);
  assert.equal((await page(copy)).branch.app, "gym");
  assert.equal(JSON.parse((await tool(copy, "gym_query", query)).text).rows[0][0], 2);
  assert.equal((await tool(copy, "gym_delete_workout", { id: "coach-1" })).error, false);
  assert.equal((await (await request(workoutsPath)).json() as { workouts: unknown[] }).workouts.length, 1);
  assert.equal((await request(phoneWorkout, "DELETE")).status, 200);
  assert.equal((await request(phoneWorkout, "DELETE")).status, 200);
  assert.equal((await request(phoneWorkout)).status, 404, "an old recent-workout card cannot open a deleted workout");

  const attachedPoint = (await page(id)).entries.at(-1)!.id;
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, [
    join(checkout, "src", "cli.ts"), "--port", String(actual.api.port), "--branch", String(id), ...args,
  ], { timeout: 8_000 });
  assert.match((await cli("send", "/disconnect gym")).stdout, /Disconnected Gym/);
  assert.match((await cli("log", "--limit", "1")).stdout, /app: Disconnected Gym/);
  assert.match(await command(id, "/disconnect gym"), /not connected/);
  assert.equal((await page(id)).branch.app, undefined);
  assert.equal((await tool(id, "gym_query", query)).error, true);
  assert.ok((await page(id)).entries.some(entry => entry.model?.some(msg => msg.role === "toolResult" && msg.toolName === "gym_save_workout")));
  await assertSelection(host, id, false);
  const ordinary = await fork(id, "No historical grant", attachedPoint);
  assert.equal((await page(ordinary)).branch.app, undefined);
  assert.equal((await tool(ordinary, "gym_query", query)).error, true);
  assert.deepEqual(await (await request(overviewPath)).json(), { latestWorkout: null, plan: "Add 2.5 kg next week.\nRest on Friday." });
});

test("a Gym outage leaves chat usable, bypasses queued work before resume, and retains the attachment", { timeout: 25_000 }, async t => {
  const dir = await fixture(t);
  const first = await start(t, dir);
  const id = await first.fork("root", "Training");
  await first.command(id, "/connect gym");
  await first.request(workoutsPath + "/lasting", "PUT", workout);
  assert.equal((await first.tool(id, "gym_query", query)).error, false);
  await first.close();

  const config = fauxConfig(dir);
  const paused = await Harness.open(await openNodeSqliteStorage(join(dir, "aipatty.sqlite")), {
    models: await openModels(config), registry: createRegistry(),
  }, ctx);
  const branch = (await paused.conversation(id as ConversationId, ctx))!;
  const queued = await branch.commit(tx => branch.submit(tx, { type: "input", content: `call gym_query ${JSON.stringify(query)}` }), ctx);
  await paused.close(ctx);

  const dbPath = join(dir, "apps", "gym", "gym.sqlite");
  await rename(dbPath, dbPath + ".good");
  await writeFile(dbPath, "not a SQLite file");
  const fallback = await start(t, dir);
  await fallback.wait(queued);
  assert.equal((await fallback.request(gymPath)).status, 503);
  const state = await fallback.page(id);
  assert.equal(state.branch.app, undefined);
  assert.equal((await fallback.host.harness.snapshot(BranchDoc, branch.id, ctx))?.app, "gym");
  assert.match(await fallback.command(id, "/connect"), /Connected app: gym.*unavailable.*apps.*gym.*server stderr/s);
  await assertSelection(fallback.host, id, false);
  const result = state.entries.flatMap(entry => entry.model ?? []).findLast(msg => msg.role === "toolResult");
  assert.ok(result?.role === "toolResult" && result.isError);
  await fallback.send(id, "still normal chat");
  const notices = (await fallback.page(id)).entries.filter(entry => entry.kind === appEntryKind && operatorText(entry)?.includes("using normal chat"));
  assert.equal(notices.length, 1);
  const copy = await fallback.fork(id, "Fork while unavailable");
  assert.equal((await fallback.page(copy)).branch.app, undefined);
  await fallback.close();

  await rename(dbPath + ".good", dbPath);
  const restored = await start(t, dir);
  assert.equal((await restored.page(id)).branch.app, "gym");
  assert.equal((await restored.page(copy)).branch.app, "gym");
  assert.equal(JSON.parse((await restored.tool(id, "gym_query", query)).text).rows[0][0], 1);
  // A request-time exception does not affect health or the following chat turn.
  const writer = new DatabaseSync(dbPath);
  try { writer.exec("DROP TABLE plan"); } finally { writer.close(); }
  const response = await restored.request(overviewPath);
  assert.equal(response.status, 500);
  assert.match((await response.json() as { error: string }).error, /Gym request failed: no such table: plan/);
  assert.equal((await restored.request("/health")).status, 200);
  await restored.send(copy, "chat after a failed page request");
});

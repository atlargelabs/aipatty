import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { contentText, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { openQuery } from "../src/apps/gym/query.ts";
import { openGymStore } from "../src/apps/gym/store.ts";
import { openGymTools } from "../src/apps/gym/tools.ts";
import { steps } from "../src/apps/gym/web.ts";
import { derive } from "../src/web/cards.ts";
import { fixture } from "./helpers.ts";

const squat = { exercise: "Squat", reps: 5, amount: 60, unit: "kg" };
const plank = { exercise: "Plank", amount: 60, unit: "sec" };
const lift = { id: "lift-1", date: "2024-02-29", sets: [squat, plank] };
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function open(t: TestContext) {
  const store = openGymStore(await fixture(t));
  t.after(() => store.close());
  return store;
}

test("Gym persists retryable whole workout replacements and one current suggestion", async t => {
  const dir = await fixture(t);
  let store = openGymStore(dir);
  t.after(() => store.close());
  assert.deepEqual(store.overview(), { workouts: [], exercises: [], suggestion: null });
  store.saveWorkout(lift);
  const retry = store.saveWorkout(lift);
  assert.equal(retry.sets[1].reps, null);
  assert.deepEqual(plain(store.workout(lift.id)), retry);
  const edited = store.saveWorkout({ ...lift, date: "2024-03-01", sets: [{ ...plank, amount: 1, unit: "min" }] });
  const now = new Date("2025-03-10T04:00:00Z");
  store.saveSuggestion({ note: "Old", sets: [plank] }, now);
  const suggestion = store.saveSuggestion({ note: "Steady reps.\nThen plank.", sets: [squat, plank] }, now);
  assert.deepEqual(suggestion, { created: "2025-03-10", note: "Steady reps.\nThen plank.", sets: [squat, { ...plank, reps: null }] });
  store.close();

  store = openGymStore(dir);
  assert.deepEqual(plain(store.overview()), { workouts: [edited], exercises: ["Plank"], suggestion });
  assert.equal(store.saveSuggestion({ note: "", sets: [] }), null);
  assert.equal(store.overview().suggestion, null);
  assert.deepEqual(store.deleteWorkout(lift.id), { id: lift.id, deleted: true });
  assert.deepEqual(store.deleteWorkout(lift.id), { id: lift.id, deleted: false });
  assert.equal(store.workout(lift.id), undefined);
  assert.deepEqual(store.overview().exercises, []); // cascade removed the sets, too
});

test("Gym completion and last session search all workouts, not only the 20 shown", async t => {
  const store = await open(t);
  const deadlift = { ...squat, exercise: "Steve's deadlift", amount: 0 };
  const sets = [deadlift, plank, { ...deadlift, exercise: "STEVE'S DEADLIFT", amount: 10 }];
  store.saveWorkout({ id: "oldest", date: "2023-12-31", sets: [{ ...deadlift, amount: 5 }] });
  store.saveWorkout({ id: "older", date: "2024-01-01", sets: [{ ...deadlift, amount: 15 }] });
  store.saveWorkout({ id: "later-insert", date: "2024-01-01", sets });
  for (let i = 1; i <= 21; i++) {
    store.saveWorkout({ id: "recent-" + i, date: "2024-02-" + String(i).padStart(2, "0"), sets: [squat] });
  }
  const { workouts, exercises } = store.overview();
  assert.equal(workouts.length, 20);
  assert.equal(workouts[0].id, "recent-21");
  assert.deepEqual(exercises.map(name => name.toLowerCase()), ["plank", "squat", "steve's deadlift"]);
  assert.deepEqual(plain(store.lastSession("  steve's deadlift ")), { date: "2024-01-01", sets: [sets[0], sets[2]] });
  assert.equal(store.lastSession("Press"), null);
  store.deleteWorkout("later-insert");
  assert.equal(store.lastSession(deadlift.exercise)?.sets[0].amount, 15);
});

test("Gym validates dates and sets and rolls back if a replacement fails partway", async t => {
  const store = await open(t);
  const original = store.saveWorkout(lift);
  assert.throws(() => store.saveWorkout({ ...lift, id: "../other" }), /Workout\.id/);
  assert.throws(() => store.saveWorkout({ ...lift, date: "2025-02-29" }), /real workout date/);
  assert.throws(() => store.saveWorkout({ ...lift, sets: [] }), /Workout\.sets/);
  assert.throws(() => store.saveWorkout({ ...lift, sets: [{ ...squat, reps: null }] }), /reps for a weight set/);
  assert.throws(() => store.saveWorkout({ ...lift, sets: [{ ...squat, amount: Infinity }] }), /Workout\.sets/);
  assert.throws(() => store.saveWorkout({ ...lift, sets: [{ ...plank, amount: 0 }] }), /time greater than zero/);
  assert.throws(() => store.saveSuggestion({ note: "", sets: [{ ...squat, exercise: " " }] }), /Suggestion\.sets/);

  // Fail after the workout row and its first set were replaced.
  const db = new DatabaseSync(store.path);
  try {
    db.exec(`CREATE TRIGGER reject_second_set BEFORE INSERT ON sets
      WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
  } finally { db.close(); }
  assert.throws(() => store.saveWorkout({ ...lift, date: "2024-03-01", sets: [plank, squat] }), /fixture failure/);
  assert.deepEqual(plain(store.workout(lift.id)), original);
});

test("Gym SQL runs ordinary analytics without a table/function list and bounds Markdown results", async t => {
  const store = await open(t);
  store.saveWorkout({ ...lift, sets: Array.from({ length: 11 }, () => squat) });
  const query = openQuery(store.path);
  t.after(query.close);
  const run = query.run;
  assert.equal(run(` /* comment */ WITH kg AS (SELECT amount, reps FROM sets WHERE unit = 'kg')
    SELECT ROUND(SUM(amount * reps)) AS volume, COUNT(*) AS sets FROM kg; -- done`),
  "| volume | sets |\n| --- | --- |\n| 3300.0 | 11 |".replace("3300.0", "3300"));
  assert.match(run("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<3) SELECT sum(x) FROM n"), /\| 6 \|/);
  assert.match(run("SELECT json_group_array(name) FROM sqlite_schema WHERE type = 'table'"), /workouts.*sets.*suggestion/);
  assert.match(run("SELECT value FROM json_each('[123]')"), /\| 123 \|/);
  assert.match(run("SELECT 9007199254740993 AS exact, X'41' AS blob, NULL, 'a|b'"), /\| 9007199254740993 \| 0x41 \| NULL \| a\\\|b \|/);
  const many = run("SELECT a.amount FROM sets a CROSS JOIN sets b");
  assert.equal(many.split("\n").filter(line => line === "| 60 |").length, 100);
  assert.match(many, /truncated after 100 rows/);
  assert.doesNotMatch(run("SELECT a.amount FROM sets a CROSS JOIN sets b LIMIT 100"), /truncated/);
  const bulky = run("SELECT hex(zeroblob(4096)) FROM sets");
  assert.match(bulky, /truncated for size/);
  assert.ok(Buffer.byteLength(bulky) < 33 * 1024);
  assert.match(run("SELECT * FROM sets WHERE 0"), /No rows matched/);
});

test("Gym SQL rejects writes, statements after a SELECT, and attachment effects", async t => {
  const store = await open(t);
  store.saveWorkout(lift);
  const query = openQuery(store.path);
  t.after(query.close);
  const absent = join(store.path, "..", "absent.sqlite");
  for (const sql of [
    "SELECT 1; SELECT 2", "SELECT 1; /* first */ SELECT 2; /* second */", "SELECT 1\0; SELECT 2", "-- no statement",
    "PRAGMA table_info(sets)", "EXPLAIN SELECT 1", "SELECT * FROM pragma_journal_mode('WAL')",
    "WITH one AS (SELECT 1) DELETE FROM sets RETURNING exercise", "UPDATE workouts SET date='2024-01-01'", "CREATE TEMP TABLE scratch(id)",
    `ATTACH DATABASE '${absent}' AS scratch`, `SELECT 1; ATTACH DATABASE '${absent}' AS scratch`, `VACUUM INTO '${absent}'`,
    "SELECT load_extension('not-a-library')",
  ]) assert.throws(() => query.run(sql), Error, sql);
  assert.equal(existsSync(absent), false);
  assert.match(query.run("SELECT COUNT(*) FROM sets"), /\| 2 \|/);
});

test("Gym durable tools record the request on success and failure; only suggestions write", { timeout: 10_000 }, async t => {
  const store = await open(t);
  store.saveWorkout(lift);
  const { tools, close } = openGymTools(store);
  t.after(close);
  assert.deepEqual(tools.map(tool => tool.name), ["gym_query", "gym_suggest_workout"]);
  const registry = createRegistry();
  registry.install({ name: "gym", tools });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  t.after(() => harness.close(ctx));
  const model = faux.getModel();
  const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const call = (name: string, id: string, args: Parameters<typeof fauxToolCall>[1]) => fauxToolCall(name, args, { id });
  const query = "SELECT amount AS load FROM sets WHERE exercise = 'squat'";
  const badQuery = "SELECT missing FROM workouts";
  faux.setResponses([
    fauxAssistantMessage([
      call("gym_query", "read", { sql: query }), call("gym_query", "bad-sql", { sql: badQuery }),
      call("gym_query", "malformed-sql", { sql: 42 }), call("gym_query", "missing-sql", {}),
      call("gym_suggest_workout", "suggest", { note: "Keep it easy.", sets: [plank] }),
      call("gym_suggest_workout", "bad-sets", { note: "Bad plan", sets: [{ ...plank, amount: 0 }] }),
      call("gym_suggest_workout", "malformed-sets", { sets: "not an array" }),
    ], { stopReason: "toolUse" }), fauxAssistantMessage("Done."),
  ]);
  assert.equal((await (await root.submit({ type: "input", content: "Check and suggest." }, ctx)).wait(ctx)).status, "done");
  const entries = (await root.entries({}, 50, undefined, ctx)).items.toReversed();
  const results = entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult");
  const result = (id: string, error: boolean) => {
    const message = results.find(message => message.toolCallId === id);
    assert.ok(message, id);
    assert.equal(message.isError, error, contentText(message.content));
    return contentText(message.content);
  };
  assert.ok(result("read", false).includes(query));
  assert.match(result("read", false), /\| load \|\n\| --- \|\n\| 60 \|/);
  assert.ok(result("bad-sql", true).includes(badQuery));
  assert.match(result("malformed-sql", true), /SQL:\n42/);
  assert.match(result("missing-sql", true), /not provided/);
  assert.match(result("suggest", false), /\| Plank \| — \| 60 \| sec \|/);
  assert.match(result("bad-sets", true), /"exercise":"Plank".*"amount":0/);
  assert.match(result("malformed-sets", true), /Requested sets:\nnot an array/);
  assert.equal(store.overview().suggestion?.note, "Keep it easy.");
  assert.equal(store.overview().workouts.length, 1);

  // Use the actual saved calls and results, and simulate viewing them from a fork.
  const fork = root.id + 1;
  const { precards, surround } = derive({ branch: fork, entries, live: {} }, steps);
  assert.deepEqual(surround.header, [{ label: "Log workout", href: `/apps/gym/?branch=${fork}` }]);
  assert.ok(precards.filter(card => card.kind === "toolCall").every(card => card.hidden));
  for (const card of precards) {
    if (card.kind !== "toolResult") continue;
    assert.equal(card.format, card.message.isError ? "text" : "markdown");
    assert.deepEqual(card.links, card.message.isError ? [] : [{ label: "Log workout", href: `/apps/gym/?branch=${fork}` }]);
  }

  faux.setResponses([
    fauxAssistantMessage(call("gym_suggest_workout", "clear", { note: "", sets: [] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Cleared."),
  ]);
  assert.equal((await (await root.submit({ type: "input", content: "Clear it." }, ctx)).wait(ctx)).status, "done");
  const clearing = (await root.entries({}, 10, undefined, ctx)).items.flatMap(entry => entry.model ?? [])
    .find(message => message.role === "toolResult" && message.toolCallId === "clear");
  assert.ok(clearing?.role === "toolResult" && !clearing.isError);
  assert.match(contentText(clearing.content), /Requested sets: `\[\]`/);
  assert.equal(store.overview().suggestion, null);
});

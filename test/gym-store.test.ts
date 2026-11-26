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

const squat = { exercise: "Squat", duration: 5, durationUnit: "reps", load: 60, loadUnit: "kg", extraReps: null };
const plank = { exercise: "Plank", duration: 60, durationUnit: "sec", load: null, loadUnit: null, extraReps: null };
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
  assert.deepEqual(retry, lift);
  assert.deepEqual(plain(store.workout(lift.id)), retry);
  const edited = store.saveWorkout({ ...lift, date: "2024-03-01", sets: [{ ...plank, duration: 1, durationUnit: "min" }] });
  const now = new Date("2025-03-10T04:00:00Z");
  store.saveSuggestion({ note: "Old", sets: [plank] }, now);
  const suggestion = store.saveSuggestion({ note: "Steady reps.\nThen plank.", sets: [squat, plank] }, now);
  assert.deepEqual(suggestion, { created: "2025-03-10", note: "Steady reps.\nThen plank.", sets: [squat, plank] });
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

test("Gym migrates historical sets and the saved suggestion without inferring load or losing reps", async t => {
  const dir = await fixture(t);
  const db = new DatabaseSync(join(dir, "gym.sqlite"));
  const legacySets = [
    { exercise: "Squat", reps: 5, amount: 60, unit: "kg" },
    { exercise: "Push-ups", reps: 8, amount: 0, unit: "lb" },
    { exercise: "Hold", reps: 3, amount: 15.5, unit: "sec" },
    { exercise: "Plank", amount: 1.5, unit: "min" },
  ];
  try {
    db.exec(`
      CREATE TABLE workouts (id TEXT PRIMARY KEY NOT NULL, date TEXT NOT NULL) STRICT;
      CREATE INDEX workouts_date ON workouts(date DESC);
      CREATE TABLE sets (
        workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE, position INTEGER NOT NULL,
        exercise TEXT NOT NULL COLLATE NOCASE, reps INTEGER, amount REAL NOT NULL,
        unit TEXT NOT NULL CHECK (unit IN ('kg', 'lb', 'sec', 'min')), PRIMARY KEY (workout_id, position)
      ) STRICT;
      CREATE INDEX sets_exercise ON sets(exercise);
      CREATE TABLE suggestion (created TEXT NOT NULL, note TEXT NOT NULL, sets TEXT NOT NULL, CHECK (rowid = 1)) STRICT;
      INSERT INTO workouts VALUES ('legacy', '2025-04-03');
    `);
    const insert = db.prepare("INSERT INTO sets VALUES ('legacy', ?, ?, ?, ?, ?)");
    legacySets.forEach((set, i) => insert.run(i, set.exercise, set.reps ?? null, set.amount, set.unit));
    db.prepare("INSERT INTO suggestion VALUES ('2025-04-04', 'Old plan', ?)").run(JSON.stringify(legacySets));
  } finally { db.close(); }

  const sets = [squat,
    { ...squat, exercise: "Push-ups", duration: 8, load: 0, loadUnit: "lb" },
    { ...plank, exercise: "Hold", duration: 15.5, extraReps: 3 },
    { ...plank, duration: 1.5, durationUnit: "min" },
  ];
  const expected = { id: "legacy", date: "2025-04-03", sets };
  let store = openGymStore(dir);
  t.after(() => store.close());
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(plain(store.workout("legacy")), expected);
    assert.deepEqual(plain(store.lastSession("hOLD")), { date: expected.date, sets: [sets[2]] });
    assert.deepEqual(plain(store.overview().suggestion), { created: "2025-04-04", note: "Old plan", sets });
    if (i === 0) { store.close(); store = openGymStore(dir); }
  }
  assert.deepEqual(store.saveWorkout(plain(store.workout("legacy"))), expected, "editing round-trips historical extras");
  store.deleteWorkout("legacy");
  assert.deepEqual(store.overview().exercises, []);
});

test("Gym round-trips independent duration and load, and defaults an unspecified unit to reps", async t => {
  const store = await open(t);
  const sets = [
    { ...squat, duration: 8 },
    { ...squat, duration: 15, durationUnit: "sec" },
    { ...squat, exercise: "Carry", duration: 20.25, durationUnit: "m" },
    { ...plank, duration: 0.5, durationUnit: "min" },
  ];
  const input = [{ exercise: " Squat ", duration: 8, load: 60, loadUnit: "kg" }, ...sets.slice(1)];
  assert.deepEqual(store.saveWorkout({ ...lift, sets: input }).sets, sets);
  assert.deepEqual(plain(store.workout(lift.id)?.sets), sets);
  assert.deepEqual(plain(store.lastSession("carry")?.sets), [sets[2]]);
  assert.deepEqual(store.saveSuggestion({ note: "", sets: input })?.sets, sets);
  assert.deepEqual(store.overview().suggestion?.sets, sets);
});

test("Gym completion and last session search all workouts, not only the 20 shown", async t => {
  const store = await open(t);
  const deadlift = { ...squat, exercise: "Steve's deadlift", load: 0 };
  const sets = [deadlift, plank, { ...deadlift, exercise: "STEVE'S DEADLIFT", load: 10 }];
  store.saveWorkout({ id: "oldest", date: "2023-12-31", sets: [{ ...deadlift, load: 5 }] });
  store.saveWorkout({ id: "older", date: "2024-01-01", sets: [{ ...deadlift, load: 15 }] });
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
  assert.equal(store.lastSession(deadlift.exercise)?.sets[0].load, 15);
});

test("Gym validates dates and sets and rolls back if a replacement fails partway", async t => {
  const store = await open(t);
  const original = store.saveWorkout(lift);
  assert.throws(() => store.saveWorkout({ ...lift, id: "../other" }), /Workout\.id/);
  assert.throws(() => store.saveWorkout({ ...lift, date: "2025-02-29" }), /real workout date/);
  assert.throws(() => store.saveWorkout({ ...lift, sets: [] }), /Workout\.sets/);
  const saveSet = (set: unknown) => store.saveWorkout({ ...lift, sets: [set] });
  assert.throws(() => saveSet({ exercise: "Squat", duration: 1.5 }), /whole rep count/);
  assert.throws(() => saveSet({ ...squat, duration: 1001 }), /whole rep count/);
  assert.throws(() => saveSet({ ...squat, duration: Infinity }), /Workout\.sets/);
  assert.throws(() => saveSet({ ...plank, duration: 0 }), /Workout\.sets.*duration/);
  assert.throws(() => saveSet({ ...plank, duration: -0.1, durationUnit: "m" }), /Workout\.sets.*duration/);
  assert.throws(() => saveSet({ ...plank, durationUnit: "kg" }), /Workout\.sets.*durationUnit/);
  assert.throws(() => saveSet({ ...squat, loadUnit: null }), /both load and its kg or lb unit/);
  assert.throws(() => saveSet({ ...plank, loadUnit: "lb" }), /both load and its kg or lb unit/);
  assert.throws(() => saveSet({ ...plank, load: 10, loadUnit: "sec" }), /Workout\.sets.*loadUnit/);
  assert.throws(() => saveSet({ ...squat, extraReps: 1 }), /only for time or distance/);
  assert.throws(() => saveSet({ exercise: "Squat", reps: 5, amount: 60, unit: "kg" }), /Workout\.sets/);
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
  assert.equal(run(` /* comment */ WITH kg AS (SELECT load, duration FROM sets WHERE load_unit = 'kg' AND duration_unit = 'reps')
    SELECT ROUND(SUM(load * duration)) AS volume, COUNT(*) AS sets FROM kg; -- done`),
  "| volume | sets |\n| --- | --- |\n| 3300.0 | 11 |".replace("3300.0", "3300"));
  assert.match(run("SELECT json_group_array(name ORDER BY name) FROM sqlite_schema WHERE type = 'table'"), /sets.*suggestion.*workouts/);
  assert.match(run("SELECT value FROM json_each('[123]')"), /\| 123 \|/);
  assert.match(run("SELECT 9007199254740993 AS exact, X'41' AS blob, NULL, 'a|b'"), /\| 9007199254740993 \| 0x41 \| NULL \| a\\\|b \|/);
  const many = run("SELECT a.load FROM sets a CROSS JOIN sets b");
  assert.equal(many.split("\n").filter(line => line === "| 60 |").length, 100);
  assert.match(many, /truncated after 100 rows/);
  assert.doesNotMatch(run("SELECT a.load FROM sets a CROSS JOIN sets b LIMIT 100"), /truncated/);
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
  // A recursive query can run forever on the server's only thread.
  assert.throws(() => query.run("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT count(*) FROM n"), /WITH RECURSIVE is not allowed/);
  assert.equal(existsSync(absent), false);
  assert.match(query.run("SELECT COUNT(*) FROM sets"), /\| 2 \|/);
});

test("Gym durable tools declare typed arguments, report failures, and only suggestions write", { timeout: 10_000 }, async t => {
  const store = await open(t);
  store.saveWorkout(lift);
  const { tools, close } = openGymTools(store);
  t.after(close);
  assert.deepEqual(tools.map(tool => tool.name), ["gym_query", "gym_suggest_workout"]);
  assert.ok(tools.every(tool => tool.replay !== "safe"), "an interrupted call is reported, not rerun at startup");
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
  const query = "SELECT load FROM sets WHERE exercise = 'squat'";
  const weighted = { ...plank, duration: 15, load: 60, loadUnit: "kg" };
  const badQuery = "SELECT missing FROM workouts";
  faux.setResponses([
    fauxAssistantMessage([
      call("gym_query", "read", { sql: query }), call("gym_query", "bad-sql", { sql: badQuery }),
      call("gym_query", "malformed-sql", { sql: 42 }), call("gym_query", "missing-sql", {}),
      call("gym_suggest_workout", "suggest", { note: "Keep it easy.", sets: [weighted] }),
      call("gym_suggest_workout", "bad-sets", { note: "Bad plan", sets: [{ ...plank, load: 60 }] }),
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
  assert.equal(result("read", false), "| load |\n| --- |\n| 60 |");
  assert.match(result("bad-sql", true), /no such column: missing/);
  // The declared schema rejects these before the tool runs.
  result("malformed-sql", true);
  result("missing-sql", true);
  assert.match(result("suggest", false), /Keep it easy\.\n\n.*\| Plank \| 15 sec \| 60 kg \| — \|/s);
  assert.match(result("bad-sets", true), /Set 1: provide both load and its kg or lb unit/);
  result("malformed-sets", true);
  assert.equal(store.overview().suggestion?.note, "Keep it easy.");
  assert.deepEqual(store.overview().suggestion?.sets, [weighted]);
  assert.equal(store.overview().workouts.length, 1);

  // Use the actual saved calls and results, and simulate viewing them from a fork.
  const fork = root.id + 1;
  const { precards, surround } = derive({ branch: fork, entries, live: {} }, steps);
  assert.deepEqual(surround.header, [{ label: "Log workout", href: `/apps/gym/?branch=${fork}` }]);
  assert.ok(precards.every(card => !card.hidden), "the call card shows what was asked");
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
  assert.match(contentText(clearing.content), /Cleared the current suggestion/);
  assert.equal(store.overview().suggestion, null);
});

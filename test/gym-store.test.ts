import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openGymStore } from "../src/apps/gym/store.ts";
import { fixture } from "./helpers.ts";

const squat = { exercise: "Squat", reps: 5, amount: 60, unit: "kg" };
const plank = { exercise: "Plank", amount: 60, unit: "sec" };
const lift = { id: "lift-1", date: "2024-02-29", sets: [squat, plank] };

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

test("Gym retries, edits, persists and deletes whole workouts", async t => {
  const dir = await fixture(t);
  let store = openGymStore(dir);
  t.after(() => store.close());
  assert.deepEqual(store.overview(), { latestWorkout: null, plan: "" });
  store.saveWorkout(lift);
  store.saveWorkout(lift);
  const edited = store.saveWorkout({ ...lift, sets: [{ ...squat, amount: 62.5 }, plank] });
  assert.equal(edited.sets[1].reps, null);

  store.saveWorkout({ id: "bodyweight", date: "2024-01-01", sets: [{ ...squat, exercise: "squat", amount: 0 }] });
  assert.deepEqual(store.workouts().exercises.map(exercise => exercise.toLowerCase()), ["plank", "squat"]);
  store.savePlan({ plan: "<b>Squat</b>\nThen plank for 1 min." });
  store.close();

  store = openGymStore(dir);
  assert.deepEqual(plain(store.overview()), { latestWorkout: edited, plan: "<b>Squat</b>\nThen plank for 1 min." });
  assert.equal(store.workouts().workouts.length, 2);
  assert.deepEqual(store.deleteWorkout({ id: lift.id }), { id: lift.id, deleted: true });
  assert.deepEqual(store.deleteWorkout({ id: lift.id }), { id: lift.id, deleted: false });
  assert.deepEqual(store.query({ sql: "SELECT count(*) FROM sets WHERE workout_id = 'lift-1'" }).rows, [[0]]);
  assert.equal(store.overview().latestWorkout?.id, "bodyweight");
});

test("Gym rejects invalid drafts and rolls back a failed replacement", async t => {
  const dir = await fixture(t);
  const store = openGymStore(dir);
  t.after(() => store.close());
  const original = store.saveWorkout(lift);
  assert.throws(() => store.saveWorkout({ ...lift, date: "2025-02-29" }), /real workout date/);
  assert.throws(() => store.saveWorkout({ ...lift, id: "foo/bar" }), /Invalid workout\.id/);
  assert.throws(() => store.saveWorkout({ ...lift, sets: [{ ...squat, reps: null }] }), /reps for a weight set/);
  assert.throws(() => store.saveWorkout({ ...lift, sets: [{ ...plank, amount: 0 }] }), /time greater than zero/);
  assert.throws(() => store.saveWorkout({ ...lift, sets: [] }), /Invalid workout\.sets/);
  assert.throws(() => store.saveWorkout({ ...lift, sets: [{ ...squat, amount: Infinity }] }), /Invalid workout\.sets/);
  assert.throws(() => store.savePlan({ plan: "x".repeat(8_001) }), /Invalid plan/);

  // Cause a failure after the old sets were deleted and the first replacement set inserted.
  const fixtureDb = new DatabaseSync(join(dir, "gym.sqlite"));
  try {
    fixtureDb.exec(`CREATE TRIGGER reject_second_set BEFORE INSERT ON sets
      WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
  } finally { fixtureDb.close(); }
  assert.throws(() => store.saveWorkout({ ...lift, date: "2024-03-01", sets: [plank, squat] }), /fixture failure/);
  assert.deepEqual(plain(store.overview().latestWorkout), original);
});

test("Gym query allows analytics, caps its JSON, and cannot write or access non-Gym data", async t => {
  const dir = await fixture(t);
  const store = openGymStore(dir);
  t.after(() => store.close());
  const run = (sql: string) => store.query({ sql });
  const uncreated = join(dir, "unexpected.sqlite");
  assert.equal(existsSync(uncreated), false);
  store.saveWorkout({ ...lift, sets: Array.from({ length: 11 }, () => squat) });
  store.savePlan({ plan: "x".repeat(8_000) });

  assert.deepEqual(run(`  WITH kg AS (SELECT amount, reps FROM sets WHERE unit='kg')
    SELECT DATE('2024-02-29') AS date, ROUND(SUM(amount * reps)) AS volume, COUNT(*) AS sets FROM kg;  `),
  { columns: ["date", "volume", "sets"], rows: [["2024-02-29", 3300, 11]], truncated: false });
  assert.deepEqual(run("SELECT COUNT(*) AS n FROM workouts -- note\n").rows, [[1]]);
  assert.deepEqual(run("SELECT 9007199254740993 AS exact, X'41' AS blob").rows, [["9007199254740993", "0x41"]]);
  const many = run("SELECT a.amount FROM sets a CROSS JOIN sets b");
  assert.equal(many.rows.length, 100);
  assert.equal(many.truncated, true);
  assert.equal(run("SELECT a.amount FROM sets a CROSS JOIN sets b LIMIT 100").truncated, false);
  const bulky = run("SELECT text FROM plan CROSS JOIN sets");
  assert.equal(bulky.rows.length, 4);
  assert.equal(bulky.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bulky)) <= 32 * 1024);

  for (const sql of [
    "SELECT 1; SELECT 2", "SELECT 1; -- note", "SELECT 1\0; SELECT 2", "-- no statement",
    "SELECT name FROM sqlite_schema", "PRAGMA table_info(sets)", "SELECT * FROM pragma_table_info('sets')",
    "DELETE FROM sets RETURNING exercise", "UPDATE workouts SET date='2024-01-01'", "CREATE TEMP TABLE scratch(id)",
    `ATTACH DATABASE '${uncreated}' AS scratch`, `VACUUM INTO '${uncreated}'`,
    `SELECT readfile('${uncreated}')`, `SELECT writefile('${uncreated}', 'x')`, "SELECT load_extension('not-a-library')",
  ]) assert.throws(() => run(sql), /Gym query failed/, sql);
  assert.equal(existsSync(uncreated), false);
  assert.deepEqual(run("SELECT COUNT(*) FROM sets").rows, [[11]]);
});

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { durationUnits, exerciseName, loadUnits, readId, readSuggestion, readWorkout, type GymSet, type Suggestion, type Workout } from "./model.ts";

const recentLimit = 20;
const schema = `
  CREATE TABLE IF NOT EXISTS workouts (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workouts_date ON workouts(date DESC);
  CREATE TABLE IF NOT EXISTS suggestion (
    created TEXT NOT NULL,
    note TEXT NOT NULL,
    sets TEXT NOT NULL,
    CHECK (rowid = 1)
  ) STRICT;
`;

const sqlUnits = (units: readonly string[]) => units.map(unit => "'" + unit + "'").join(", ");
const setsTable = (table: "sets" | "sets_new") => `
  CREATE TABLE ${table} (
    workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    exercise TEXT NOT NULL COLLATE NOCASE,
    duration REAL NOT NULL CHECK (duration > 0),
    duration_unit TEXT NOT NULL CHECK (duration_unit IN (${sqlUnits(durationUnits)})),
    load REAL CHECK (load >= 0),
    load_unit TEXT CHECK (load_unit IN (${sqlUnits(loadUnits)})),
    extra_reps INTEGER,
    CHECK ((load IS NULL) = (load_unit IS NULL)),
    PRIMARY KEY (workout_id, position)
  ) STRICT;
`;
const setFields = "exercise, duration, duration_unit AS durationUnit, load, load_unit AS loadUnit, extra_reps AS extraReps";

type LegacySet = { exercise: string; reps?: number | null; amount: number; unit: "kg" | "lb" | "sec" | "min" };

function migrateSets(db: DatabaseSync) {
  const columns = db.prepare("PRAGMA table_info(sets)").all();
  if (!columns.length) db.exec(setsTable("sets"));
  if (!columns.some(column => column.name === "reps")) return;

  // A v1 amount is either weight or time, never both. Keep missing weights NULL and keep explicit zero weights.
  db.exec("BEGIN");
  try {
    db.exec(setsTable("sets_new") + `
      INSERT INTO sets_new (workout_id, position, exercise, duration, duration_unit, load, load_unit, extra_reps)
      SELECT workout_id, position, exercise,
        CASE WHEN unit IN ('kg', 'lb') THEN reps ELSE amount END,
        CASE WHEN unit IN ('kg', 'lb') THEN 'reps' ELSE unit END,
        CASE WHEN unit IN ('kg', 'lb') THEN amount END,
        CASE WHEN unit IN ('kg', 'lb') THEN unit END,
        CASE WHEN unit IN ('sec', 'min') THEN reps END
      FROM sets;
      DROP TABLE sets;
      ALTER TABLE sets_new RENAME TO sets;
    `);
    const row = db.prepare("SELECT sets FROM suggestion").get() as { sets: string } | undefined;
    if (row) {
      const sets = (JSON.parse(row.sets) as LegacySet[]).map(({ exercise, reps, amount, unit }) =>
        unit === "kg" || unit === "lb"
          ? { exercise, duration: reps, durationUnit: "reps", load: amount, loadUnit: unit, extraReps: null }
          : { exercise, duration: amount, durationUnit: unit, load: null, loadUnit: null, extraReps: reps ?? null });
      db.prepare("UPDATE suggestion SET sets = ?").run(JSON.stringify(sets));
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function openGymStore(dataDir: string) {
  const path = join(dataDir, "gym.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(schema);
    migrateSets(db);
    db.exec("CREATE INDEX IF NOT EXISTS sets_exercise ON sets(exercise)");
    const putWorkout = db.prepare(`
      INSERT INTO workouts(id, date) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET date = excluded.date
    `);
    const putSet = db.prepare(`INSERT INTO sets(workout_id, position, exercise, duration, duration_unit, load, load_unit, extra_reps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const clearSets = db.prepare("DELETE FROM sets WHERE workout_id = ?");
    const deleteWorkout = db.prepare("DELETE FROM workouts WHERE id = ?");
    const getWorkout = db.prepare("SELECT id, date FROM workouts WHERE id = ?");
    const getSets = db.prepare(`SELECT ${setFields} FROM sets WHERE workout_id = ? ORDER BY position`);
    const recent = db.prepare("SELECT id, date FROM workouts ORDER BY date DESC, rowid DESC LIMIT ?");
    const exercises = db.prepare("SELECT DISTINCT exercise FROM sets ORDER BY exercise");
    const lastWorkout = db.prepare(`
      SELECT id, date FROM workouts WHERE id IN (SELECT workout_id FROM sets WHERE exercise = ?)
      ORDER BY date DESC, rowid DESC LIMIT 1
    `);
    const lastSets = db.prepare(`
      SELECT ${setFields} FROM sets WHERE workout_id = ? AND exercise = ? ORDER BY position
    `);
    const getSuggestion = db.prepare("SELECT created, note, sets FROM suggestion");
    const putSuggestion = db.prepare("INSERT OR REPLACE INTO suggestion(rowid, created, note, sets) VALUES (1, ?, ?, ?)");
    const clearSuggestion = db.prepare("DELETE FROM suggestion");

    type WorkoutRow = Omit<Workout, "sets">;
    const withSets = ({ id, date }: WorkoutRow): Workout => ({ id, date, sets: getSets.all(id) as GymSet[] });

    return {
      path,
      overview() {
        const row = getSuggestion.get() as (Omit<Suggestion, "sets"> & { sets: string }) | undefined;
        return {
          workouts: (recent.all(recentLimit) as WorkoutRow[]).map(withSets),
          exercises: exercises.all().map(row => row.exercise as string),
          suggestion: row ? { ...row, sets: JSON.parse(row.sets) as GymSet[] } : null,
        };
      },
      lastSession(input: unknown) {
        const exercise = exerciseName(input);
        const row = lastWorkout.get(exercise) as WorkoutRow | undefined;
        return row ? { date: row.date, sets: lastSets.all(row.id, exercise) as GymSet[] } : null;
      },
      workout(input: unknown): Workout | undefined {
        const row = getWorkout.get(readId(input)) as WorkoutRow | undefined;
        return row && withSets(row);
      },
      saveWorkout(input: unknown): Workout {
        const workout = readWorkout(input);
        const { id, date, sets } = workout;
        db.exec("BEGIN");
        try {
          putWorkout.run(id, date);
          clearSets.run(id);
          sets.forEach(({ exercise, duration, durationUnit, load, loadUnit, extraReps }, position) => {
            putSet.run(id, position, exercise, duration, durationUnit, load, loadUnit, extraReps);
          });
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
        return workout;
      },
      deleteWorkout(input: unknown) {
        const id = readId(input);
        return { id, deleted: deleteWorkout.run(id).changes !== 0 };
      },
      saveSuggestion(input: unknown, now = new Date()): Suggestion | null {
        const { note, sets } = readSuggestion(input);
        if (!sets.length) {
          clearSuggestion.run();
          return null;
        }
        const created = now.toISOString().slice(0, 10);
        putSuggestion.run(created, note, JSON.stringify(sets));
        return { created, note, sets };
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export type GymStore = ReturnType<typeof openGymStore>;

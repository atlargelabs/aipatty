import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GymInputError, readDelete, readPlan, readWorkout, units, type GymSet, type Workout } from "./model.ts";
import { openQuery } from "./query.ts";

const recentLimit = 20;
const exerciseLimit = 500;
const schema = `
  CREATE TABLE IF NOT EXISTS workouts (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workouts_date ON workouts(date DESC);
  CREATE TABLE IF NOT EXISTS sets (
    workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    exercise TEXT NOT NULL,
    reps INTEGER,
    amount REAL NOT NULL,
    unit TEXT NOT NULL CHECK (unit IN (${units.map(unit => "'" + unit + "'").join(", ")})),
    PRIMARY KEY (workout_id, position)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS plan (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    text TEXT NOT NULL
  ) STRICT;
`;

export function openGymStore(dataDir: string) {
  const path = join(dataDir, "gym.sqlite");
  const db = new DatabaseSync(path);

  try {
    db.exec(schema);
    const putWorkout = db.prepare(`
      INSERT INTO workouts(id, date) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET date = excluded.date
    `);
    const deleteWorkout = db.prepare("DELETE FROM workouts WHERE id = ?");
    const clearSets = db.prepare("DELETE FROM sets WHERE workout_id = ?");
    const putSet = db.prepare("INSERT INTO sets(workout_id, position, exercise, reps, amount, unit) VALUES (?, ?, ?, ?, ?, ?)");
    const getSets = db.prepare("SELECT exercise, reps, amount, unit FROM sets WHERE workout_id = ? ORDER BY position");
    const recent = db.prepare("SELECT id, date FROM workouts ORDER BY date DESC, rowid DESC LIMIT ?");
    const distinctExercises = db.prepare(`
      SELECT DISTINCT exercise COLLATE NOCASE AS exercise FROM sets ORDER BY exercise COLLATE NOCASE LIMIT ?
    `);
    const getPlan = db.prepare("SELECT text FROM plan WHERE id = 1");
    const putPlan = db.prepare("INSERT INTO plan(id, text) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text");
    const query = openQuery(path);

    const recentWorkouts = (limit: number): Workout[] =>
      (recent.all(limit) as Pick<Workout, "id" | "date">[])
        .map(({ id, date }) => ({ id, date, sets: getSets.all(id) as GymSet[] }));

    return {
      query: query.run,
      overview() {
        return { latestWorkout: recentWorkouts(1)[0] ?? null, plan: (getPlan.get()?.text as string | undefined) ?? "" };
      },
      workouts() {
        return {
          workouts: recentWorkouts(recentLimit),
          exercises: distinctExercises.all(exerciseLimit).map(row => row.exercise as string),
        };
      },
      saveWorkout(input: unknown): Workout {
        const { id, date, sets: rawSets } = readWorkout(input);
        const parsed = new Date(date + "T00:00:00.000Z");
        if (date.startsWith("0000") || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) {
          throw new GymInputError("Use a real workout date (YYYY-MM-DD).");
        }
        const sets = rawSets.map(({ exercise, reps, amount, unit }, i): GymSet => {
          const timed = unit === "sec" || unit === "min";
          if (!timed && reps == null) throw new GymInputError(`Set ${i + 1}: enter reps for a weight set.`);
          if (timed && amount === 0) throw new GymInputError(`Set ${i + 1}: enter a time greater than zero.`);
          return { exercise: exercise.trim(), reps: reps ?? null, amount, unit };
        });
        db.exec("BEGIN");
        try {
          putWorkout.run(id, date);
          clearSets.run(id);
          sets.forEach(({ exercise, reps, amount, unit }, i) => putSet.run(id, i, exercise, reps, amount, unit));
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
        return { id, date, sets };
      },
      deleteWorkout(input: unknown) {
        const { id } = readDelete(input);
        return { id, deleted: deleteWorkout.run(id).changes !== 0 };
      },
      savePlan(input: unknown) {
        const { plan } = readPlan(input);
        putPlan.run(plan);
        return { plan };
      },
      close() {
        try { query.close(); } finally { db.close(); }
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export type GymStore = ReturnType<typeof openGymStore>;

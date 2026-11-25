import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exerciseName, readId, readSuggestion, readWorkout, units, type GymSet, type Suggestion, type Workout } from "./model.ts";

const recentLimit = 20;
const schema = `
  CREATE TABLE IF NOT EXISTS workouts (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workouts_date ON workouts(date DESC);
  CREATE TABLE IF NOT EXISTS sets (
    workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    exercise TEXT NOT NULL COLLATE NOCASE,
    reps INTEGER,
    amount REAL NOT NULL,
    unit TEXT NOT NULL CHECK (unit IN (${units.map(unit => "'" + unit + "'").join(", ")})),
    PRIMARY KEY (workout_id, position)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sets_exercise ON sets(exercise);
  CREATE TABLE IF NOT EXISTS suggestion (
    created TEXT NOT NULL,
    note TEXT NOT NULL,
    sets TEXT NOT NULL,
    CHECK (rowid = 1)
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
    const putSet = db.prepare("INSERT INTO sets(workout_id, position, exercise, reps, amount, unit) VALUES (?, ?, ?, ?, ?, ?)");
    const clearSets = db.prepare("DELETE FROM sets WHERE workout_id = ?");
    const deleteWorkout = db.prepare("DELETE FROM workouts WHERE id = ?");
    const getWorkout = db.prepare("SELECT id, date FROM workouts WHERE id = ?");
    const getSets = db.prepare("SELECT exercise, reps, amount, unit FROM sets WHERE workout_id = ? ORDER BY position");
    const recent = db.prepare("SELECT id, date FROM workouts ORDER BY date DESC, rowid DESC LIMIT ?");
    const exercises = db.prepare("SELECT DISTINCT exercise FROM sets ORDER BY exercise");
    const lastWorkout = db.prepare(`
      SELECT id, date FROM workouts WHERE id IN (SELECT workout_id FROM sets WHERE exercise = ?)
      ORDER BY date DESC, rowid DESC LIMIT 1
    `);
    const lastSets = db.prepare(`
      SELECT exercise, reps, amount, unit FROM sets WHERE workout_id = ? AND exercise = ? ORDER BY position
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
          sets.forEach(({ exercise, reps, amount, unit }, position) => {
            putSet.run(id, position, exercise, reps, amount, unit);
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

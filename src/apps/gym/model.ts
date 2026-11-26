import { arr, compile, int, nullable, num, obj, oneOf, opt, str, type Schema } from "@earendil-works/pi-schema";

export const durationUnits = ["reps", "m", "sec", "min"] as const;
export const loadUnits = ["kg", "lb"] as const;
export const maxSets = 60;
export const maxExercise = 80;
export const maxReps = 1_000;
export const maxAmount = 100_000;
const maxNote = 2_000;

export type GymSet = {
  exercise: string;
  duration: number;
  durationUnit: typeof durationUnits[number];
  load: number | null;
  loadUnit: typeof loadUnits[number] | null;
  extraReps: number | null;
};
export type Workout = { id: string; date: string; sets: GymSet[] };
export type Suggestion = { created: string; note: string; sets: GymSet[] };

export class GymInputError extends Error {}

function reader<T>(label: string, schema: Schema<T>) {
  const validator = compile(schema);
  return (input: unknown): T => {
    const result = validator.validate(input);
    if (result.ok) return result.value;
    const { path, message } = result.errors[0];
    throw new GymInputError(label + path.replaceAll("/", ".") + ": " + message);
  };
}

const id = str({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
const exercise = str({ minLength: 1, maxLength: maxExercise, pattern: "\\S" });
const set = obj({
  exercise,
  duration: num({ exclusiveMinimum: 0, maximum: maxAmount, description: "A positive measurement. Reps must be whole counts." }),
  durationUnit: opt(oneOf(durationUnits, { description: "Defaults to reps; m means metres, min means minutes." })),
  load: opt(nullable(num({ minimum: 0, maximum: maxAmount }), { description: "Optional external weight. 0 means bodyweight." })),
  loadUnit: opt(nullable(oneOf(loadUnits), { description: "Required if load is given; otherwise omit or use null." })),
  extraReps: opt(nullable(int({ minimum: 1, maximum: maxReps }), { description: "Additional recorded reps on a time or distance set, normally omitted." })),
});
const workout = reader("Workout", obj({
  id, date: str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  sets: arr(set, { minItems: 1, maxItems: maxSets }),
}));
/** The parameters of the suggestion tool, and what the store checks again before saving. */
export const suggestionSchema = obj({
  note: str({ maxLength: maxNote, description: "A short coaching note; may be empty." }),
  sets: arr(set, { maxItems: maxSets, description: "The sets in order. An empty list clears the suggestion." }),
});
const suggestion = reader("Suggestion", suggestionSchema);

function checkedSets(sets: ReturnType<typeof workout>["sets"]): GymSet[] {
  return sets.map(({ exercise, duration, durationUnit = "reps", load = null, loadUnit = null, extraReps = null }, i) => {
    const error = (message: string) => new GymInputError(`Set ${i + 1}: ${message}`);
    if (durationUnit === "reps" && (!Number.isInteger(duration) || duration > maxReps)) {
      throw error(`enter a whole rep count from 1 to ${maxReps}.`);
    }
    if ((load === null) !== (loadUnit === null)) throw error("provide both load and its kg or lb unit, or neither.");
    if (durationUnit === "reps" && extraReps !== null) throw error("additional reps are only for time or distance sets.");
    return { exercise: exercise.trim(), duration, durationUnit, load, loadUnit, extraReps };
  });
}

export const readId = reader("Workout ID", id);
const readName = reader("Exercise", exercise);
export const exerciseName = (input: unknown) => readName(input).trim();

export function readWorkout(input: unknown): Workout {
  const { id, date, sets } = workout(input);
  const parsed = new Date(date + "T00:00:00.000Z");
  if (date.startsWith("0000") || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) {
    throw new GymInputError("Use a real workout date (YYYY-MM-DD).");
  }
  return { id, date, sets: checkedSets(sets) };
}

export function readSuggestion(input: unknown) {
  const { note, sets } = suggestion(input);
  return { note: note.trim(), sets: checkedSets(sets) };
}

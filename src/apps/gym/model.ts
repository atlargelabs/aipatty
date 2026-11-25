import { arr, compile, int, nullable, num, obj, oneOf, opt, str, type Schema } from "@earendil-works/pi-schema";

export const units = ["kg", "lb", "sec", "min"] as const;
export const maxSets = 60;
export const maxExercise = 80;
export const maxReps = 1_000;
export const maxAmount = 100_000;
const maxNote = 2_000;

export type GymSet = {
  exercise: string;
  reps: number | null;
  amount: number;
  unit: typeof units[number];
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
  exercise, reps: opt(nullable(int({ minimum: 1, maximum: maxReps }))),
  amount: num({ minimum: 0, maximum: maxAmount }), unit: oneOf(units),
});
const workout = reader("Workout", obj({
  id, date: str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  sets: arr(set, { minItems: 1, maxItems: maxSets }),
}));
const suggestion = reader("Suggestion", obj({
  note: str({ maxLength: maxNote }), sets: arr(set, { maxItems: maxSets }),
}));

function checkedSets(sets: ReturnType<typeof workout>["sets"]): GymSet[] {
  return sets.map(({ exercise, reps, amount, unit }, i) => {
    const timed = unit === "sec" || unit === "min";
    if (!timed && reps == null) throw new GymInputError("Set " + (i + 1) + ": enter reps for a weight set.");
    if (timed && amount === 0) throw new GymInputError("Set " + (i + 1) + ": enter a time greater than zero.");
    return { exercise: exercise.trim(), reps: reps ?? null, amount, unit };
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

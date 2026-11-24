import { arr, compile, int, nullable, num, obj, oneOf, opt, str, type Schema } from "@earendil-works/pi-schema";

export const units = ["kg", "lb", "sec", "min"] as const;
export const maxSets = 60;
export const maxExercise = 80;
export const maxReps = 1_000;
export const maxAmount = 100_000;
export const maxPlan = 8_000;
export const maxSql = 8_000;
export const idSchema = str({ pattern: "^[A-Za-z0-9_-]{1,64}$", description: "Stable ID (letters, digits, _ or -); reuse it when correcting or retrying a workout." });

export const workoutSchema = obj({
  id: idSchema,
  date: str({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "Calendar date, YYYY-MM-DD" }),
  sets: arr(obj({
    exercise: str({ minLength: 1, maxLength: maxExercise, pattern: "\\S" }),
    reps: opt(nullable(int({ minimum: 1, maximum: maxReps }), { description: "Required for weights; may be omitted for time." })),
    amount: num({ minimum: 0, maximum: maxAmount, description: "Weight (0 for bodyweight) or positive time" }),
    unit: oneOf(units),
  }), { minItems: 1, maxItems: maxSets }),
});
export const deleteSchema = obj({ id: idSchema });
export const planSchema = obj({ plan: str({ maxLength: maxPlan, description: "Plain text plan; use an empty string to clear it" }) });
export const querySchema = obj({ sql: str({ minLength: 1, maxLength: maxSql }) });

export class GymInputError extends Error {}

function validated<T>(label: string, schema: Schema<T>) {
  const validate = compile(schema);
  return (input: unknown) => {
    const result = validate.validate(input);
    if (result.ok) return result.value;
    const { path, message } = result.errors[0];
    throw new GymInputError(`Invalid ${label}${path.replaceAll("/", ".")}: ${message}`);
  };
}

export const readWorkout = validated("workout", workoutSchema);
export const readDelete = validated("workout ID", deleteSchema);
export const readPlan = validated("plan", planSchema);
export const readQuery = validated("query", querySchema);

export type GymSet = {
  exercise: string;
  reps: number | null;
  amount: number;
  unit: typeof units[number];
};
export type Workout = { id: string; date: string; sets: GymSet[] };

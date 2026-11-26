import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHistory } from "../tools/import-gym-history.ts";

const valid = { id: "source_1", date: "2024-02-29", sets: [{ exercise: " Synthetic press ", duration: 7 }] };

test("Gym history validation uses the app's shape, defaults and limits", () => {
  assert.deepEqual(parseHistory(JSON.stringify([valid])), [{ ...valid, sets: [{
    exercise: "Synthetic press", duration: 7, durationUnit: "reps", load: null, loadUnit: null, extraReps: null,
  }] }]);
  assert.throws(() => parseHistory("{}"), /JSON array/);
  assert.throws(() => parseHistory(JSON.stringify([valid, valid])), /Workout #2: Duplicate source ID/);
  const bad = (patch: object, error: RegExp) => assert.throws(() => parseHistory(JSON.stringify([valid, {
    ...valid, id: "source_2", ...patch,
  }])), error);
  bad({ date: "2025-02-29" }, /Workout #2: Use a real workout date/);
  bad({ id: "../other" }, /Workout\.id/);
  bad({ sets: [] }, /Workout\.sets/);
  bad({ sets: Array(61).fill(valid.sets[0]) }, /Workout\.sets/);
  const badSet = (patch: object, error: RegExp) => bad({ sets: [{ ...valid.sets[0], ...patch }] }, error);
  badSet({ duration: 2.5 }, /whole rep count/);
  badSet({ duration: 100_001, durationUnit: "sec" }, /duration/);
  badSet({ exercise: "x".repeat(81) }, /exercise/);
  badSet({ load: 0 }, /both load and its kg or lb unit/);
  badSet({ extraReps: 3 }, /only for time or distance/);
  badSet({ unit: "kg" }, /unknown field/);
});

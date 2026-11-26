import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { startApi } from "../src/api.ts";
import { gymApp } from "../src/apps/gym/index.ts";
import { openHost } from "../src/host.ts";
import { HttpError } from "../src/http.ts";
import { checkout, fauxConfig, fixture } from "./helpers.ts";

// Opt in with `node --test test/gym-import.browser.ts` after installing Chromium via Playwright.
test("Gym history preview and Save workout through the real phone page", { timeout: 60_000 }, async t => {
  const dir = await fixture(t);
  const writes: unknown[] = [];
  let hideOnce: string | undefined;
  const host = await openHost(fauxConfig(dir), { apps: [{
    ...gymApp,
    open(context) {
      const app = gymApp.open(context);
      return { ...app, async handle(req, res, path) {
        if (req.method !== "GET") writes.push([req.method, path, req.headers["sec-fetch-site"]]);
        if (req.method === "GET" && path === hideOnce) {
          hideOnce = undefined;
          throw new HttpError(404, "Workout not found. Reload Gym to refresh the list.");
        }
        if (path === "/api/workouts/wrong-route") throw new HttpError(404, "Gym page not found");
        if (req.method === "PUT" && path === "/api/workouts/rejected-save") throw new HttpError(503, "Synthetic save unavailable");
        return app.handle(req, res, path);
      } };
    },
  }] });
  const api = await startApi(host, { ok: true, commit: "test", startedAt: "now", version: "0" }, 0);
  const origin = `http://127.0.0.1:${api.port}`;
  const workoutPath = (id: string) => `/api/workouts/${id}`;
  const get = (id: string) => fetch(origin + "/apps/gym" + workoutPath(id));
  const run = async (input: unknown, ...args: string[]) => {
    const file = join(dir, "history.json");
    await writeFile(file, JSON.stringify(input));
    return promisify(execFile)(process.execPath, ["tools/import-gym-history.ts", "--origin", origin, file, ...args], {
      cwd: checkout, timeout: 25_000,
    });
  };
  const defaults = { exercise: "Synthetic press", duration: 6 };
  const weighted = { exercise: "Synthetic hold", duration: 15.625, durationUnit: "sec", load: 20.25, loadUnit: "kg", extraReps: 3 };
  const bodyweight = { exercise: "Synthetic carry", duration: 8.5, durationUnit: "m", load: 0, loadUnit: "lb" };
  const first = { id: "z_Sample-1", date: "2024-02-29", sets: [weighted, defaults, bodyweight] };
  const second = { id: "A_Sample-2", date: "2024-01-02", sets: [{ exercise: "Synthetic plank", duration: 0.75, durationUnit: "min" }] };
  const expectedFirst = { ...first, sets: [weighted,
    { ...defaults, durationUnit: "reps", load: null, loadUnit: null, extraReps: null },
    { ...bodyweight, extraReps: null },
  ] };
  const expectedSecond = { ...second, sets: [{ ...second.sets[0], load: null, loadUnit: null, extraReps: null }] };
  try {
    assert.match((await run([first, second])).stdout, /Dry run: 2 to save, 0 identical to skip/);
    assert.equal((await get(first.id)).status, 404);
    await assert.rejects(run([first, { ...second, date: "2024-02-31" }], "--save"), { stderr: /Workout #2: Use a real workout date/ });
    await assert.rejects(run([{ ...first, id: "wrong-route" }], "--save"), { stderr: /Preflight workout #1: Gym workout GET failed \(HTTP 404\)/ });
    assert.deepEqual(writes, []);

    assert.match((await run([first, second], "--save")).stdout, /Done: 2 saved and verified, 0 identical skipped/);
    assert.deepEqual(await (await get(first.id)).json(), expectedFirst);
    assert.deepEqual(await (await get(second.id)).json(), expectedSecond);
    const browserWrites = [first, second].map(workout => ["PUT", workoutPath(workout.id), "same-origin"]);
    assert.deepEqual(writes, browserWrites, "only same-origin browser writes, in input order");

    assert.match((await run([first, second], "--save")).stdout, /Done: 0 saved and verified, 2 identical skipped/);
    const conflict = { ...first, sets: [...first.sets].reverse() };
    const untouched = { ...second, id: "unused" };
    await assert.rejects(run([untouched, conflict]), { stderr: /Preflight workout #2: Existing workout differs/ });
    await assert.rejects(run([untouched, conflict], "--save"), { stderr: /Preflight workout #2: Existing workout differs/ });
    assert.equal((await get(untouched.id)).status, 404, "preflight stops before the first save");

    hideOnce = workoutPath(first.id); // Simulate the row appearing between preflight and Save.
    await assert.rejects(run([conflict], "--save"), { stderr: /Import stopped: Workout #1: Existing workout differs/ });
    assert.deepEqual(await (await get(first.id)).json(), expectedFirst);
    assert.deepEqual(writes, browserWrites, "skips and conflicts do not write");

    await assert.rejects(run([{ ...first, id: "rejected-save" }, untouched], "--save"), {
      stderr: /Workout #1: Gym Save workout failed: Synthetic save unavailable/,
    });
    assert.equal((await get(untouched.id)).status, 404, "a failed click stops the run");
    assert.deepEqual(writes, [...browserWrites, ["PUT", workoutPath("rejected-save"), "same-origin"]]);
  } finally { await api.close(); await host.close(); }
});

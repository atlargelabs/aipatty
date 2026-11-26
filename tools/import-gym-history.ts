import { readFile } from "node:fs/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { chromium, type Page } from "playwright";
import { readWorkout, type Workout } from "../src/apps/gym/model.ts";

const usage = "Usage: node tools/import-gym-history.ts --origin <http(s)://host:port> [--save] <history.json>";
const timeout = 12_000;

export function parseHistory(text: string): Workout[] {
  let input: unknown;
  try { input = JSON.parse(text); }
  catch { throw new Error("History must be valid JSON."); }
  if (!Array.isArray(input)) throw new Error("History must be a JSON array of workouts.");
  const ids = new Set<string>();
  return input.map((entry, i) => {
    try {
      const workout = readWorkout(entry);
      if (ids.has(workout.id)) throw new Error("Duplicate source ID.");
      ids.add(workout.id);
      for (const set of workout.sets) {
        // SQLite binds text as UTF-8; reject lone surrogates rather than saving changed names.
        if (!set.exercise.isWellFormed()) throw new Error("Exercise name contains invalid Unicode.");
        if (set.load === 0) set.load = 0; // JSON and SQLite do not distinguish -0 from 0.
      }
      return workout;
    } catch (error) {
      throw new Error(`Workout #${i + 1}: ${message(error)}`);
    }
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const workoutUrl = (phoneUrl: string, id: string) => new URL(`api/workouts/${id}`, phoneUrl).href;

async function readExisting(phoneUrl: string, id: string) {
  const response = await fetch(workoutUrl(phoneUrl, id), { redirect: "error", signal: AbortSignal.timeout(timeout) });
  const body: unknown = await response.json().catch(() => {
    throw new Error(`Could not read Gym's workout JSON (HTTP ${response.status}).`);
  });
  // The current route only distinguishes missing workouts by this message. A changed message,
  // missing app, or proxy 404 fails closed rather than allowing an unsafe upsert.
  if (response.status === 404 && isDeepStrictEqual(body, { error: "Workout not found. Reload Gym to refresh the list." })) return undefined;
  if (response.status !== 200) throw new Error(`Gym workout GET failed (HTTP ${response.status}).`);
  return body;
}

async function matchesExisting(phoneUrl: string, workout: Workout): Promise<boolean> {
  const body = await readExisting(phoneUrl, workout.id);
  if (body === undefined) return false;
  // The GET returns the same canonical fields that readWorkout filled in for the source.
  if (!isDeepStrictEqual(body, workout)) throw new Error("Existing workout differs from the source; refusing to overwrite it.");
  return true;
}

const editorReady = () => document.querySelector<HTMLFieldSetElement>("#workout-editor")?.disabled === false;

async function restoreDraft(page: Page, phoneUrl: string, workout: Workout) {
  // Only touch localStorage in this new browser context, on the Gym page itself.
  await page.evaluate(draft => localStorage.setItem("gym-draft", draft), JSON.stringify({ ...workout, dateDirty: true }));
  const response = await page.reload();
  if (!response?.ok() || page.url() !== phoneUrl) throw new Error("Could not reload the Gym phone page.");
  await page.waitForFunction(editorReady);
  const restored = await page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem("gym-draft") ?? "null");
    const date = document.querySelector<HTMLInputElement>("#workout-date");
    if (!draft || !date?.validity.valid || document.querySelectorAll("#draft-sets > li").length !== draft.sets?.length) return null;
    return { id: draft.id, date: date.value, sets: draft.sets };
  });
  if (!isDeepStrictEqual(restored, workout)) throw new Error("The phone page did not restore the intended draft; no Save was clicked.");
}

async function clickSave(page: Page, phoneUrl: string, workout: Workout) {
  const url = workoutUrl(phoneUrl, workout.id);
  // Observe (never send) the page's request. The confirmation wording is not part of verification.
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === url && response.request().method() === "PUT"),
    page.getByRole("button", { name: "Save workout", exact: true }).click(),
  ]).catch(error => { throw new Error(`No confirmed response from Save workout: ${message(error)}`); });
  await page.waitForFunction(editorReady); // Let the page finish clearing this draft before staging another.
  if (!response.ok()) {
    const status = await page.locator("#status").textContent();
    throw new Error(`Gym Save workout failed (HTTP ${response.status()}): ${status?.trim() || "No page status."}`);
  }
  if (!isDeepStrictEqual(await readExisting(phoneUrl, workout.id), workout)) {
    throw new Error("Gym responded to Save, but read-back did not match the source.");
  }
}

async function apply(phoneUrl: string, workouts: Workout[], existing: boolean[]) {
  const browser = await chromium.launch({ timeout });
  let saved = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // Fresh, non-persistent context.
    page.setDefaultTimeout(timeout);
    const response = await page.goto(phoneUrl);
    if (!response?.ok() || page.url() !== phoneUrl) throw new Error("Could not open the Gym phone page at the requested origin.");
    for (const [i, workout] of workouts.entries()) {
      if (existing[i]) continue;
      try {
        await restoreDraft(page, phoneUrl, workout);
        if (await matchesExisting(phoneUrl, workout)) continue; // Check again immediately before the upsert.
        await clickSave(page, phoneUrl, workout);
        saved++;
        console.log(`Workout #${i + 1}: saved and verified.`);
      } catch (error) {
        throw new Error(`Workout #${i + 1}: ${message(error)}`);
      }
    }
  } finally { await browser.close(); }
  return saved;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { origin: { type: "string" }, save: { type: "boolean" }, help: { type: "boolean" } },
    allowPositionals: true,
  });
  if (values.help) { console.log(usage); return; }
  if (!values.origin || positionals.length !== 1) throw new Error(usage);
  const origin = URL.parse(values.origin);
  if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.href !== origin.origin + "/") {
    throw new Error("--origin must be the base HTTP(S) origin of the Gym page, without credentials or a path.");
  }
  const phoneUrl = origin.origin + "/apps/gym/";
  const bytes = await readFile(positionals[0]).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`Could not read the history file (${error.code ?? "read failed"}). Check the path and permissions.`);
  });
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("The history file is not valid UTF-8."); }
  const workouts = parseHistory(text);
  const existing: boolean[] = [];
  for (const [i, workout] of workouts.entries()) {
    try { existing.push(await matchesExisting(phoneUrl, workout)); }
    catch (error) { throw new Error(`Preflight workout #${i + 1}: ${message(error)}`); }
  }
  const pending = existing.filter(found => !found).length;
  if (!values.save) {
    console.log(`Dry run: ${pending} to save, ${workouts.length - pending} identical to skip. No changes made.`);
    return;
  }
  const saved = pending ? await apply(phoneUrl, workouts, existing) : 0;
  console.log(`Done: ${saved} saved and verified, ${workouts.length - saved} identical skipped.`);
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(`Import stopped: ${message(error)}`);
    console.error("Resolve the error and run the preview again before resuming with --save. Identical workouts are skipped; nothing is rolled back.");
    process.exitCode = 1;
  }
}

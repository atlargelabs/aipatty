import { api, branchId, node, setLine } from "./view.js";

const $ = id => document.getElementById(id);
const editor = $("workout-editor");
const date = $("workout-date");
const form = $("set-form");
const exercise = $("exercise");
const reps = $("reps");
const amount = $("amount");
const unit = $("unit");
const maxSets = Number(form.dataset.maxSets);
const recent = $("recent-workouts");
const chatBranch = branchId(new URLSearchParams(location.search).get("branch"));
if (chatBranch) $("chat-link").href = "/#" + chatBranch;

let id, sets, editingWorkout, position, dirty, setDirty;
let busy = false;
let knownExercises = [];

function today() {
  const now = new Date();
  return new Date(+now - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
function button(label, action, click) {
  const element = node("button", label);
  element.type = "button";
  element.dataset.action = action;
  element.addEventListener("click", click);
  return element;
}
function say(text) { $("status").textContent = text; }
function timed() { return unit.value === "sec" || unit.value === "min"; }
function updateUnit() {
  reps.required = !timed();
  $("amount-label").firstElementChild.textContent = timed() ? "Time" : "Weight";
}
function updateButtons() {
  $("add-set").textContent = position === null ? "Add set" : "Update set";
  $("clear-set").textContent = position === null ? "Clear fields" : "Cancel set edit";
  $("reset-workout").hidden = !editingWorkout && !dirty && !setDirty;
  $("reset-workout").textContent = editingWorkout ? "Cancel workout edit" : "Discard draft";
}
function clearSet() {
  exercise.value = reps.value = amount.value = "";
  position = null;
  setDirty = false;
  updateUnit();
  updateButtons();
}
function begin(workout) {
  id = workout?.id ?? newId();
  date.value = workout?.date ?? today();
  sets = workout ? [...workout.sets] : [];
  editingWorkout = !!workout;
  dirty = false;
  $("workout-heading").textContent = workout ? "Edit workout" : "Log a workout";
  clearSet();
  renderDraft();
}
function exerciseNames() {
  const names = new Map();
  for (const name of [...knownExercises, ...sets.map(set => set.exercise)]) {
    const key = name.toLowerCase();
    if (!names.has(key)) names.set(key, name);
  }
  return names;
}
function updateSuggestions() {
  $("exercises").replaceChildren(...Array.from(exerciseNames().values(), name => new Option(name, name)));
}
function pendingSet() {
  if (!setDirty && position === null) return false;
  say(position === null ? "Tap Add set to include the fields, or Clear fields to discard them." : "Tap Update set or Cancel set edit first.");
  return true;
}
function renderDraft() {
  $("draft-sets").replaceChildren(...sets.map((set, i) => {
    const row = node("li");
    const edit = button("Edit", "edit-set", () => {
      if (pendingSet()) return;
      position = i;
      exercise.value = set.exercise;
      reps.value = set.reps ?? "";
      amount.value = set.amount;
      unit.value = set.unit;
      setDirty = false;
      updateUnit();
      updateButtons();
      exercise.focus();
    });
    const remove = button("Remove", "remove-set", () => {
      sets.splice(i, 1);
      if (position === i) clearSet();
      else if (position !== null && position > i) position--;
      dirty = true;
      renderDraft();
    });
    edit.setAttribute("aria-label", "Edit set " + (i + 1));
    remove.setAttribute("aria-label", "Remove set " + (i + 1));
    row.append(node("span", setLine(set)), edit, remove);
    return row;
  }));
  updateSuggestions();
  updateButtons();
}

form.addEventListener("input", () => { setDirty = true; updateButtons(); });
unit.addEventListener("change", updateUnit);
date.addEventListener("input", () => { dirty = true; updateButtons(); });
$("clear-set").addEventListener("click", clearSet);
form.addEventListener("submit", event => {
  event.preventDefault();
  const name = exercise.value.trim();
  if (!name) { say("Enter an exercise name."); exercise.focus(); return; }
  if (timed() && amount.valueAsNumber === 0) { say("Enter a time greater than zero."); amount.focus(); return; }
  if (position === null && sets.length === maxSets) { say("A workout can have up to " + maxSets + " sets."); return; }
  const set = {
    exercise: exerciseNames().get(name.toLowerCase()) ?? name,
    reps: reps.value === "" ? null : reps.valueAsNumber,
    amount: amount.valueAsNumber, unit: unit.value,
  };
  const updating = position !== null;
  if (updating) sets[position] = set;
  else sets.push(set);
  position = null;
  setDirty = false;
  dirty = true;
  // Keep the fields so an identical next set takes one tap. Save uses the list, not these fields.
  renderDraft();
  say(updating ? "Set updated. Save workout to keep the change." : "Set added (" + sets.length + ").");
});

function lock(value) {
  editor.disabled = value;
  for (const button of recent.querySelectorAll("button")) button.disabled = value;
}
async function run(action) {
  if (busy) return false;
  busy = true;
  lock(true);
  say("");
  try { await action(); return true; }
  catch (error) { say(error instanceof Error ? error.message : String(error)); return false; }
  finally { busy = false; lock(false); }
}
async function refresh() {
  const [{ workouts, exercises }, { plan }] = await Promise.all([api("workouts"), api("overview")]);
  knownExercises = exercises;
  updateSuggestions();
  $("plan").textContent = plan.trim() ? plan : "No plan saved yet.";
  const cards = workouts.map(workout => {
    const card = node("article");
    card.dataset.workoutId = workout.id;
    const names = [...new Set(workout.sets.map(set => set.exercise))];
    const label = workout.date + " · " + workout.sets.length + (workout.sets.length === 1 ? " set" : " sets");
    const actions = node("div");
    actions.className = "actions";
    actions.append(
      button("Edit", "edit-workout", () => {
        if ((dirty || setDirty) && !confirm("Discard your unsaved workout changes?")) return;
        // Open the current workout, not the copy from when the page (perhaps an old tab) was loaded.
        void run(async () => begin(await api("workouts/" + workout.id))).then(opened => {
          if (!opened) return;
          date.focus();
          $("workout-heading").scrollIntoView({ block: "start" });
        });
      }),
      button("Delete", "delete-workout", () => {
        void run(async () => {
          const current = await api("workouts/" + workout.id);
          const exercise = current.sets[0]?.exercise;
          if (!confirm("Delete the workout on " + current.date + (exercise ? " · " + exercise : "") + "?")) return;
          await api("workouts/" + workout.id, "DELETE");
          if (editingWorkout && id === workout.id) begin();
          card.remove();
          await refreshAfter("Workout deleted.");
        });
      }),
    );
    card.append(node("h3", label), node("p", names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "")), actions);
    return card;
  });
  recent.replaceChildren(...(cards.length ? cards : [node("p", "No workouts logged yet.")]));
}
async function refreshAfter(message) {
  try { await refresh(); say(message); }
  catch { say(message + " Reload this page to refresh the workout list and plan."); }
}
$("save-workout").addEventListener("click", () => {
  if (!date.reportValidity()) return;
  if (pendingSet()) return;
  if (!sets.length) { say("Add at least one set before saving."); exercise.focus(); return; }
  void run(async () => {
    await api("workouts/" + id, "PUT", { date: date.value, sets });
    begin();
    await refreshAfter("Workout saved.");
  });
});
$("reset-workout").addEventListener("click", () => {
  if (!(dirty || setDirty) || confirm("Discard your unsaved workout changes?")) { begin(); say(""); }
});

function refreshOnReturn() {
  if (!editingWorkout && !dirty && !setDirty) date.value = today();
  void run(refresh);
}

begin();
void run(refresh);
window.addEventListener("pageshow", event => { if (event.persisted) refreshOnReturn(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshOnReturn(); });

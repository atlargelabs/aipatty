const $ = id => document.getElementById(id);
const form = $("set-form");
const date = $("workout-date");
const exercise = $("exercise");
const reps = $("reps");
const amount = $("amount");
const unit = $("unit");
const last = $("last-session");
const recent = $("recent-workouts");
const startSuggestion = $("start-suggestion");
const maxSets = Number(form.dataset.maxSets);
const draftKey = "gym-draft";
const branch = new URLSearchParams(location.search).get("branch");
if (/^[1-9]\d*$/.test(branch ?? "") && Number.isSafeInteger(Number(branch))) {
  $("chat-link").href = "/#" + branch;
  $("chat-link").hidden = false;
}

let id, sets, editing, position, setDirty, valuesDirty, dateDirty, unreadableDraft;
let suggestion = null, knownExercises = new Set(), busy = false, lookup = 0, lookedUp, overviewRevision = 0;
// Match the store's SQLite NOCASE, not Unicode case folding.
const foldName = name => name.replace(/[A-Z]/g, letter => letter.toLowerCase());

function today() {
  const now = new Date();
  return new Date(+now - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(label, action, click) {
  const element = node("button", label);
  element.type = "button";
  element.dataset.action = action;
  element.addEventListener("click", click);
  return element;
}
function setLine(set) {
  return set.exercise + " · " + (set.reps == null ? "" : set.reps + " reps · ") + set.amount + " " + set.unit;
}
function say(text) { $("status").textContent = text; }
function warning(id, text = "") {
  $(id).textContent = text;
  $(id).hidden = !text;
}
async function api(path, method = "GET", body) {
  const response = await fetch("/apps/gym/api/" + path, {
    method, signal: AbortSignal.timeout(8_000),
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Gym request failed (" + response.status + ").");
  return value;
}

function hasDraft() {
  return editing || sets.length > 0 || dateDirty || setDirty || position !== null;
}
function updateDefaultDate() {
  if (!hasDraft()) date.value = today();
}
function remember() {
  $("reset-workout").textContent = unreadableDraft ? "Discard unreadable draft" : "Discard draft";
  const dirty = hasDraft();
  $("reset-workout").hidden = !unreadableDraft && !dirty;
  if (unreadableDraft) {
    warning("draft-warning", "This browser's saved draft could not be read. It has been kept. Discard it to resume draft autosave.");
    return;
  }
  try {
    if (!dirty) localStorage.removeItem(draftKey);
    else localStorage.setItem(draftKey, JSON.stringify({
      id, date: date.value, dateDirty, sets, editing,
      fields: { exercise: exercise.value, reps: reps.value, amount: amount.value, unit: unit.value, position, setDirty, valuesDirty },
    }));
    warning("draft-warning");
  } catch {
    warning("draft-warning", dirty ? "This browser could not autosave the draft. Save the workout before leaving Gym."
      : "This browser could not clear the draft. A previously saved draft may reappear on reload.");
  }
}
function restoreEditor() {
  let raw;
  try { raw = localStorage.getItem(draftKey); } catch {
    if (!id) begin(); // Storage is optional; leave an existing in-memory editor alone.
    return;
  }
  let saved;
  unreadableDraft = false;
  if (raw !== null) {
    try {
      const draft = JSON.parse(raw);
      if (typeof draft?.id !== "string" || !draft.id || typeof draft.date !== "string" || !Array.isArray(draft.sets)
        || !draft.sets.every(set => typeof set?.exercise === "string" && typeof set.amount === "number" && typeof set.unit === "string")) {
        throw new Error("Unrecognized draft");
      }
      saved = draft;
    } catch { unreadableDraft = true; }
  }
  begin(saved);
}
function timed() { return unit.value === "sec" || unit.value === "min"; }
function syncFields() {
  reps.required = !timed();
  $("amount-label").textContent = timed() ? "Time" : "Weight";
  $("add-set").textContent = position === null ? "Add set" : "Update set";
  $("clear-set").textContent = position === null ? "Clear fields" : "Cancel set edit";
}
function fillFields(set) {
  reps.value = set.reps ?? "";
  amount.value = set.amount;
  unit.value = set.unit;
  syncFields();
}
function hideLast() {
  lookup++;
  lookedUp = undefined;
  last.hidden = true;
}
function loadFields(fields) {
  hideLast();
  exercise.value = fields?.exercise ?? "";
  position = fields?.position ?? null;
  setDirty = !!fields?.setDirty;
  valuesDirty = !!fields?.valuesDirty;
  fillFields(fields ?? { reps: "", amount: "", unit: "kg" });
}
function begin(draft) {
  id = draft?.id ?? newId();
  date.value = draft?.date ?? today();
  dateDirty = draft?.dateDirty ?? false;
  sets = draft ? [...draft.sets] : [];
  editing = !!draft?.editing;
  $("workout-heading").textContent = editing ? "Edit workout" : "Log workout";
  loadFields(draft?.fields);
  renderDraft();
  if (exercise.value) void previewLast();
}
function mayDiscardDraft() {
  return !hasDraft() || confirm("Discard your unsaved workout changes?");
}
function pendingSet() {
  if (!setDirty && position === null) return false;
  say(position === null ? "Tap Add set to include these fields, or Clear fields to discard them." : "Tap Update set or Cancel set edit first.");
  return true;
}
function renderDraft() {
  $("draft-sets").replaceChildren(...sets.map((set, i) => {
    const row = node("li", setLine(set));
    const actions = node("div");
    actions.className = "gym-actions";
    const edit = button("Edit", "edit-set", () => {
      if (pendingSet()) return;
      loadFields({ ...set, position: i });
      remember();
      exercise.focus();
    });
    const remove = button("Remove", "remove-set", () => {
      sets.splice(i, 1);
      if (position === i) loadFields();
      else if (position !== null && position > i) position--;
      renderDraft();
    });
    edit.setAttribute("aria-label", "Edit set " + (i + 1));
    remove.setAttribute("aria-label", "Remove set " + (i + 1));
    actions.append(edit, remove);
    row.append(actions);
    return row;
  }));
  remember();
}
async function previewLast() {
  const name = exercise.value.trim();
  if (!name || name === lookedUp) return;
  lookedUp = name;
  const call = ++lookup;
  try {
    const session = await api("last?" + new URLSearchParams({ exercise: name }));
    if (call !== lookup) return;
    if (!session) {
      last.textContent = "No previous sets for " + name + ".";
    } else {
      const list = node("ol");
      list.append(...session.sets.map(set => node("li", setLine(set))));
      last.replaceChildren(node("strong", "Last time · " + session.date), list);
      if (position === null && !valuesDirty && reps.value === "" && amount.value === "") {
        fillFields(session.sets[0]);
        remember();
      }
    }
  } catch {
    if (call !== lookup) return;
    last.textContent = "Could not load the last session. You can still enter a set.";
  }
  last.hidden = false;
}

form.addEventListener("input", event => {
  updateDefaultDate();
  setDirty = true;
  if (event.target === exercise) {
    hideLast();
    if (position === null && !valuesDirty) reps.value = amount.value = "";
    if (knownExercises.has(foldName(exercise.value.trim()))) void previewLast();
  } else {
    valuesDirty = true;
  }
  syncFields();
  remember();
});
exercise.addEventListener("change", () => void previewLast());
date.addEventListener("input", () => { dateDirty = true; remember(); });
$("clear-set").addEventListener("click", () => { loadFields(); remember(); say(""); });
form.addEventListener("submit", event => {
  event.preventDefault();
  const name = exercise.value.trim();
  if (!name) { say("Enter an exercise name."); exercise.focus(); return; }
  if (timed() && amount.valueAsNumber === 0) { say("Enter a time greater than zero."); amount.focus(); return; }
  if (position === null && sets.length === maxSets) { say("A workout can have up to " + maxSets + " sets."); return; }
  const set = { exercise: name, reps: reps.value === "" ? null : reps.valueAsNumber, amount: amount.valueAsNumber, unit: unit.value };
  const added = position === null;
  if (added) sets.push(set);
  else sets[position] = set;
  position = null;
  setDirty = valuesDirty = false;
  // Keep the fields so an identical next set takes one tap. Save uses the list, not these fields.
  syncFields();
  renderDraft();
  say(added ? "Set added (" + sets.length + ")." : "Set updated.");
});

async function run(action) {
  if (busy) return;
  busy = $("workout-editor").disabled = true;
  say("");
  try { await action(); }
  catch (error) { say(error.name === "TimeoutError" ? "Gym did not respond. Try again." : error.message); }
  finally { busy = $("workout-editor").disabled = false; }
}
async function refresh() {
  // The overview is context for the editor, not a prerequisite for entering sets.
  const revision = ++overviewRevision;
  try {
    const overview = await api("overview");
    if (revision !== overviewRevision) return;
    knownExercises = new Set(overview.exercises.map(foldName));
    $("exercises").replaceChildren(...overview.exercises.map(name => new Option(name, name)));
    suggestion = overview.suggestion;
    $("suggestion-note").textContent = suggestion ? (suggestion.note || "Saved on " + suggestion.created + ".") : "No suggestion saved yet.";
    $("suggestion-sets").replaceChildren(...(suggestion?.sets ?? []).map(set => node("li", setLine(set))));
    $("suggestion-sets").hidden = startSuggestion.hidden = !suggestion;
    recent.replaceChildren(...(overview.workouts.length ? overview.workouts.map(workoutCard) : [node("p", "No workouts logged yet.")]));
    warning("overview-warning");
  } catch {
    if (revision === overviewRevision) warning("overview-warning", "Could not refresh workouts and suggestions. You can still enter sets. Reload Gym to retry.");
  }
}
function workoutCard(workout) {
  const card = node("article");
  card.dataset.workoutId = workout.id;
  const actions = node("div");
  actions.className = "gym-actions";
  actions.append(
    button("Edit", "edit-workout", () => {
      if (busy || !mayDiscardDraft()) return;
      void run(async () => {
        begin({ ...await api("workouts/" + workout.id), editing: true });
        $("workout-heading").scrollIntoView({ block: "start" });
      });
    }),
    button("Delete", "delete-workout", () => {
      if (busy || !confirm("Delete the workout on " + workout.date + "?")) return;
      void run(async () => {
        await api("workouts/" + workout.id, "DELETE");
        if (editing && id === workout.id) begin();
        card.remove();
        say("Workout deleted.");
        void refresh();
      });
    }),
  );
  const names = [...new Set(workout.sets.map(set => set.exercise))];
  card.append(node("h3", workout.date + " · " + workout.sets.length + (workout.sets.length === 1 ? " set" : " sets")),
    node("p", names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "")), actions);
  return card;
}
startSuggestion.addEventListener("click", () => {
  if (busy || !suggestion || !mayDiscardDraft()) return;
  begin({ sets: suggestion.sets });
  $("workout-heading").scrollIntoView({ block: "start" });
  say("Suggestion loaded. Adjust the sets, then save after your workout.");
});
$("save-workout").addEventListener("click", () => {
  if (!date.reportValidity() || pendingSet()) return;
  if (!sets.length) { say("Add at least one set before saving."); exercise.focus(); return; }
  void run(async () => {
    await api("workouts/" + id, "PUT", { date: date.value, sets });
    begin();
    say("Workout saved.");
    void refresh();
  });
});
$("reset-workout").addEventListener("click", () => {
  if (unreadableDraft ? !confirm("Discard the unreadable draft and any unsaved changes?") : !mayDiscardDraft()) return;
  unreadableDraft = false;
  say("");
  begin();
});

restoreEditor();
$("workout-editor").disabled = false;
void refresh();
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  restoreEditor(); // A newer visit may have saved, changed or discarded the draft.
  void refresh();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  updateDefaultDate();
  void refresh();
});

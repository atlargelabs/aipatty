import { drawButtonIcon } from "/web/icons.ts";

const $ = id => document.getElementById(id);
const form = $("set-form");
const date = $("workout-date");
const exercise = $("exercise");
const duration = $("duration");
const durationUnit = $("duration-unit");
const load = $("load");
const loadUnit = $("load-unit");
const extraReps = $("extra-reps");
const newExercise = $("new-exercise");
const newName = $("new-exercise-name");
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
let selectedExercise, addedExercises, editingExtraReps;
let suggestion = null, knownExercises = [], busy = false, lookup = 0, lookedUp, overviewRevision = 0;
// Match the store's SQLite NOCASE, not Unicode case folding.
const foldName = name => name.replace(/[A-Z]/g, letter => letter.toLowerCase());
const addNew = "add-new";
const optionValue = name => name ? "name:" + name : "";

function exerciseChoices() {
  const choices = new Map();
  for (const name of [...knownExercises, ...sets.map(set => set.exercise), ...(suggestion?.sets ?? []).map(set => set.exercise), ...addedExercises]) {
    const key = foldName(name);
    if (!choices.has(key)) choices.set(key, name);
  }
  return choices;
}
function renderExercisePicker() {
  const choices = exerciseChoices();
  // Keep the selected spelling when editing a historical set, without showing a second option.
  if (selectedExercise) choices.set(foldName(selectedExercise), selectedExercise);
  const placeholder = new Option("Choose an exercise", "");
  placeholder.disabled = true;
  exercise.replaceChildren(placeholder, ...[...choices.values()].map(name => new Option(name, optionValue(name))), new Option("Add new", addNew));
  exercise.value = optionValue(selectedExercise);
}

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
function iconButton(icon, label, action, click) {
  const element = node("button");
  element.type = "button";
  element.dataset.action = action;
  drawButtonIcon(element, icon, label);
  if (icon === "trash") element.classList.add("danger");
  element.addEventListener("click", click);
  return element;
}
function measurementLine(set) {
  return " · " + set.duration + " " + set.durationUnit
    + (set.extraReps == null ? "" : " · " + set.extraReps + " reps")
    + (set.load == null ? "" : " · " + set.load + " " + set.loadUnit + (set.load === 0 ? " (bodyweight)" : ""));
}
const setLine = set => set.exercise + measurementLine(set);
const startsExerciseBlock = (sets, i) => i === 0 || foldName(sets[i - 1].exercise) !== foldName(sets[i].exercise);

function renderSets(list, sets, renderRow = set => node("li", setLine(set))) {
  list.replaceChildren(...sets.map((set, i) => {
    const startsBlock = startsExerciseBlock(sets, i);
    const row = renderRow(set, i, startsBlock);
    if (i > 0 && startsBlock) row.classList.add("exercise-break");
    return row;
  }));
}
function renderGroupedSets(list, sets, headingTag, withActions = line => line) {
  renderSets(list, sets, (set, i, startsBlock) => {
    const row = node("li");
    if (startsBlock) {
      const heading = node(headingTag, set.exercise);
      heading.className = "gym-exercise-heading";
      row.append(heading);
    }
    const line = node("div", measurementLine(set));
    line.className = "gym-measurement";
    row.append(withActions(line, set, i));
    return row;
  });
}
function setList(sets) {
  const list = node("ol");
  list.className = "gym-set-list";
  list.setAttribute("role", "list");
  renderGroupedSets(list, sets, "h4");
  return list;
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
  return editing || sets.length > 0 || addedExercises.length > 0 || dateDirty || setDirty || position !== null;
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
      id, date: date.value, dateDirty, sets, editing, addedExercises,
      fields: { exercise: selectedExercise, duration: duration.value, durationUnit: durationUnit.value,
        load: load.value, loadUnit: loadUnit.value, extraReps: editingExtraReps ? extraReps.value : null, position, setDirty, valuesDirty },
    }));
    warning("draft-warning");
  } catch {
    warning("draft-warning", dirty ? "This browser could not autosave the draft. Save the workout before leaving Gym."
      : "This browser could not clear the draft. A previously saved draft may reappear on reload.");
  }
}
// Older browser drafts used the same weight-or-time split as the old database, but editor fields are strings.
function upgradeDraftSet(set) {
  if (!set || "duration" in set) return set;
  const { reps, amount, unit, ...rest } = set;
  if (unit === "sec" || unit === "min") {
    return { ...rest, duration: amount, durationUnit: unit, load: null, loadUnit: null, extraReps: reps === "" ? null : reps ?? null };
  }
  if (unit === "kg" || unit === "lb") {
    return { ...rest, duration: reps, durationUnit: "reps", load: amount, loadUnit: unit, extraReps: null };
  }
  return set;
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
      if (typeof draft?.id !== "string" || !draft.id || typeof draft.date !== "string" || !Array.isArray(draft.sets)) {
        throw new Error("Unrecognized draft");
      }
      draft.sets = draft.sets.map(upgradeDraftSet);
      if (!draft.sets.every(set => typeof set?.exercise === "string" && typeof set.duration === "number" && typeof set.durationUnit === "string")
        || (draft.addedExercises !== undefined && (!Array.isArray(draft.addedExercises) || !draft.addedExercises.every(name => typeof name === "string")))) {
        throw new Error("Unrecognized draft");
      }
      const fields = draft.fields;
      if (fields != null && (typeof fields !== "object" || Array.isArray(fields)
        || (fields.exercise != null && typeof fields.exercise !== "string"))) {
        throw new Error("Unrecognized draft fields");
      }
      draft.fields = upgradeDraftSet(fields);
      saved = draft;
    } catch { unreadableDraft = true; }
  }
  begin(saved);
}
function syncFields() {
  const count = durationUnit.value === "reps";
  duration.min = count ? "1" : "0";
  duration.max = count ? duration.dataset.maxCount : duration.dataset.maxMeasurement;
  duration.step = count ? "1" : "any";
  duration.inputMode = count ? "numeric" : "decimal";
  $("historical-reps").hidden = extraReps.disabled = count || !editingExtraReps;
  $("add-set").textContent = position === null ? "Add set" : "Update set";
  $("clear-set").textContent = position === null ? "Clear fields" : "Cancel set edit";
}
function fillFields(set, defaultLoadUnit = "kg") {
  duration.value = set.duration ?? "";
  durationUnit.value = set.durationUnit ?? "reps";
  load.value = set.load ?? "";
  loadUnit.value = set.loadUnit ?? defaultLoadUnit;
  extraReps.value = set.extraReps ?? "";
  editingExtraReps = set.extraReps != null;
  syncFields();
}
function hideLast() {
  lookup++;
  lookedUp = undefined;
  last.hidden = true;
}
function loadFields(fields) {
  hideLast();
  selectedExercise = fields?.exercise?.trim() ?? "";
  position = fields?.position ?? null;
  setDirty = !!fields?.setDirty;
  valuesDirty = !!fields?.valuesDirty;
  fillFields(fields ?? {});
  renderExercisePicker();
}
function begin(draft) {
  if (newExercise.open) newExercise.close();
  id = draft?.id ?? newId();
  date.value = draft?.date ?? today();
  dateDirty = draft?.dateDirty ?? false;
  sets = draft ? [...draft.sets] : [];
  addedExercises = draft?.addedExercises ?? [];
  editing = !!draft?.editing;
  $("workout-heading").textContent = editing ? "Edit workout" : "Workouts";
  loadFields(draft?.fields);
  renderDraft();
  if (selectedExercise) void previewLast();
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
  renderExercisePicker();
  // Reverse the display only; row controls still target the original array indexes.
  renderGroupedSets($("draft-sets"), sets.toReversed(), "h3", (line, set, index) => {
    const i = sets.length - 1 - index;
    const content = node("div");
    content.className = "gym-inline";
    const actions = node("div");
    actions.className = "gym-actions";
    const label = " set " + (i + 1) + ": " + setLine(set);
    const edit = iconButton("edit", "Edit" + label, "edit-set", () => {
      if (pendingSet()) return;
      loadFields({ ...set, position: i });
      remember();
      exercise.focus();
      void previewLast();
    });
    const remove = iconButton("trash", "Remove" + label, "remove-set", () => {
      sets.splice(i, 1);
      if (position === i) loadFields();
      else if (position !== null && position > i) position--;
      renderDraft();
    });
    actions.append(edit, remove);
    content.append(line, actions);
    return content;
  });
  remember();
}
async function previewLast() {
  const name = selectedExercise;
  if (!name || name === lookedUp) return;
  lookedUp = name;
  const call = ++lookup;
  try {
    const session = await api("last?" + new URLSearchParams({ exercise: name }));
    if (call !== lookup) return;
    if (!session) {
      last.textContent = "No previous sets for " + name + ".";
    } else {
      last.replaceChildren(node("h3", "Last time · " + session.date), setList(session.sets));
      if (position === null && !valuesDirty && duration.value === "" && load.value === "") {
        fillFields(session.sets[0], loadUnit.value);
        remember();
      }
    }
  } catch {
    if (call !== lookup) return;
    last.textContent = "Could not load the last session. You can still enter a set.";
  }
  last.hidden = false;
}

function selectExercise(name, isNew = false) {
  if (name !== selectedExercise) {
    updateDefaultDate();
    if (isNew) addedExercises.push(name);
    selectedExercise = name;
    setDirty = true;
    hideLast();
    if (position === null && !valuesDirty) fillFields({}, loadUnit.value);
    void previewLast();
  }
  renderExercisePicker();
  remember();
}
exercise.addEventListener("change", () => {
  if (exercise.value !== addNew) {
    selectExercise(exercise.value.slice("name:".length));
    return;
  }
  // Opening or cancelling the dialog doesn't change the selection or the draft.
  exercise.value = optionValue(selectedExercise);
  newName.value = "";
  newName.setCustomValidity("");
  newExercise.showModal();
});
newName.addEventListener("input", () => newName.setCustomValidity(""));
$("cancel-exercise").addEventListener("click", () => newExercise.close());
$("new-exercise-form").addEventListener("submit", event => {
  event.preventDefault();
  const name = newName.value.trim();
  if (!name || name.length > newName.maxLength) {
    newName.setCustomValidity("Enter an exercise name (1–" + newName.maxLength + " characters).");
    newName.reportValidity();
    return;
  }
  const key = foldName(name);
  const existing = foldName(selectedExercise) === key ? selectedExercise : exerciseChoices().get(key);
  newExercise.close();
  selectExercise(existing ?? name, !existing);
});
form.addEventListener("input", () => {
  updateDefaultDate();
  setDirty = valuesDirty = true;
  syncFields();
  remember();
});
date.addEventListener("input", () => { dateDirty = true; remember(); });
$("clear-set").addEventListener("click", () => { loadFields(); remember(); say(""); });
form.addEventListener("submit", event => {
  event.preventDefault();
  if (!selectedExercise) { say("Choose or add an exercise."); exercise.focus(); return; }
  if (duration.valueAsNumber <= 0) { say("Enter a duration greater than zero."); duration.focus(); return; }
  if (position === null && sets.length === maxSets) { say("A workout can have up to " + maxSets + " sets."); return; }
  const set = { exercise: selectedExercise, duration: duration.valueAsNumber, durationUnit: durationUnit.value,
    load: load.value === "" ? null : load.valueAsNumber, loadUnit: load.value === "" ? null : loadUnit.value,
    extraReps: extraReps.disabled || extraReps.value === "" ? null : extraReps.valueAsNumber };
  const added = position === null;
  if (added) sets.push(set);
  else sets[position] = set;
  position = null;
  setDirty = valuesDirty = false;
  extraReps.value = set.extraReps ?? "";
  editingExtraReps = set.extraReps !== null;
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
    knownExercises = overview.exercises;
    suggestion = overview.suggestion;
    renderExercisePicker();
    $("suggestion-note").textContent = suggestion ? (suggestion.note || "Saved on " + suggestion.created + ".") : "No suggestion saved yet.";
    renderSets($("suggestion-sets"), suggestion?.sets ?? []);
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
  const heading = node("div");
  heading.className = "gym-inline";
  const actions = node("div");
  actions.className = "gym-actions";
  const label = " workout on " + workout.date;
  const edit = iconButton("edit", "Edit" + label, "edit-workout", () => {
    if (busy || !mayDiscardDraft()) return;
    void run(async () => {
      begin({ ...await api("workouts/" + workout.id), editing: true });
      $("workout-heading").scrollIntoView({ block: "start" });
    });
  });
  const remove = iconButton("trash", "Delete" + label, "delete-workout", () => {
    if (busy || !confirm("Delete the workout on " + workout.date + "?")) return;
    void run(async () => {
      await api("workouts/" + workout.id, "DELETE");
      if (editing && id === workout.id) begin();
      card.remove();
      say("Workout deleted.");
      void refresh();
    });
  });
  const copyStatus = node("div");
  copyStatus.setAttribute("role", "status");
  const copy = iconButton("copy", "Copy" + label, "copy-workout", async () => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      copyStatus.textContent = "Clipboard unavailable. Use a browser with clipboard access over HTTPS or localhost.";
      return;
    }
    copyStatus.textContent = "";
    try {
      const lines = [workout.date];
      workout.sets.forEach((set, i) => {
        if (startsExerciseBlock(workout.sets, i)) {
          if (i > 0) lines.push("");
          lines.push(set.exercise.replace(/[\r\n\u2028\u2029]+/g, " "));
        }
        lines.push(measurementLine(set));
      });
      await clipboard.writeText(lines.join("\n"));
      copyStatus.textContent = "Workout copied to clipboard.";
    } catch {
      copyStatus.textContent = "Could not copy workout. Check clipboard permissions and try again.";
    }
  });
  actions.append(edit, copy, remove);
  heading.append(node("h3", workout.date), actions);
  card.append(heading, copyStatus, setList(workout.sets));
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

import { durationUnits, loadUnits, maxAmount, maxExercise, maxReps, maxSets } from "./model.ts";

const options = (units: readonly string[]) => units.map(unit => `<option>${unit}</option>`).join("");

export const phonePage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gym</title>
  <link rel="stylesheet" href="/apps/gym/phone.css">
  <script type="module" src="/apps/gym/phone.js"></script>
</head>
<body>
  <header><h1>Gym</h1><a id="chat-link" href="/" hidden>Back to chat</a></header>
  <main>
    <p id="overview-warning" role="status" hidden></p>
    <section aria-labelledby="suggestion-heading">
      <h2 id="suggestion-heading">Suggested workout</h2>
      <p id="suggestion-note">Loading…</p>
      <ol id="suggestion-sets" hidden></ol>
      <button id="start-suggestion" type="button" hidden>Start from this</button>
    </section>
    <section aria-labelledby="workout-heading">
      <h2 id="workout-heading">Log workout</h2>
      <fieldset id="workout-editor" aria-labelledby="workout-heading" disabled>
        <label>Workout date <input id="workout-date" type="date" required></label>
        <label>Exercise <select id="exercise"></select></label>
        <div id="last-session" aria-live="polite" hidden></div>
        <form id="set-form" data-max-sets="${maxSets}">
          <div class="gym-set-inputs">
            <label>Duration <input id="duration" type="number" inputmode="numeric" min="1" max="${maxReps}" data-max-count="${maxReps}" data-max-measurement="${maxAmount}" required></label>
            <label>Duration unit <select id="duration-unit">${options(durationUnits)}</select></label>
            <label>Weight (optional) <input id="load" type="number" inputmode="decimal" min="0" max="${maxAmount}" step="any"></label>
            <label>Weight unit <select id="load-unit">${options(loadUnits)}</select></label>
          </div>
          <div id="historical-reps" hidden>
            <label>Additional recorded reps <input id="extra-reps" type="number" inputmode="numeric" min="1" max="${maxReps}"></label>
          </div>
          <div class="gym-actions"><button id="add-set" type="submit">Add set</button><button id="clear-set" type="button">Clear fields</button></div>
        </form>
        <ol id="draft-sets" aria-label="Workout sets"></ol>
        <div class="gym-actions"><button id="save-workout" type="button">Save workout</button><button id="reset-workout" type="button" hidden>Discard draft</button></div>
      </fieldset>
      <p id="status" role="status"></p>
      <p id="draft-warning" role="status" hidden></p>
      <dialog id="new-exercise" aria-labelledby="new-exercise-heading">
        <h3 id="new-exercise-heading">Add new exercise</h3>
        <form id="new-exercise-form">
          <label>Exercise name <input id="new-exercise-name" maxlength="${maxExercise}" required autofocus></label>
          <div class="gym-actions"><button id="confirm-exercise" type="submit">Use exercise</button><button id="cancel-exercise" type="button">Cancel</button></div>
        </form>
      </dialog>
    </section>
    <section aria-labelledby="recent-heading">
      <h2 id="recent-heading">Recent workouts</h2>
      <div id="recent-workouts">Loading…</div>
    </section>
  </main>
</body>
</html>`;

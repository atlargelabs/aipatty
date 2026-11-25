# Gym

**Plan, not built.** Gym is the first [connected app](CONNECTED-APPS.md): Steve logs workouts on a phone page,
and on a connected branch the model can search that log and suggest the next workout.

This replaces the pilot in PR #41, which was built before [the card pipeline](WEB-CARDS.md) and drew its own
header and tool cards with DOM code. Its store, input checks and phone page are the starting point here; its
`branch.js` and its changes to `page.ts` are not.

## Using it

1. Fork a branch for training and send `/connect gym` in it.
2. Tap **Log workout** in the strip above the transcript, or bookmark `/apps/gym/`. Pick an exercise, enter each
   set, and save.
3. In the branch, ask about progress or ask what to do next. A suggestion the coach saves appears on the page,
   ready to log against.

## Data

`data/apps/gym/gym.sqlite`, opened with `node:sqlite` and created with `CREATE TABLE IF NOT EXISTS` at open.

| Table | Columns |
| --- | --- |
| `workouts` | `id`, `date` (`YYYY-MM-DD`) |
| `sets` | `workout_id`, `position`, `exercise`, `reps`, `amount`, `unit` (`kg`, `lb`, `sec` or `min`) |
| `suggestion` | one row: `created` date, `note` text, `sets` as JSON in the shape of a workout's sets |

`reps` is optional, so a timed set such as a 60-second plank needs only an amount and a unit. There is no list
of exercises: a name is whatever was typed, compared without regard to case.

## The page

`/apps/gym/`, built for the phone.

- **Log:** choose the date (today by default), type or pick an exercise, and add sets one at a time with reps and
  a weight or a time. **Save workout** writes the whole workout.
- **Completion:** the exercise field offers every name already in the log.
- **Last time:** picking an exercise shows its sets from the most recent workout that had it, and fills the
  first set from them. Most sets repeat the last session, and this is what makes logging quick.
- **Suggestion:** when there is one, the page shows its note and sets, and **Start from this** loads the sets
  as the draft to correct and save.
- **Draft:** an unsaved workout is kept in the browser's `localStorage`, so a reload or a locked phone does not
  lose it. Saving or discarding clears it.
- **Recent workouts:** the newest 20, each of which can be edited or deleted.
- **Back to chat:** shown when the page was opened from a branch.

The page's API is `GET /apps/gym/api/overview` (recent workouts, exercise names, the suggestion), and `GET`,
`PUT` and `DELETE` on `/apps/gym/api/workouts/<id>`. `PUT` sends the whole workout with an ID the page made
up, as an upsert, so a retried save does not make a second workout.

## The tools

| Tool | Effect |
| --- | --- |
| `gym_query` | Runs one `SELECT` on a read-only connection to the log and returns a Markdown table of up to 100 rows. The schema is in the instructions. |
| `gym_suggest_workout` | Saves a note and a list of sets as the one current suggestion, replacing the last. An empty list clears it. |

- **Searching** is `gym_query`. SQL covers "when did I last squat", "bench progress this year" and "volume per
  week" without a tool for each.
- **Suggesting** is the model's job, done from the instructions and what it queried. The tool exists only to
  put the result on the phone page, where the workout happens.
- **Only the page writes workouts.** The model has no tool to log, edit or delete one. That removes the risk of
  a proposal being logged as done, and two writers editing one workout.
- **The instructions** give the schema, say to compare exercise names without case and not to mix units, and
  say to save a suggestion when Steve asks what to do next.

`gym_query` uses a read-only connection, one statement and a size cap. PR #41 also had an allow-list of SQL
functions and tables; that is dropped, because the model already has `bash` with the same file permissions.

## The cards

Gym's web module exports one step:

- a `gym_query` or `gym_suggest_workout` **result** is rendered as Markdown and gets a **Log workout** link;
- the matching **call** card, which is raw JSON arguments, is hidden;
- the **header** gets a **Log workout** link to `/apps/gym/?branch=<id>`.

Because the call is hidden, each tool's result and error message repeat what was asked for: the SQL, or the
suggested sets. A failed result is left as plain text.

## Build order

1. **The seam,** as [CONNECTED-APPS.md](CONNECTED-APPS.md) describes, tested with its fixture app. Done when a
   fixture app's tools, instructions, header link and card format appear on a connected branch and nowhere else.
2. **Log page.** The store, the page and its API. Done when Steve can log, correct and delete a workout on the
   phone, a second session of an exercise starts from the first, and the data survives a restart.
3. **Coach.** The two tools, the instructions and the step. Done when the coach answers a progress question
   from SQL shown as a table, and a suggestion it saves can be started from on the phone.

Unconnected branches behave as they do on `main` throughout.

**Then use it for two real workouts.** Carry on with apps only if logging takes about a minute, the coach uses
what was logged, and a second app looks easy to write against the seam. Otherwise fix the largest friction or
stop.

## Not handled, as decisions

- **Workouts from chat.** Describing a workout in chat does not log it. Add a `gym_save_workout` tool if typing
  into the page turns out to be the slow part.
- **Two devices editing at once.** A save replaces the whole workout, so the last one wins.
- **Backup.** The log is not in the upgrade backup; see [the seam's limits](CONNECTED-APPS.md#robustness).
- **Not now:** a multi-week programme, exercise metadata such as muscle groups, charts, rest timers, body weight
  and import or export.

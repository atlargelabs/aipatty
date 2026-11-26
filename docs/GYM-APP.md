# Gym

Gym is the first [connected app](CONNECTED-APPS.md). Log workouts on a phone; in a connected branch the coach
can read the log and suggest the next workout.

## Quickstart

On a running release that includes Gym, there is no setup beyond reaching the normal chat page. For a phone,
use [Tailscale Serve](INSTALL.md#optional-tailnet-browser-access) or the same tunnel you use for chat.

1. Use **New** to start a branch named **Training** and send `/connect gym` while it is idle. `/connect` lists the available
   apps and the branch's connections. A fork of **Training** inherits Gym; the root stays ordinary chat.
2. Tap **Log workout** above the transcript, or bookmark `/apps/gym/` on that origin. Pick an exercise, use
   **Add set** for each set, then **Save workout**. The page remembers unfinished drafts in that browser.
3. Go **Back to chat**. Ask “How have my squats changed?” or “What should I do next?” The latter should put a
   suggestion on the phone page. **Start from this** copies it into a draft; correct it and save what you
   actually did. It is not part of your history until you save it.
4. Send `/disconnect gym` to remove Gym's coach and card steps from that branch. The page and its data stay.

If Gym is unavailable, check `/connect` or `/health` for the reason and data path. Fix that and restart; the
branch still remembers the connection.

## Data

`data/apps/gym/gym.sqlite`, opened with `node:sqlite` and initialized on first use.

| Table | Columns |
| --- | --- |
| `workouts` | `id`, `date` (`YYYY-MM-DD`) |
| `sets` | `workout_id`, `position`, `exercise`, `duration`, `duration_unit` (`reps`, `m`, `sec`, `min`), `load`, `load_unit` (`kg` or `lb`), `extra_reps` |
| `suggestion` | one row: `created` date, `note` text, `sets` as JSON in the shape of a workout's sets |

Duration is independent of load. `reps` requires a positive whole count; `m` (metres), `sec` and `min` accept
positive fractional values. `NULL` load and unit mean no weight entered; an explicit zero with a unit means
bodyweight. `extra_reps` retains any additional rep count that was logged on a historical timed set.

At open, Gym upgrades the previous `reps`/`amount`/`unit` schema and saved suggestion in one transaction.
Weighted sets keep their rep count and weight, including zero; timed sets keep their time and any extra reps,
with no weight inferred. The old release cannot read the upgraded Gym database; see [Backup](#not-handled-as-decisions)
if keeping a pre-upgrade copy for rollback. No separate exercise catalog is stored: names from the log are
compared using SQLite `NOCASE` (ASCII case folding).

## The page

`/apps/gym/`, built for the phone.

- **Log:** choose the date (today by default), pick an exercise, and add sets one at a time. Duration starts in
  `reps`; change the unit for distance or time. Enter a weight in `kg` or `lb` if useful (e.g. 15 sec at 60 kg).
  **Save workout** writes the whole workout.
- **Exercise picker:** names come from the log, current workout and suggestion. **Add new** lets you use a
  name in this draft, reusing a matching name without regard to case. Cancel leaves your selection unchanged.
  New names become available to later workouts once logged.
- **Last time:** picking a known exercise shows the most recent matching sets and pre-fills the first set when
  the measurement fields are untouched. After adding a set, its fields stay filled for one-tap repeats.
- **Suggestion:** when there is one, the page shows its note and sets, and **Start from this** loads the sets
  as the draft to correct and save.
- **Draft:** an unsaved workout is kept in this browser's `localStorage` and normally survives reload or a
  locked phone. Saving or discarding clears it. If autosave fails, the page warns that recent edits may only
  be in memory. Slow workout-history requests do not stop you entering sets.
- **Recent workouts:** the newest 20, each of which can be edited or deleted.
- **Back to chat:** shown when the page was opened from a branch.

The page's API is `GET /apps/gym/api/overview` (recent workouts, exercise names, the suggestion),
`GET /apps/gym/api/last?exercise=<name>` (`{ date, sets }` from the newest matching workout across the whole log,
or `null`), and `GET`, `PUT` and `DELETE` on `/apps/gym/api/workouts/<id>`. `PUT` sends `{ date, sets }` with an
ID the page made up, as a transactional upsert, so a retried save does not make a second workout.
Each set is `{ exercise, duration, durationUnit, load, loadUnit, extraReps }`. On input, `durationUnit` can be
omitted for `reps`; `load` and `loadUnit` must be supplied together or left absent/null. `extraReps` is optional
and normally omitted. For example, `{ "exercise": "Carry", "duration": 20, "durationUnit": "m", "load": 60,
"loadUnit": "kg" }` records both measurements. The old input format is not accepted; reload a tab left open
before the upgrade. Previously autosaved browser drafts are converted on restore.

## The tools

| Tool | Effect |
| --- | --- |
| `gym_query` | Runs one `SELECT` on a read-only connection to the log and returns a Markdown table of up to 100 rows. The schema is in the instructions. |
| `gym_suggest_workout` | Saves a note and a list of sets as the one current suggestion, replacing the last. An empty list clears it. |

- **Searching** is `gym_query`. SQL covers "when did I last squat", "bench progress this year" and "volume per
  week" without a tool for each.
- **Suggesting** is the model's job, done from the instructions and what it queried. The tool takes the same
  set shape as the phone API and only puts the result on the phone page, where the workout happens.
- **Only the page writes workouts.** The model has no tool to log, edit or delete one. That removes the risk of
  a proposal being logged as done, and two writers editing one workout.
- **The instructions** give the schema, say to compare exercise names without case and not to mix units, and
  say to save a suggestion when Steve asks what to do next.

`gym_query` uses a read-only connection, checks for exactly one `SELECT` (including `WITH`), denies writes,
attachments and `WITH RECURSIVE` in SQLite, and caps the statement and result sizes. It has no allow-list of
functions or tables. Queries run synchronously without a query-time budget. Recursion is denied because it is
the one way a query over this small log could run without end and stop the server; a large cross join is still
slow. Neither tool is replayed after a restart: a call the server died during is reported to the model as
interrupted. This is an app tool boundary, not a sandbox: the model already has `bash` with the service
account's permissions.

## The cards

Gym's web module exports one step:

- a `gym_query` or `gym_suggest_workout` **result** is rendered as Markdown and gets a **Log workout** link;
- the **header** gets a **Log workout** link to `/apps/gym/?branch=<id>`.

The **call** card is left as it is, so the SQL or the suggested sets can be read there. A failed result is left
as plain text.

## Trial

The tests use a temporary Gym database and a scripted Faux coach. On a real phone, **try two real workouts**
before expanding the experiment. Carry on with apps only if logging takes about a minute, the coach uses what
was logged, and a second app looks easy to write against the seam. Otherwise fix the largest friction or stop.

## Not handled, as decisions

- **Workouts from chat.** Describing a workout in chat does not log it. Add a `gym_save_workout` tool if typing
  into the page turns out to be the slow part.
- **Two devices editing at once.** A save replaces the whole workout, so the last one wins.
- **Backup.** The log and current suggestion are not in the upgrade backup. To keep a separate copy, stop the
  server and copy `data/apps/gym/gym.sqlite`; see [the operator runbook](INSTALL.md#gym-pilot).
- **Not now:** a multi-week programme, exercise metadata such as muscle groups, charts, rest timers, body weight
  and import or export.

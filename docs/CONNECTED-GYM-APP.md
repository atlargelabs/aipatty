# Connected apps: Gym pilot

**Implemented for review in [PR #41](https://github.com/atlargelabs/aipatty/pull/41), not deployed.** The
stop/go decision still depends on Steve's two-workout trial. A connected app is a module that:

- adds tools and instructions to the branches it is connected to;
- controls a header and its own tool cards on those branches;
- serves its own page;
- owns its own data.

Gym is the first app: Steve logs workouts on a phone page, and the chat on a connected branch is the coach.
If an app fails, aipatty carries on as normal chat.

## Try it

1. Fork a branch for coaching, then send `/connect gym` in it. `/connect` lists apps and the branch's attachment.
   From the CLI, use `aipatty --branch <id> send '/connect gym'`. Main stays normal chat unless explicitly connected.
2. Tap **Open Gym** at the top of the branch or bookmark `/apps/gym/` on the same aipatty origin. Set the date,
   enter an exercise, reps and weight or a time, and tap **Add set** for each set; tap **Save workout** to log the
   list. To correct a set, tap **Edit** on a recent workout and on the set, then **Update set** and **Save workout**.
3. Ask the coach about progress or describe a workout you completed and ask it to log it. To change the current
   plan, ask it to save the plan explicitly. **Back to chat** returns to the branch when the page was opened from it.
4. Send `/disconnect gym` to remove the coach tools and Gym view; this does not delete the log or disconnect forks.

Recent workouts are the newest 20 by workout date. The header and tool cards show previews; the phone page shows
the full current plan. Use a separate data directory when trying a test release; see [INSTALL.md](INSTALL.md#gym-pilot).

## The seam

One interface in `src/apps/app.ts`, one explicit list of apps in the [host](../src/host.ts), and everything
Gym-specific in `src/apps/gym/`:

```ts
interface ConnectedApp {
  id: string;                    // "gym": used in URLs, the data directory and /connect
  title: string;
  instructions: string;          // added to the system prompt on connected branches
  open(dataDir: string): {       // called once at startup with data/apps/<id>/
    extension: Extension;        // its tools
    handle(req, res, path): Promise<void>;  // everything under /apps/<id>/
    close(): void;
  };
}
```

The host does four things for an app and knows nothing else about it:

- **Data directory:** it creates `data/apps/gym/` and passes it to `open`.
- **Routes:** it mounts `/apps/gym/*` behind the existing [Host/Origin checks and CSP](../src/api.ts).
- **Tools and instructions:** it selects the app's extension and instructions on connected branches, on top of
  the normal tools. Other branches don't get them.
- **Branch view:** on a connected branch, the [chat page](../src/page.ts) loads `/apps/gym/branch.js`.

The app never imports from the host, and the host never imports Gym internals.

## Connecting

The commands are handled like `/upgrade`: defined in [`src/protocol.ts`](../src/protocol.ts), intercepted before
the model, and answered with a transcript entry.

| Command | Effect |
|---|---|
| `/connect` | Lists the apps, whether each is available, and what this branch is connected to. |
| `/connect gym` | Connects this branch to Gym. |
| `/disconnect gym` | Returns the branch to normal chat. The Gym data is untouched. |

- **Marker:** the connection is one field, `app?: string`, on [`BranchDoc`](../src/branches.ts). It is the only
  record.
- **One app per branch:** connecting a second app is refused with a message naming the `/disconnect` to run first.
- **Idle only:** both commands are refused with a 409 while the branch is busy.
- **Idempotent:** running either command twice gives the same result.
- **Forks:** a fork copies the marker, so a fork of a Gym branch is another Gym conversation over the same log.

## Robustness

One rule covers every failure: **a branch gets its app only if the marker is set and the app opened
successfully; otherwise it is normal chat.**

A single function applies that rule to a branch by setting its extensions and instructions. It runs at startup
for every branch, on `/connect`, on `/disconnect` and on fork. A failed app is bypassed, not disconnected: the
marker stays, so the branch is a Gym branch again once the app opens.

| Failure | What happens |
|---|---|
| App fails to open at startup, for example a corrupt database | The error is logged, and its branches run as normal chat. `/connect` shows the app as unavailable with the data path, error and server log location. Each affected branch gets one transcript notice for that server start, as does a fork created while bypassed. |
| The app is fixed and aipatty restarts | Its branches are Gym branches again, with nothing to redo. |
| A tool throws | The model sees an ordinary tool error and the turn continues. |
| The page handler throws | That request returns a 500 with the message. Nothing else is affected. |
| `branch.js` fails to load or throws | The chat page uses the default rendering and shows a notice. |

Not handled, as decisions:

- **In-process code:** apps run inside the server. An app that hangs the event loop or crashes the process takes
  aipatty down until launchd restarts it. Apps are reviewed code in the repo, not installed at runtime.
- **Upgrade rollback:** `/upgrade` snapshots and restores only `aipatty.sqlite`. The Gym database is not rolled
  back on a failed upgrade, so its schema changes must stay additive.
- **Scope, not access control:** attachment selects coach tools and instructions, not access to private data.
  Anyone who can reach aipatty can open the Gym page; the normal host tools still have the service account's
  file permissions. Coaching turns can put workout data in the conversation and send it to the selected model.

## Branch formatting

`branch.js` exports two optional functions:

- `header(el)` fills a strip above the transcript with the link to the Gym page, the last workout and the
  current plan.
- `renderTool(call, result)` returns a DOM node for one of the app's tool calls, or nothing to get the default
  rendering.

The app does not change the composer or the transcript layout.

## Gym data

The database is `data/apps/gym/gym.sqlite`, opened with `node:sqlite` and created with
`CREATE TABLE IF NOT EXISTS` at open.

| Table | Columns |
|---|---|
| `workouts` | `id`, `date` (`YYYY-MM-DD`) |
| `sets` | `workout_id`, `position`, `exercise`, `reps`, `amount`, `unit` (`kg`, `lb`, `sec` or `min`) |
| `plan` | one row of text |

`reps` is optional so a timed set such as a 60-second plank needs only an amount and a unit.

## Gym page

The page is `/apps/gym/` and is built for the phone.

- **Entry:** pick or type an exercise, add sets one at a time with reps and a weight or time, then save.
- **Exercise completion:** there is no preset list. A `<datalist>` is filled from `SELECT DISTINCT exercise`,
  matched case-insensitively.
- **Recent workouts:** each can be edited or deleted.
- **Plan:** the current plan is shown as text, with a link back to chat.
- **API:** save is `PUT /apps/gym/api/workouts/<id>` with the whole workout and a client-generated ID, as an
  upsert. `DELETE` removes one.

## Gym tools

The page and the tools call the same functions in the Gym module.

| Tool | Effect |
|---|---|
| `gym_query` | Runs one SELECT on a read-only Gym connection. Joins, ordinary CTEs and common analytic functions work; writes, attachments, PRAGMAs and other databases do not. Returns up to 100 rows and 32 KiB; this caps the result, not query execution time. The schema is in the instructions. |
| `gym_save_workout` | The same upsert the page uses. |
| `gym_delete_workout` | Deletes one workout by ID. |
| `gym_save_plan` | Replaces the plan text. |

The instructions tell the coach to log a workout only when Steve says he did it, never from a plan or a
proposal, and to save a plan only when he asks.

## Build in three slices

1. **Seam and page.** Build the interface, the app list, the database and the page. Done when Steve can log,
   correct and delete a workout on the phone, completion offers an exercise he entered before, and the data
   survives a restart.
2. **Connect and coach.** First prove that pi-durable lets a branch's extensions and instructions change
   mid-conversation; the rule function depends on it. Then build `/connect`, `/disconnect`, the rule function
   and the four tools. Done when:
   - the coach answers a progress question from SQL and logs a workout Steve describes in chat;
   - the root branch has no Gym tools;
   - a disconnected branch still works with Gym tool calls in its history;
   - with the Gym database made unreadable, aipatty starts and the Gym branch works as normal chat.
3. **Branch view.** Build `branch.js` with the header and the tool cards. Done when a broken `branch.js` leaves
   the chat usable.

**Stop/go:** use it for two real workouts. Continue only if:

- logging takes about a minute;
- the coach uses what Steve logged;
- the seam looks small enough that he'd write a second app against it.

Otherwise fix the biggest friction or stop; don't add features to rescue the experiment.

**Not now:** a second app, scheduled jobs, runtime-installed apps, several apps on one branch, app databases in
the upgrade snapshot, and an app taking over the composer.

# Connected Gym app: pilot plan

**Proposal, not shipped.** Try one optional app on one Aipatty conversation branch. Can Steve log a workout
quickly on his phone and get better coaching from what he actually did? Keep ordinary chat as the coach and
add one small workout page. A future app might show usage for a deployed service; don't design that app or
extract a platform for it now.

## What Steve would do

1. Open the **Gym** branch on his phone and tap its single **Gym** link. Log a completed workout: on `2026-11-20`,
   squat **3 sets × 5 reps at 60 kg** and bench press **3 × 5 at 40 kg**. Save and see it in recent workouts.
   If he typed `600` for the squat, edit that workout and save `60`; don't create another workout. The page also
   shows the current saved plan as text and links back to chat.
2. After logging squats at `62.5 kg` for `3 × 5` on `2026-11-23`, ask in chat: “How have my squats changed,
   and what should I do twice a week next week?” The coach reads the log, cites those two dates and loads,
   and drafts a simple plan: “Day A: squat 3 × 5 at 62.5 kg; Day B: squat 3 × 5 at 60 kg. Draft, not saved.”
   If the log is empty or too sparse, say so rather than inventing progress.
3. “Save that as my current plan” saves the displayed text. To revise it, ask for a change, read the revised
   draft, then say “Replace my current plan with that.” The coach reports success only after the save succeeds.
   Discussion and plan saves never create workouts. After doing a planned session, Steve deliberately logs what
   he actually did on the page, even if it differs from the plan.

## One source of truth

Use one versioned, conversation-scoped pi-durable Gym document in the host's existing `aipatty.sqlite`,
patterned after [BranchDoc](../src/branches.ts): `history: "latest"`, `fork: "initial"`. Only the original Gym
branch has a stored Gym document; presence is the attachment, not the branch title. Store just:

- **Completed workouts:** stable ID, workout date, and exercise names with ordered sets (reps, load and unit
  per set). The form can repeat a set for `3 × 5` without a second stored representation. Default to the phone's
  local date, let Steve edit it, and store a real calendar date as `YYYY-MM-DD`, not a UTC timestamp. Require
  nonblank names, at least one exercise and one set per exercise, positive integer reps, and finite nonnegative
  loads with explicit `kg` or `lb`. Keep units as entered; compare like units, with no silent conversion.
- **Current plan:** one optional short block of plain text. Replacing it doesn't change the workout log.
  No planned-session records, program builder or separate plan history.

The page and tools call the same Gym backend, not each other:

- **Read:** return the latest ten workouts by workout date (stable order for ties) and the current plan.
- **Log or correct (page):** create a workout, or replace an existing record by ID with validated data.
  An edit of a missing record is an error. Reuse the workout ID on a retry: identical input returns the existing
  workout; different input needs an edit.
- **Replace plan (chat):** write the new current plan. The coach instructions say to read fresh, label drafts,
  and replace the plan only after Steve explicitly approves that draft. This is a coach rule, not a second
  authorization system. No separate plan editor or chat tools for logging workouts.

Use the same validation and pi-durable transactions for both entry points (`Conversation.commit` from the page's
handler and tool `api.commit` in chat). Report success only after the immediate write commits. On validation
failure keep the phone form and show what to fix; on an interrupted chat save read back the current plan before
asking to retry. No scraping transcripts or separate browser store.

## Wiring and boundaries

- **One built-in module.** Keep the Gym document, validation, operations, typed tools, instructions and phone page
  together (e.g. `src/apps/gym/`). The [host](../src/host.ts) registers it explicitly; the host's API and branch
  view mount the page/JSON handler and show the link for the attached branch. Reuse the [HTTP checks and CSP](../src/api.ts)
  and [page pattern](../src/page.ts): same listener and origin, separate same-origin JS/CSS, JSON requests, and
  render saved text as text. This is reviewed code in the Aipatty release, not a disposable Pi extension or a
  runtime-installed plugin.
- **One deliberate attachment.** A local operator setup action creates one fresh ownerless Gym branch, starting
  with the root's current model and thinking level. Initialize the Gym document and `pi.agent` settings in the
  same creation commit. On rerun, reuse the branch and apply the release's coach settings (e.g. adding the plan
  tool in slice 3), preserving its records and any model/thinking changes. No attach picker. Keep the current
  extensions as the host defaults, excluding Gym (pi-durable would otherwise select all registered extensions).
  Explicitly select the Gym extension on its branch and set `agent.tools` to the Gym tools, not just `modelTools`:
  the allowlist limits nested and deferred reachability too.
  No shell, file tools, Pi, codemode, tool search or branch tools in Gym chat. The page/JSON handler and tools
  check for an existing attachment on the requested or calling branch before touching data; the model can't
  supply a target branch.
- **Forks are ordinary chat.** No Gym link, live reads, writes, or copied log or plan; return to the original for
  those. In pinned pi-durable, `fork: "initial"` doesn't copy the document, but `pi.agent` is copied as of the
  fork entry. Even a fork of a fork can point back to a Gym entry. In Aipatty's shared fork path, explicitly
  clear `extensions`, `tools`, `modelTools` and `instructions` to host defaults in the creation commit, for both
  a history fork and an empty source. Those fields already default on ordinary branches; keep model/thinking
  and transcript behavior. Inherited chat and tool replies may still mention workouts. This avoids accidents;
  it's not a security boundary. Clients share the host's existing loopback/SSH or configured tailnet trust, and
  normal branches still have the service account's shell permissions.
- **Data stays outside the release.** Reopen the same database on restart or a successful upgrade; no separate
  files, tables or migrations. Put page writes behind the existing upgrade admission gate and accept none while
  startup is settling an upgrade. The [runbook](INSTALL.md#upgrade) restores the pre-switch SQLite snapshot on a
  failed upgrade, including Gym data already in it. It isn't continuous backup and doesn't recover later writes.
  A manual code rollback that keeps the same database keeps the records. Before stopping to roll back to a
  pre-Gym release, let Gym chat finish (or abort it and wait for idle) so the old server has no Gym work to resume.
  A pre-Gym release can't serve Gym or apply its fork rule; don't use or fork the Gym branch (or fork at inherited
  Gym entries) while on it.

## Build in three small slices

1. **Phone log.** Wire up the branch and page with log, recent workouts and correction. Done when Steve can
   enter the example on a phone, fix the typo, and see the corrected date, sets and units after reload and
   restart. Check invalid input leaves the log unchanged and repeating a save doesn't duplicate it.
2. **Read-only coach.** Answer the example question from stored rows, including a correction made after an
   earlier chat turn. Check normal chat retains its tools, Gym has no general tools (including nested/deferred),
   and direct, empty and inherited-entry forks get ordinary chat but no Gym data or route. Check Gym requests
   use the existing Host/Origin checks and the page works without relaxing CSP.
3. **Save one plan.** Add the replace-plan tool and display the result on the same page. Done when a proposal
   alone changes neither the log nor the plan, an explicit save then update shows exactly one current plan after
   reload, and doing the planned session changes nothing until Steve logs it. In a disposable install, verify an
   upgrade and a failed upgrade's snapshot restore with Gym data already present.

**Stop/go:** Try it for two real workouts. Continue only if each is quick enough to log on the phone (aim for about
a minute), the coach correctly uses both saved entries, and Steve would use the resulting plan. Otherwise fix the
biggest friction or stop; don't add features to rescue the experiment.

**Not now:** Wearables, nutrition, advanced analysis, reminders, multi-user access, dashboards, monitoring imports
or a scheduler. No generic manifest, lifecycle manager, renderer SDK, marketplace, separate auth, frontend stack,
service or database. If a second app is worth building later, reuse only the host wiring it actually needs.

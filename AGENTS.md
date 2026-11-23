# Working on aipatty

This file is for any agent that writes or reviews code here, including aipatty's own Pi runs and their reviewers.

## What aipatty is, and what that means for design

aipatty is one person's assistant on one Mac mini: one service account, one server process, one SQLite database,
reached over SSH. Nobody else has an account on the machine, there is one operator, and he can SSH in when something
breaks.

Design for that situation. Code that defends against hostile local users, concurrent operators, duplicate
requests from several clients, or platforms aipatty does not run on is cost with no benefit here.

## Build for robustness

Robust here means that after any failure, aipatty ends up running and its data is intact. Two properties do most
of the work, so look for them first.

- **Idempotency.** Write each operation so that running it again is harmless. Then a retry needs no bookkeeping,
  and recovery is "run it again". Restoring the database backup, repointing `deploy/current` and staging a release
  that already exists all give the same result the second time. Remove a marker last, so an interrupted operation
  is simply repeated.
- **Statelessness.** Keep durable state in as few places as possible and read it fresh each time a decision
  depends on it. Do not record what you can observe. Which release is live is the `deploy/current` link; whether
  a supervisor is running is whether its lock is held. A process that remembers nothing can be killed and
  restarted at any point. Every extra record of progress is something that can disagree with reality after a
  crash.

The rest follow from the same idea:

- **One fallback path that ends with something running.** Send every failure down it instead of adding a guarded
  state per failure. Stop and wait for the operator only when carrying on could lose data.
- **Recover at startup.** Treat a crash as the normal way to stop. A server that starts must cope with whatever
  the last one left, so correctness never depends on a clean shutdown.
- **Change things atomically.** Build the new thing beside the old one, then switch with a rename: a release
  directory, a JSON file, the `current` link. A reader never sees a half-written result.
- **Never edit a release.** `deploy/<sha>` is immutable. Deploying and rolling back only move a pointer, and
  the previous release and database backup are kept until the new one has proven itself.
- **One owner per resource.** One process owns the database and one supervisor runs at a time, each enforced by
  a lock the operating system releases when the process dies. These replace checks of process IDs and ownership.
- **Bound every wait.** Give each wait a timeout and a next step: ask a process to stop, then kill it; give a new
  release a minute to become healthy, then fall back.
- **Verify the end state.** Check what you actually want, such as `/health` reporting the expected commit,
  instead of trusting that each step returned success.
- **Errors say what to do next.** Name what failed, why, and the command or file that fixes it, as in
  `Model openai/gpt-x is unavailable. Run 'aipatty models' then 'aipatty model set <modelId>'.` The person reading
  it is often on a phone or in the conversation, without the code in front of them.
- **Do not repeat a check another gate already makes.** CI and the `protect-main` ruleset gate `main`, so a
  deploy does not run the test suite again.
- **Do one-time things by hand** and write the steps in `docs/INSTALL.md`.
- **Say what is not handled.** List the cases left out, in the docs, as decisions. A known limit in one sentence
  is better than fifty lines that cover it.

## Keep it easy to maintain

- **Build only what is needed now.** Solve the problem in front of you with the least code that does it. Leave
  out options, flags and abstraction layers until something needs them a second time. `docs/PLAN.md` works the
  same way: features are deferred until something needs them, and guards are added only after a real mistake.
  Code written for a need that never arrives still has to be read, tested and kept working.
- **One source of truth.** Define each constant, file format and rule once and import it everywhere it is used.
  The `/upgrade` command and its transcript entry kind live in `src/protocol.ts`, and the server, CLI and page
  all read them from there. Two copies drift apart, and the bug appears only where they meet.

## Reviewing, and answering a review

A finding is important when it is likely in this deployment, or when it loses data or leaves a broken release
running. A finding about a rare interleaving, a crash at one particular instant, or tampering by another local
process is not: answer it by naming the limit in the docs, or leave it.

Fixing review findings one at a time can make a change worse. Each fix adds a guard, the guard adds a state, and
the next review finds an edge in the new state. Signs that this is happening:

- A third round of fixes for the same concern.
- Commit subjects such as "Recheck ...", "Fail closed on ..." or "Prove ...".
- The change is several times larger than its description suggests, or the tests are larger than the code.
- The runbook grows manual recovery steps.

When you see these, stop adding guards. Ask what feature is producing the findings and whether it is needed, or
restate the design in a few sentences and rebuild to that.

The worked example is `/upgrade`. The first attempt (PR #20) grew to about 4,000 lines over 23 commits, 22 of
them hardening. Twelve of those dealt with processes left behind by running `npm test` during an upgrade, a step
CI already covered, and the result locked aipatty until the operator acknowledged a failed test run over SSH.
The rebuild (PR #21, `src/upgrade-supervisor.ts` and `src/upgrade.ts`) is about 1,000 lines with the tests and
docs, and recovers from the same failures without the operator.

## Tests and docs

- Test the paths that matter end to end, with real processes where the feature is about processes: success, the
  main failures, and recovery. Do not add a test per guard.
- When a feature fails, tell the user in the conversation what happened and why, and where the log is.
- Keep `README.md`, `docs/INSTALL.md` and `docs/PLAN.md` in step with the change in the same PR.

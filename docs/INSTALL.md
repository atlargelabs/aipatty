# Installing aipatty on the Mac mini

Start with a manually installed, committed `main` release using `--install-dir`. To upgrade it after Steve
merges a reviewed PR, use the [one-shot upgrade runbook](#upgrade-an-existing-installation). There is no
installer, launchd job, permanent supervisor, automatic upgrade, or automatic release deletion.

The default recommended service root is `~/aipatty` in the home of the account that will run aipatty. Set
`ROOT="$HOME/aipatty"` in each shell that runs these commands, so the path is absolute and quoted. Another
writable absolute path is fine; use the same root consistently. This is an install recommendation, not a change
to the server's no-flag defaults. Use a dedicated directory, not the home directory itself.

## Prerequisites and separate provisioning

- An existing standard macOS service account, called `aipatty` here, with its own writable home and none of
  Steve's credentials. Node 26 or newer, Git and `gh` must already be accessible to that account.
- **Optional machine provisioning:** if a new account or system-wide tools are needed, arrange that separately
  with the machine owner; it may require a macOS administrator. It is not part of the manual app install below,
  which needs neither `sudo` nor a macOS administrator account. No administrator provisions the install root.
- **GitHub maintainer setup:** before enabling PR publication, confirm the `pattycaik` service identity has write,
  not admin, access and `main` has the `protect-main` ruleset. Add `ci` as a required status check once the workflow
  is on `main`. These are repository permissions, not macOS administrator privileges; only Steve merges PRs.

## Once, as `aipatty`

Run the commands below as the service account. Set the install root; the first release step creates it along
with the `deploy/` and `pi/` directories.

```sh
ROOT="$HOME/aipatty"
```

1. **GitHub.** Give the `pattycaik` account an SSH key and sign `gh` in as it:

   ```sh
   ssh-keygen -t ed25519 -C pattycaik          # add the public key to the pattycaik account
   gh auth login --hostname github.com --git-protocol ssh
   git config --global user.name pattycaik
   git config --global user.email <pattycaik's noreply address>
   ssh -T git@github.com                       # "Hi pattycaik!"
   ```

2. **First release.** Resolve committed `main` to a SHA, confirm it is the intended release, and substitute that
   SHA for `<sha>` below. Releases are separate checkouts of committed `main`, one directory per commit:

   ```sh
   mkdir -p "$ROOT/deploy" "$ROOT/pi"
   git clone git@github.com:atlargelabs/aipatty.git "$ROOT/deploy/<sha>"
   cd "$ROOT/deploy/<sha>" && git checkout --detach <sha> && npm ci --ignore-scripts
   ln -sfn "$ROOT/deploy/<sha>" "$ROOT/deploy/current"
   ```

3. **Pi sign-in**, with the active release's pinned CLI, into this root's Pi directory:

   ```sh
   PI_CODING_AGENT_DIR="$ROOT/pi" node "$ROOT/deploy/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" auth login openai
   ```

4. **`delegates` settings**, in `$ROOT/pi/settings.json`. Its jobs and clones live under `$ROOT/pi/delegates/jobs/`.
   Checkout settings are not read, so the checks live here. The release's `npm ci` installs the pinned
   `pi-review`; do not run `pi install` or add it to Pi's `packages` settings. For `reviewExtension`, use the
   actual absolute value of `$ROOT/deploy/current/node_modules/@earendil-works/pi-review/review.ts`, with the
   `current` component intact. The example assumes `ROOT=/Users/aipatty/aipatty`; JSON does not expand `$ROOT`
   or `~`. If you use `--pi-dir`, edit `settings.json` in that directory instead.

   ```json
   {
     "delegates": {
       "version": 1,
       "reviewExtension": "/Users/aipatty/aipatty/deploy/current/node_modules/@earendil-works/pi-review/review.ts",
       "publication": { "repository": "atlargelabs/aipatty", "remote": "origin", "baseBranch": "main", "requiredChecks": [] },
       "environment": {
         "setup": [{ "name": "dependencies", "command": "npm ci --ignore-scripts", "timeoutMs": 600000 }],
         "checks": [
           { "name": "typecheck", "command": "npm run check", "timeoutMs": 120000 },
           { "name": "tests", "command": "npm test", "timeoutMs": 600000 }
         ]
       }
     }
   }
   ```

   The host checks this path resolves to the running release's pinned file before cloning for a PR run.
   Only `crmanager` loads the reviewer. Non-PR investigation does not require this setting.

For example, to refresh the shared model cache with the pinned CLI, run:

```sh
PI_CODING_AGENT_DIR="$ROOT/pi" node "$ROOT/deploy/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" update --models
```

## Start

From any working directory, with `ROOT="$HOME/aipatty"` (or your chosen root) set. Use the same port on every
start, bootstrap, upgrade and recovery; `8790` is the default:

```sh
PORT=8790
node "$ROOT/deploy/current/src/main.ts" --install-dir "$ROOT" --port "$PORT"
```

If this root has an interrupted upgrade, [recover it first](#diagnose-recover-or-start-manually). Do not run an
older server directly against an uncertain install: it cannot check a journal introduced by a later release.

The option derives `$ROOT/data` (or `$ROOT/faux` in faux mode), `$ROOT/pi`, `$ROOT/work`, and `$ROOT/runs`.
The database, ownership lock, and run logs live in the data directory; Pi auth, model cache, settings and jobs
live in the Pi directory. The pinned CLI and both extensions live in the release. Model scratch lives in `work`;
disposable Pi workspaces live in `runs`. An individual directory option overrides its derived path. Omitting the
root leaves the legacy defaults unchanged. The option is server-only; it adds no environment variable or API.
The server forwards its configured Pi directory to Pi subprocesses; bootstrap commands must set it explicitly.

For development or a checkout without `deploy/current`, use the literal absolute path to that checkout's
`node_modules/@earendil-works/pi-review/review.ts` (from the checkout root, print it with
`printf '%s\n' "$(pwd -P)/node_modules/@earendil-works/pi-review/review.ts"`). Set `delegates.reviewExtension`
in the selected Pi directory's `settings.json` (`~/.pi/agent/settings.json` if neither `--install-dir` nor
`--pi-dir` is given). Prefer a separate `--pi-dir` for development to avoid changing another checkout's or
service's settings. If launching a different checkout against the same settings, update the path while stopped.

From the laptop, using its own checkout for the CLI:

```sh
ssh -N -L 8790:127.0.0.1:8790 macmini &
node src/cli.ts health          # compare the commit with the expected release SHA
```

## Stop

From the service account, use the active release's CLI:

```sh
node "$ROOT/deploy/current/src/cli.ts" shutdown
```

Or run `node src/cli.ts shutdown` from the laptop over the SSH forward above. If using a non-default port,
pass `--port <n>` to the CLI and use that same port at both ends of the forward. `Shutdown requested.` only
acknowledges the request. Wait for the server process to exit before repointing `current` or starting another
server. For older releases without the command, or if the API is unreachable, use Ctrl-C in the server terminal
or send the server `SIGTERM`. These all use the same cleanup; see [CLI shutdown semantics](../README.md#cli).

## Upgrade an existing installation

Upgrade v1 supports a standard macOS or Linux account with a dedicated canonical installation root. It requires
`--install-dir`, a fixed nonzero port, and the derived `data` (or `faux`), `pi`, `work`, and `runs` directories.
These and `deploy/` must be real directories writable only by the service account, not shared writable paths,
separate symlinks, or overrides.
`deploy/current` must be a symlink selecting the running `deploy/<full-sha>` checkout. Do not change
`AIPATTY_FAUX` or use one root for both real and faux service installs. For older custom installs, use
[Fresh cutover](#fresh-cutover-from-an-old-installation); the helper does not migrate configuration or state.

Do not run a service manager/watchdog that respawns the app during this procedure. Disable any such respawn
before upgrading, especially with a legacy release which cannot read the journal. A future app service manager
is separate and must coordinate starts with upgrades. Use an ordinary service-account shell; don't run as root,
change a running release, run concurrent operators, or point the port at a different application.

### First bootstrap from a release without the upgrade command

This works with the legacy release that has `--install-dir`, the documented loopback shutdown API (including
`ea33846`), and the exclusive `data/owner.sqlite` lock. Keep the app up for the initial checks. Reserve an
exclusive maintenance window: finish all turns and Pi cleanup, stop sending messages from every client, and do
not start Pi or permit new work until the helper exits and any interrupted staging is resolved. The legacy
server cannot enforce this. The helper
requires idle branches, proves the legacy port and owner file belong to the same process (macOS `lsof` or Linux
`/proc`), checks its documented launch arguments, and refuses if it sees `pi-run.json`. It rechecks before
shutdown and after actual process exit. If a run record remains, **do not delete it**; let the old server finish
its normal run recovery before trying again. Legacy startup through a wrapper, with custom directory arguments,
or without an inspectable process and the documented API is unsupported.

After Steve has merged the upgrade PR and checked CI, stage committed `main` **without** changing `current` or
running npm in the new checkout. From the server's service account (use the actual root and port):

```sh
ROOT="$(cd "$HOME/aipatty" && pwd -P)"
PORT=8790
ORIGIN=git@github.com:atlargelabs/aipatty.git
(
  set -eu
  test -n "$ROOT"
  test -L "$ROOT/deploy/current"
  STAGE="$(mktemp -d "$ROOT/deploy/.bootstrap-XXXXXX")"
  git clone --single-branch --branch main --no-tags --no-checkout "$ORIGIN" "$STAGE"
  SHA="$(git -C "$STAGE" rev-parse --verify 'refs/remotes/origin/main^{commit}')"
  git -C "$STAGE" checkout --detach "$SHA"
  git -C "$STAGE" show -s --oneline "$SHA"
  test ! -e "$ROOT/deploy/$SHA"
  test ! -L "$ROOT/deploy/$SHA"
  mv "$STAGE" "$ROOT/deploy/$SHA"
  printf 'Staged %s\n' "$SHA"
)
```

Check that the printed commit includes the reviewed, merged upgrade. Set `SHA` to the printed full commit.
The helper independently fetches `main` again, requires that exact tip and compares the entire pre-install
worktree (including ignored paths). It installs and checks in a separate private checkout. Only the coordinator
can publish a verified copy of the checked dependencies into the clean staged release. If `main` advanced,
stage its new tip instead of editing
an existing checkout.
Use the same faux setting as the old server (normally unset):

```sh
SHA='replace-with-the-full-sha-printed-above'
HELPER="$ROOT/deploy/$SHA/src/upgrade-supervisor.ts"
node "$HELPER" bootstrap --install-dir "$ROOT" --port "$PORT"
node "$ROOT/deploy/current/src/cli.ts" --port "$PORT" health
```

It uses the same install/check, validation, and rollback code as chat, and the old CLI's shutdown protocol.
A `202` alone does not permit cutover. First result goes to the terminal and `$ROOT/upgrade/`, not a branch.
Verify the served SHA and existing transcript. If preparation fails, the old app keeps running. Treat every
staged directory as immutable after use: if the same destination is needed again, inspect and **move the
inactive directory out of `deploy/`** first; never edit an active or last-known-good release in place.

### First deploy from a release with an unpinned reviewer

If the legacy release predates PR #18, record the previous `delegates.reviewExtension` value (often absent)
**before** bootstrap. Keep the old reviewer checkout under `$ROOT/pi/git/github.com/earendil-works/pi-review/`
(or its previously configured file). Leave all settings unchanged during bootstrap: validation deliberately
makes no PR/model call. After bootstrap succeeds and `health` verifies the new pinned release, **before the
first PR run**, set just `delegates.reviewExtension` in `$ROOT/pi/settings.json` to the actual absolute path
`$ROOT/deploy/current/node_modules/@earendil-works/pi-review/review.ts` (expand `$ROOT` in the value; JSON does
not expand it). Preserve all other settings, especially publication and checks. Do not uninstall the old reviewer.

If bootstrap rolls back, no setting has changed and the legacy reviewer still works. If you later do an
operator-managed downgrade to a pre-pin release, restore the recorded value (delete the key if previously
absent) before allowing PR work there. Between pinned releases leave the `deploy/current` setting unchanged;
it selects the matching reviewer after a switch or rollback. The helper never edits shared Pi settings.

### Normal use from a conversation

After Steve merges the reviewed PR, enter exactly `/upgrade` in the chosen branch and confirm in the web page,
or use the upgrade-aware CLI (for example over the existing SSH forward):

```sh
node src/cli.ts --port 8790 --branch 2 send '/upgrade'
node src/cli.ts --port 8790 --branch 2 log
```

Omit `--branch` for the root. The host recognizes the command only on the existing operator message path,
with the explicit upgrader marker and a request ID. Prose, quotes, model and tool output, ordinary unmarked
submissions, and a repeated ID do not deploy. There is **no model-callable upgrade tool** and no target, repo,
or command argument. This uses the existing loopback/SSH trust boundary, not authentication of Steve by
name: another local process or someone with equivalent service-account/forward access can imitate an operator.
The app and Pi's shell tools still share the service account and are not an OS security boundary.

Wait for all branches to be idle and Pi start/cleanup/recovery to finish. Once accepted, the old app still
serves reads, but rejects new work (including Pi and other branch mutations) while the upgrade is pending. The
helper checks the pinned merge using `npm ci --ignore-scripts --include=dev`, `npm run check` and `npm test`;
it never deploys a working tree or bypasses GitHub merge protections. Same SHA is a no-op. A no-op or an
ordinary fetch, install, or type-check failure leaves the old app up and reopens admission. An unsuccessful
`npm test` cannot prove its detached fixtures stopped, so it is treated as interrupted staging and requires
explicit operator recovery. After a switch, refresh the page or reconnect if necessary:
the result is written once directly to that branch (not attributed to the user or generated by a model).

Readiness means the same process serves the expected SHA from the selected checkout, the SQLite/Durable host
opened, Pi recovery is clear, and both the root and requesting branch models are in the local catalog with no
saved work globally blocking scheduling. The candidate also checks it can still read the accepted branch
request. A plain HTTP 200 is insufficient. The candidate exposes only health until the same validated request
and selection have been committed. Upgrade targets must keep the managed startup/validation protocol; older
releases are supported only as the bootstrap source and rollback destination. This is local validation, not a
paid model call, an OAuth refresh, a network test, or a PR/reviewer run. The operator resolves missing catalog/login or reviewer
settings as usual. Apply the PR #18 setting change separately if applicable.

### Diagnose, recover, or start manually

`$ROOT/upgrade/journal.json` is the latest operation. Read it for the request ID, old SHA, pinned target, phase
and outcome; `$ROOT/upgrade/<id>.log` holds the stage, helper and replacement app's output. Standalone SQLite
backups at `$ROOT/upgrade/<id>.sqlite` include committed WAL frames. Keep the intact old release and the latest
successful backup; there is no automatic garbage collection. Do not remove locks, a pending journal/backup,
or the log the running app is still using. Before archiving anything, check it is not referenced by the current
journal or used by a running process. These are private service data.

Use the following from the service-account shell, with `ROOT`, `PORT` and `HELPER` set as above. For chat
upgrades, `HELPER` can be the script in the journal's old release; never assume `current` is the known-good
script while a switch is unfinished. For legacy bootstrap or legacy rollback, keep the staged modern helper,
even if `current` is legacy.

```sh
printf '%s\n' "$ROOT/upgrade/journal.json"
less "$ROOT/upgrade/journal.json"
ID='replace-with-the-request-id-from-the-journal'
less "$ROOT/upgrade/$ID.log"
node "$HELPER" recover --install-dir "$ROOT" --port "$PORT"
node "$ROOT/deploy/current/src/cli.ts" --port "$PORT" health
```

- `requested`: no stage started. `recover` or a normal start of the selected modern app can cancel the request.
- `staging`: no switch began and no upgrade backup or restore touched the DB. A worker that times out, exits
  unexpectedly, or loses its coordinator does not publish anything. The coordinator requires a completion
  response and normal exit before it can publish a checked copy. Staging assumes trusted `main` and foreground
  check commands; this is not a sandbox for code running as the service account.
  After interruption the journal remains pending, even if the worker and its commands appear to have exited.
  The helper does not infer quiescence from PIDs, timestamps, process groups, or a free lease. It does not
  signal leftover stage processes or remove their private checkout. Plain `recover`, another upgrade, and
  normal modern startup cannot clear the guard. Keep `$ROOT/deploy/.stage-$ID`, the journal and log intact.
  If the journal or the entire `$ROOT/upgrade/` directory is missing while a private stage remains, modern
  startup and new upgrade requests refuse to proceed. Preserve the stage and investigate the lost state; do
  not delete the stage to bypass the guard.

  In a maintenance window, stop new work and keep respawn disabled. **Verify the old coordinator, worker and
  all stage commands (including detached descendants) can no longer be running.** If you cannot positively
  account for all of them, gracefully stop the selected app and reboot the machine. Confirm a new boot (for
  example, compare `/proc/sys/kernel/random/boot_id` on Linux or `sysctl -n kern.boottime` on macOS before and
  after reboot) with respawn still disabled. A missing PID or a quiet log is not enough. Then intentionally
  acknowledge that exact request with the current runbook's helper:

  ```sh
  node "$HELPER" recover --install-dir "$ROOT" --port "$PORT" --ack-interrupted-stage "$ID"
  ```

  This records your acknowledgement under the install and worker leases, after verifying the old selection;
  it neither checks the boot boundary for you nor continues the deployment. It keeps the private directory
  and logs for inspection. After acknowledgement a surviving modern host can report the cancellation and
  reopen admission; if it does not, gracefully restart the selected app using the original configuration.
  A legacy app has no guard, so keep the maintenance window until acknowledgement completes. A coordinator
  may have already published an *inactive* release before it was interrupted; inspect it and, if necessary,
  move it out of `deploy/` before a fresh request. Never reuse an interrupted private checkout.
- `stopping`/`switching`/`restoring`/`restored`: don't start either release by hand. The new app refuses an
  unguarded start. `recover` verifies quiescence and restores the recorded old release as required, never a
  different or newer SHA. If an old app is still running after a failed handoff, stop that **verified** app
  with its own CLI (or Ctrl-C in its terminal) and wait for process exit before `recover`. Do not kill a random
  port listener. On a legacy rollback, continue the no-work maintenance window until recovery returns.
- `done`: no automatic restart or redeploy follows a later crash. `recover` verifies the selected release and
  rechecks that both the journal and pointer are unchanged before reporting the result. That is not a live
  health probe. If the app is stopped (e.g. reboot or a lost activation
  after commit), first run `recover` as the guard, then use the [normal start command](#start) on `current`
  with the original root, port, and faux setting. **Even if `current` is legacy, do this guard check first.**
  Verify `health` and the transcript once the app is back. If the branch result is still missing and `recover`
  reports it pending, check the log, fix any reported error, then gracefully stop and restart the selected app
  to retry delivery without deploying. Do not send `/upgrade` just to retry a result. Do not restore a
  pre-upgrade backup over a release that may already have accepted work after commit.

If rollback or recovery itself fails, leave the helper stopped and retain the journal, backup, all SQLite
sidecars, and releases. Keep respawn disabled. Over SSH or remote desktop, diagnose the named error (e.g. free
space, permissions, a known process still exiting, or a missing backup). After correcting it, rerun the
appropriate recovery command above. Do not point `current` by hand, delete `pi-run.json` or the journal to make startup pass,
or copy over a live SQLite file. If ownership or the backup can't be established, preserve the whole stopped
root and investigate from a copy before any manual data repair. There is no force/retry loop or second deploy engine.

## Fresh cutover from an old installation

While still on the old server with its old configuration, finish any active Pi runs or abort them and wait for
cleanup to settle. Do not start more runs. Check for a pending `pi-run.json` in the **actual old configured data
directory**: the old runbook used `--data-dir ~/data`, so check `~/data/pi-run.json` in that case, not the new
`$ROOT/data` or the legacy default unless that was the path actually used.

Stop the old server as above (use Ctrl-C or `SIGTERM` if the old release lacks `shutdown`), wait for it to exit,
and check that old path again. Shutdown during a Pi run deliberately leaves its record and cleanup for recovery
on the next start; a fresh root cannot see that record. **If `pi-run.json` remains after shutdown, do not delete it
or proceed with the cutover.** Restart the old server with the same old configuration (including its data, Pi,
and runs directories) to finish recovery. Confirm the record is gone, then shut down the old server and recheck
that it is still gone before starting the new one.
If recovery cannot clear the record, stop and investigate; do not bypass it by switching roots or deleting old state.

Only then start with a fresh root: do not migrate conversations. Reauthenticate with the pinned CLI as above and
set up delegates (including its pinned reviewer path) in the new Pi directory. Verify `health` reports
the expected SHA, `node src/cli.ts log` shows an empty transcript, and a send succeeds. Then exercise the actual Pi
run and review loop below. Only after all of those checks succeed, identify and delete old paths **confirmed** to be
owned solely by aipatty, if no longer needed. Never blindly delete `~/.pi`: it may contain other state. Preserve the
account's SSH keys and configuration, Git configuration, and `gh` login and settings.

## Prove the loop and redeploy

1. Ask for a small change: `node src/cli.ts send "Use the pi tool to ..."`.
2. The answer names an issue and a PR, the PR's head commit, and says `Review: reviewed`. Check that CI passed on
   that commit and that an actual `crmanager` Pi review ran.
3. Steve merges the PR.
4. Use [first bootstrap](#first-bootstrap-from-a-release-without-the-upgrade-command) once if needed. Otherwise
   request [`/upgrade`](#normal-use-from-a-conversation) from the branch. Keep the previous release and shared root.
5. Check `health` for the new commit and `log` for existing history and the upgrade result. Send another message.
   For a failed cutover use [recovery](#diagnose-recover-or-start-manually), not a live symlink or DB copy.

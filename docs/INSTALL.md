# Installing aipatty on the Mac mini

This is build steps 3 and 4 of [PLAN.md](PLAN.md): install by hand, prove that aipatty can change itself through a
reviewed PR, and from then on deploy with [`/upgrade`](#upgrade). The first release that has `/upgrade` is deployed
by hand. No installer, migration, or automatic deletion is involved.

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

From any working directory, with `ROOT="$HOME/aipatty"` (or your chosen root) set:

```sh
node "$ROOT/deploy/current/src/main.ts" --install-dir "$ROOT"
```

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

## Upgrade

With the server started as in [Start](#start), from a release that has the command, send `/upgrade` in any branch:
type it in the page, or run `node src/cli.ts send /upgrade` (add `--branch <id>` for a branch other than the root).
It is refused while any branch is busy or a Pi run is active; wait or abort first.

The server starts a one-shot supervisor, which fetches the tip of `main` into `$ROOT/deploy/<sha>` and runs
`npm ci --ignore-scripts` while the old server keeps running, then stops the old server, backs up the database,
repoints `current` and starts the new release. The new release checks itself as it starts. One of these lines then
appears in the branch that asked:

- `Upgrade complete. Now running <new>; was <old>.`
- `Already up to date: <sha> is the latest main.`
- `Upgrade failed before anything changed. Still running <old>.` with the reason: the release could not be fetched
  or installed. The old server never stopped.
- `Upgrade to <new> failed and was rolled back. Running <old> again.` with the reason and the end of the new
  server's output. The database is back as the old release left it.

After an upgrade or a rollback the server runs in the background, detached from the terminal that started the
first one. Stop it with the CLI as in [Stop](#stop) and start it by hand as before; nothing starts it at boot.

Everything the upgrade keeps is in `$ROOT/upgrade/`:

| File | What it is |
| --- | --- |
| `upgrade.log` | What the supervisor did, with times. |
| `server.log` | The output of the servers the supervisor started. |
| `backup.sqlite` | The database as the old release left it at the last switch. Replaced by the next upgrade. |
| `pending.json` | Present only between the switch and the new release passing its health check. |
| `result.json` | An outcome waiting for a running server to post it. |

**If an upgrade is interrupted**, for example the machine restarts during the switch, nothing may be running.
[Start](#start) the server as usual. It finds `pending.json`, restores the backup, points `current` back at the old
release, starts that release in the background and exits with a line saying so. The same can be run by hand, with
no server running:

```sh
node "$ROOT/deploy/<old sha>/src/upgrade-supervisor.ts" recover --install-dir "$ROOT"
```

**If the rollback fails too**, nothing is running and `upgrade.log` and `server.log` say why. `current` already
points at the old release; fix the cause and [start](#start) it.

`node src/cli.ts health` lists under `problems` what the startup health check found; an empty list is healthy. A
release started by hand runs with its problems listed, so they can be fixed. A release started by an upgrade must
have none. Old releases stay in `$ROOT/deploy/`; delete the ones you no longer want, keeping `current` and the one
before it. The [reviewer setting](#first-deploy-from-a-release-with-an-unpinned-reviewer) follows `current` and
needs no change between pinned releases.

## First deploy from a release with an unpinned reviewer

For an existing root, stage the new release with `npm ci --ignore-scripts`, then [stop](#stop) the old
server and wait for it to exit. Before starting the new release:

1. Note the old `delegates.reviewExtension` value (usually absent). Keep the old reviewer checkout under
   the Pi directory's `git/github.com/earendil-works/pi-review/` (or the previously configured file) if you
   may roll back to the old release. Keeping the files does not make the new release use them.
2. In the same shared `settings.json`, set just `delegates.reviewExtension` to the absolute `deploy/current`
   reviewer path shown above. Preserve the rest of the delegates configuration, including publication and
   checks. If the old `pi install` left a `pi-review` entry in `packages`, remove only that entry; no package
   registration is needed for either release, and you should not uninstall the retained reviewer.
3. Repoint `current` to the new release, start with the same configuration, and verify its commit with `health`.

Between pinned releases, leave the setting unchanged. To roll back to a release older than the pin, stop and
wait first, then restore the previous `delegates.reviewExtension` value (delete the key if the old release
used the fallback) before repointing `current` and restarting. PR runs on the old release need that legacy
reviewer file; if it was not retained, restore it before running PR work there. On returning to a pinned
release, set the `deploy/current` value again while stopped. No release edits the setting for you.

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
4. Deploy with [`/upgrade`](#upgrade). From a release that predates the command, deploy by hand once: make a
   release of the new committed `main` as in "First release", without changing the current
   symlink yet. Follow [Stop](#stop) and wait for the process to exit, then point `$ROOT/deploy/current` at the new
   release and start it again with the same root. Do not repoint while the server or a review is running: the
   reviewer setting follows `current`. For the first deploy over an unpinned release, make the
   [one-time settings change](#first-deploy-from-a-release-with-an-unpinned-reviewer) while stopped.
   Keep the previous release for rollback; preserve `$ROOT/data`,
   `$ROOT/pi`, `$ROOT/work`, and `$ROOT/runs` across both redeploy and rollback.
5. `node src/cli.ts health` reports the new commit, and `node src/cli.ts log` still has the conversation. Send it
   another message. For manual rollback, follow [Stop](#stop), repoint `current` at the retained release once the
   process exits, restart with the same root, and verify its SHA and conversation. Keep the same reviewer setting
   when rolling back between pinned releases; for an older release, restore its previous reviewer setting while
   stopped as described above. Ensure releases are compatible with the shared state.

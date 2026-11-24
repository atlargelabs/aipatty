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

### Managed Pi policy and state

| Path | What lives there |
| --- | --- |
| `$ROOT/deploy/<sha>/src/managed-pi/settings.json` | Managed delegates policy: publication to `atlargelabs/aipatty` on `origin` against `main`, `npm ci --ignore-scripts` setup, and required local checks `npm run check` and `npm test`. Review changes to this file in the repository, not on the Mac mini. |
| `$ROOT/deploy/<sha>/node_modules/` | Pinned Pi and extensions. The host checks this release's `@earendil-works/pi-review/review.ts` before cloning for a PR run; only `crmanager` loads it. No `pi install`, `packages` entry, or operator-supplied `reviewExtension` path is needed. |
| `$ROOT/pi/` (or `--pi-dir`) | Pi sign-in and refresh lock, model catalog cache, delegate jobs and clones under `delegates/jobs/`, and runtime files. No managed policy migration or credentials copy. |

Each Pi gets `delegates.maxParallel: 10` for concurrent top-level calls and batch width. It is not a global
pool or a hard total for nested jobs. The pinned `maxThinkers` default stays six. The managed launcher uses
Pi's built-in settings defaults in memory. Neither `<pi-dir>/settings.json` nor a checkout's `.pi/settings.json`
is used or edited for managed runs. Managed Pi also skips provider overrides from `models.json` and ambient
`SYSTEM.md` and `APPEND_SYSTEM.md` discovery. Delegate context (`AGENTS.md` and the reviewer's
`REVIEW_GUIDELINES.md`) comes from within the job's checkout, not the state directory or its parents. This does not disable the
shared `models-store.json` catalog cache or ordinary provider login and environment configuration. Do not
add local policy files for managed runs; keep existing files for standalone Pi or
[rollback](#first-deploy-with-release-owned-pi-settings).

Provision machine-specific executables and network settings separately, in the service account's trusted
environment, not in the release. For example, use `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` for Pi HTTP
traffic if needed instead of legacy `settings.json`'s `httpProxy`. The separate fetch egress proxy is described
below. Managed Pi does not import legacy `settings.json` API keys; use the normal pinned CLI for sign-in.

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
The database, ownership lock, and run logs live in the data directory; Pi auth, model cache and jobs live in
the Pi directory. The pinned CLI, extensions and managed settings live in the release. Model scratch lives in
`work`; disposable Pi workspaces live in `runs`. The browser's run pane reads a bounded excerpt from `data/logs/runs/`
(or `logs/runs/` under the configured data directory), not the disposable clone. Removing an archive leaves the
chat intact but removes its replay. An individual directory option overrides its derived path. Omitting the
root leaves the legacy defaults unchanged. The option is server-only; it adds no environment variable or API.
The server forwards its configured Pi directory to Pi subprocesses; bootstrap commands must set it explicitly.

A development checkout uses its own installed reviewer and versioned policy the same way, without
`deploy/current`. Use a separate `--pi-dir` to isolate its login, caches and jobs from the service if needed.
The raw CLI used for sign-in and updating the cache is still ordinary standalone Pi, not the managed launcher.

From the laptop, using its own checkout for the CLI:

```sh
ssh -N -L 8790:127.0.0.1:8790 macmini &
node src/cli.ts health          # compare the commit with the expected release SHA
```

## Optional coding extensions

Each release brings its own pinned `just-web-fetch`, `pi-web-search` and `pi-claude-code` via
`npm ci --ignore-scripts`. Rollback uses the previous release's versions. Do not register them with `pi install`,
Pi's `packages` settings, or delegate profiles. The top-level `pi` tool supplies absolute `-e` paths to its
release's entries. Ambient extension and checkout resource discovery stay off. These tools are not available
in aipatty's durable conversations, delegate jobs, or `crmanager` reviews.

- **`web_fetch`:** provision Chrome/Chromium for the service account. The tool looks in standard install
  locations or uses `PUPPETEER_EXECUTABLE_PATH` (a trusted absolute executable path). Install `trafilatura`
  separately, for example with `uv tool install trafilatura` or into a service-owned Python virtual environment.
  Set `PI_WEB_FETCH_TRAFILATURA` in the server's environment to the absolute path of that executable. The managed
  tool never invokes `uvx`, `pipx`, or another on-demand installer inside a run; no browser is downloaded.
  **Before enabling fetch,** provision a trusted forward proxy that blocks private and special-purpose addresses
  at connection time, including for HTTPS tunnels, and restrict the browser's network access to that proxy.
  Set `PI_WEB_FETCH_EGRESS_PROXY` in the server's environment to its HTTP(S) origin (no credentials or path).
  Without that setting the tool fails closed; Chrome receives a fixed proxy with no direct fallback. Upstream
  URL/redirect checks and the Chrome sandbox stay on, but are not a substitute for network enforcement. Missing
  prerequisites fail only the fetch call. The adapter ignores `just-web-fetch.json` and disables all fetch hook
  directories and event-bus registration. Complete extracts are temporary files in the Pi agent dir; archived
  tool events may retain web content.
- **`web_search`:** uses the coding model if supported. Managed Pi ignores both the machine's
  `PI_WEB_SEARCH_CONFIG` and the Pi directory's `web-search.json`. It points the extension at the running
  release's `src/managed-pi/web-search.json`, intentionally absent here: at this pin an absent file selects the
  current model, whereas `{}` is invalid. A future release could opt into a different provider/model by shipping
  a valid `{"provider":"<provider>","model":"<model-id>"}` there. The extension sends queries and any supplied
  URLs to the selected provider using its Pi auth and routing. Native search and `url_context` depend on the
  model, provider and account. A working chat subscription does not guarantee native search. There is no
  fallback or automatic sign-in; search may incur separate usage outside the run's reported model cost.
  Do not send private URLs, code or credentials as queries.
- **Claude Code (experimental):** only an explicit `model: "claude-code/<model-id>"` in a top-level `pi` call enables
  it. The operator must provision Claude Code on the service account's `PATH` (or set an absolute
  `PI_CLAUDE_CODE_COMMAND`) and sign it in under that account with a supported Claude subscription. Aipatty does
  not install or log in to Claude Code, copy its credentials into Pi, or opt in to usage credits. Explicit Claude
  runs perform CLI status and account model discovery before sending a task. Discovery may contact Claude's
  catalog and feature-flag services but sends no task prompt. The requested exact Pi model ID must be in that
  catalog; a missing CLI, login or model fails without switching models. An account's usage/overage policy still
  applies. OpenAI remains the default, with no Claude contact on ordinary runs.

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

With the server started as in [Start](#start), from a release that has the command, ask for an upgrade in any
branch: type `/upgrade` in the page, or run `node src/cli.ts upgrade` (add `--branch <id>` for a branch other than
the root).
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
before it. Every release with release-owned policy uses its own reviewer and settings, with no shared path to
update on upgrade or rollback.

## First deploy with release-owned Pi settings

Keep the same Pi directory and leave legacy Pi configuration and old reviewer files in place.
There is **no `maxParallel` edit, reviewer-path edit, installation of global extensions, or settings migration**.
Use the normal upgrade or, by hand, install with `npm ci --ignore-scripts`, [stop](#stop) and wait, repoint
`current`, start with the same directory options, and verify the commit and `problems` with `health`. Follow
[the run state cutover](#pi-run-state-cutover-and-rollback) below when coming from a singleton release.

On rollback to another release with managed settings, just select that release; the reviewer is resolved from
its actual checkout, not through `current`. A rollback to an **older** release that reads local settings uses
its retained file as before. The old pinned-reviewer runbook required an absolute `deploy/current` path to
`node_modules/@earendil-works/pi-review/review.ts` in `delegates.reviewExtension`. Older unpinned releases may
instead use an explicit legacy path or the retained `git/github.com/earendil-works/pi-review/review.ts` under
`--pi-dir`. If an older release was never configured on this host or its legacy settings are no longer present,
use that release's own `docs/INSTALL.md` while stopped to restore its settings and reviewer before running PR
work. Returning to this release needs no edit. No release moves the login, cache or job directory.

## Pi run state cutover and rollback

Use the **actual configured data directory** for these checks: usually `$ROOT/data`, or the override
`--data-dir`. For example, the old runbook used `--data-dir ~/data`, so check `~/data`, not the new root.

| Path under the data directory | Purpose |
| --- | --- |
| `pi-runs/<run-id>.json` | Pending run checkpoint, from startup through cleanup; contains the branch, task and process ownership evidence. |
| `pi-run.json` | Pending checkpoint from a singleton release. The new release reads and recovers it in place; do not copy or rename it into `pi-runs/`. |
| `logs/runs/<run-id>/result.json` | Primary settled result and usage, archived before the checkpoint is cleared. `reconciled.json`, if present, is an intermediate cleanup checkpoint, not a terminal result. |
| `pi-outcomes/<task-id>.json` | Pointer from a durable task to its run's archive. The old shared `pi-outcomes.json` is still read for older calls. |

For a same-root first deploy, let all branches finish (or abort their runs and wait for cleanup and the tool
results to be committed). Do not start more runs. [Stop](#stop) the old release and wait for it to exit before
changing `current` and starting the new release with the same data, Pi and runs directories. If a valid old
singleton checkpoint remains after shutdown, the new release can recover it with those same directories;
it never relaunches the call. Leave the Pi state and legacy settings in place.

**Before rolling back to a singleton release or switching to a fresh root**, likewise drain all Pi runs and
wait for the tool results in their branches. Stop and wait for the server to exit, then inspect both `pi-run.json`
and `pi-runs/` in the old/currently configured data directory. The legacy file should be absent and there
should be no pending records in `pi-runs/` (the directory may be absent or empty; `*.json.<uuid>.tmp` files
are not committed records). **If any checkpoint remains or the state cannot be read, do not switch releases
or roots or delete the evidence.** An old binary cannot see `pi-runs/`, and a fresh root cannot see the old
state. Restart the release that can read the records, with the same data, Pi and runs directories, to finish
recovery and let the interrupted tool results commit. If a checkpoint is damaged or still cannot be cleared,
stop and investigate using the console diagnostics, saved process identities and run logs; do not bypass the
hold. Drain, stop and recheck before repointing `current` or switching roots. Keep the data and logs for rollback.

## Fresh cutover from an old installation

Drain and verify the old state as described in [Pi run state cutover and rollback](#pi-run-state-cutover-and-rollback)
before changing roots.

Only then start with a fresh root: do not migrate conversations. Reauthenticate with the pinned CLI as above.
The release already supplies delegates policy and the reviewer. Verify `health` reports the expected SHA,
`node src/cli.ts log` shows an empty transcript, and a send succeeds. Then exercise the actual Pi
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
   release and start it again with the same root. Do not repoint while the server or a review is running.
   Keep the previous release for rollback; preserve `$ROOT/data`, `$ROOT/pi`, `$ROOT/work`, and `$ROOT/runs`
   across both redeploy and rollback.
5. `node src/cli.ts health` reports the new commit, and `node src/cli.ts log` still has the conversation. Send it
   another message. For manual rollback, [drain and verify Pi run state](#pi-run-state-cutover-and-rollback),
   repoint `current` at the retained release after shutdown and those checks, restart with the same root, and
   verify its SHA and conversation. [Only older releases](#first-deploy-with-release-owned-pi-settings) need
   their retained local settings and reviewer configuration. Ensure releases are compatible with the shared state.

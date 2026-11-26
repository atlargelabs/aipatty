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

4. **`delegates` settings**, in `$ROOT/pi/settings.json`. Job state and clones live under `$ROOT/pi/delegates/jobs/`.
   New Aipatty runs write delegate logs directly to `$ROOT/data/logs/runs/<run-id>/delegates/<job-id>/`
   (under `--data-dir` if overridden). No settings change is needed for log placement. Checkout settings are not read, so the checks live here. The release's `npm ci` installs the pinned
   `pi-review`; do not run `pi install` or add it to Pi's `packages` settings. For `reviewExtension`, use the
   actual absolute value of `$ROOT/deploy/current/node_modules/@earendil-works/pi-review/review.ts`, with the
   `current` component intact. The example assumes `ROOT=/Users/aipatty/aipatty`; JSON does not expand `$ROOT`
   or `~`. If you use `--pi-dir`, edit `settings.json` in that directory instead.

   ```json
   {
     "delegates": {
       "version": 1,
       "maxParallel": 10,
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
   Only `crmanager` loads the reviewer. The host does not require this setting for `pr: false` runs, which
   must not push or create/update issues, PRs or remote branches. These runs still clone the project unless
   `clone: false` is set and `base` is omitted. The scratch workspace has no project history, remotes or
   base lookup; its empty local Git repository keeps Git operations and shared delegates from discovering
   an enclosing checkout. No-PR is a workflow rule, not a security boundary.

### Enable ten delegates per Pi

**Existing installs:** when deploying this release, stop the service as in [Stop](#stop) and wait for it to
exit. Edit `$ROOT/pi/settings.json` (or `settings.json` under the configured `--pi-dir`) once. Inside the
existing `"delegates"` object, add `"maxParallel": 10` (or change that key's value to the number `10`).
If the object does not exist yet, add `"delegates": { "maxParallel": 10 }` to the top-level object. Keep
valid JSON and preserve all other keys and values, including the reviewer path and checks. If the value is
already `10`, no edit is needed. Then deploy/start as usual. The host does not write this setting or change
the extension's default, and upgrading without the edit does not prevent Pi from running.

The pinned extension reads this trusted setting independently in each Pi. It limits concurrent top-level
delegates and the batch width per Pi; ten is **not** a shared limit across conversation branches or a hard cap
on all nested jobs. Leave `maxThinkers` as it is (six by default). Do not put the setting in a checkout's
`.pi/settings.json`; managed Pi does not load it.

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
live in the Pi directory. The pinned CLI and extensions live in the release. Model scratch lives in `work`;
disposable Pi workspaces live in `runs`. The browser's run pane reads a bounded excerpt from `data/logs/runs/`
(or `logs/runs/` under the configured data directory), not the disposable workspace. Removing an archive leaves the
chat intact but removes its replay. An individual directory option overrides its derived path. Omitting the
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

## Optional tailnet browser access

Use [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) for a private HTTPS bookmark on a
phone or laptop. No Caddy or change to the listener is needed. The CLI still uses loopback (directly or over SSH).

1. Connect the mini and the client devices to your tailnet. **Before enabling Serve**, check Tailscale's
   **Access controls**: only your identity should be allowed to reach the mini's TCP port `443`. A broad
   allow rule still grants access; the default policy typically allows all tailnet members. aipatty has no
   login of its own. Anyone who can reach Serve can read conversations and operate aipatty. Do not use Funnel.
2. On the mini, run `tailscale serve status` first to make sure you are not replacing an existing handler at
   `https://<mini>.<tailnet>.ts.net/`. Then run:

   ```sh
   tailscale serve --bg http://127.0.0.1:8790
   ```

   Use your actual listener port if it differs from `8790`. If prompted, follow Tailscale's link to enable HTTPS
   for the tailnet, then rerun the command. Copy the HTTPS URL the command prints (the exact name, not just
   `macmini` or its Tailscale IP).
3. Once `deploy/current` is on a release with `--tailscale-origin`, [stop](#stop) the old process if one is
   running. As the service account, start with the same install root and options as before, adding that URL:

   ```sh
   node "$ROOT/deploy/current/src/main.ts" --install-dir "$ROOT" \
     --tailscale-origin https://macmini.example.ts.net
   ```

   Keep this option on manual restarts. `/upgrade` carries it across restarts and rollback when started from a
   release that supports it. If you manually roll back to an older release that doesn't know the option, take
   it off the launch command and use SSH until you return to a supported release.
4. With Tailscale on, open the printed URL on your phone or laptop. Check `/health` at the same URL and compare
   its commit to the expected release, then send a message and check that the reply updates live. A `502`
   usually means aipatty isn't running on the port named in `tailscale serve status`; a `403` from aipatty
   means the startup URL is missing or doesn't match the browser's URL. Saved messages render Markdown using
   the parser bundled with the release; this needs no CDN or extra browser setup.

To remove the default HTTPS route, run `tailscale serve --https=443 off` on the mini. Drop
`--tailscale-origin` the next time you start aipatty. The SSH forward is unaffected.

## Optional coding extensions

Each release brings its own pinned `just-web-fetch`, `pi-web-search` and `pi-claude-code` via
`npm ci --ignore-scripts`. Rollback uses the previous release's versions. Do not register them with `pi install`,
Pi's `packages` settings, or delegate profiles. The top-level `pi` tool supplies absolute `-e` paths to its
release's entries, including for `pr: false, clone: false`. The managed copy of the pinned `delegates` extension
is staged from local release files; it does not clone the project. Ambient extension and checkout resource
discovery stay off. The top-level web tools are not automatically inherited by delegates, and are not available
in aipatty's durable conversations or `crmanager` reviews.

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
- **`web_search`:** uses the coding model if supported, or an explicitly configured search model in the trusted
  Pi agent dir (`$ROOT/pi/web-search.json` for a root install, or the selected `--pi-dir`). That file accepts
  `{"provider":"<provider>","model":"<model-id>"}`; `PI_WEB_SEARCH_CONFIG` is ignored in managed runs. The
  extension sends queries and any supplied URLs to the selected provider using its Pi auth and routing. Native
  search and `url_context` availability depend on the model, provider and account. A working chat subscription
  does not guarantee native search. There is no fallback or automatic sign-in; search may incur separate usage
  outside the run's reported model cost. Do not send private URLs, code or credentials as queries.
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

## Gym pilot

No new service, credentials or settings are needed. Once the running release includes Gym, open the usual chat
page on the phone, tap **New** to create a training branch, and send `/connect gym`. Follow the [Gym quickstart](GYM-APP.md)
for logging and coaching, then use it for two real workouts before deciding what to change.

Check `/connect` or `aipatty health` (`appProblems`) if Gym is missing. The diagnostic names the app data path;
see the server's output (`$ROOT/upgrade/server.log` for a supervisor-started server). Fix the problem and restart;
the branch's saved connection is retained. Do not delete the database as a fix.

The workout log and current suggestion live in `$ROOT/data/apps/gym/gym.sqlite` (`$ROOT/faux` in Faux mode).
The upgrade backup below does **not** cover this file. To back up Gym, stop the server, wait for its process to
exit, and copy `gym.sqlite` to a private backup location. App pages use the chat listener's Host/Origin checks,
not separate authentication: only let people you trust with the workout log reach aipatty.

Before a manual downgrade to a release without connected apps **keeping the current conversation database**,
use `/disconnect gym` on each connected branch while still running this release. For an archived branch, send it
with `aipatty --branch <id> send '/disconnect gym'`. Otherwise the old release
can retain the workout instructions without the tools. This does not delete the Gym log. Reconnect the
branches when running a release with Gym again. Automatic `/upgrade` rollback restores its prior conversation
database and needs no such step.

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
| `backup.sqlite` | The conversation database as the old release left it at the last switch (not app data). Replaced by the next upgrade. |
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

## Pi run state cutover and rollback

Use the **actual configured data directory** for these checks: usually `$ROOT/data`, or the override
`--data-dir`. For example, the old runbook used `--data-dir ~/data`, so check `~/data`, not the new root.

| Path under the data directory | Purpose |
| --- | --- |
| `pi-runs/<run-id>.json` | Pending run checkpoint, from startup through cleanup; contains the branch, task and process ownership evidence. |
| `pi-run.json` | Pending checkpoint from a singleton release. The new release reads and recovers it in place; do not copy or rename it into `pi-runs/`. |
| `logs/runs/<run-id>/result.json` | Primary settled result and usage, archived before the checkpoint is cleared. `reconciled.json`, if present, is an intermediate cleanup checkpoint, not a terminal result. |
| `logs/runs/<run-id>/delegates/<job-id>/` | Live delegate diagnostics and, after cleanup, the final job manifest. Old interrupted runs still recover logs from their job directories without removing the originals. |
| `pi-outcomes/<task-id>.json` | Pointer from a durable task to its run's archive. The old shared `pi-outcomes.json` is still read for older calls. |

For a same-root first deploy, let all branches finish (or abort their runs and wait for cleanup and the tool
results to be committed). Do not start more runs. [Stop](#stop) the old release and wait for it to exit before
changing `current` and starting the new release with the same data, Pi and runs directories. If a valid old
singleton checkpoint remains after shutdown, the new release can recover it with those same directories;
it never relaunches the call. Make the [one-time delegates setting edit](#enable-ten-delegates-per-pi) while
stopped.

**Before rolling back to a singleton release or switching to a fresh root**, likewise drain all Pi runs and
wait for the tool results in their branches. Stop and wait for the server to exit, then inspect both `pi-run.json`
and `pi-runs/` in the old/currently configured data directory. The legacy file should be absent and there
should be no pending records in `pi-runs/` (the directory may be absent or empty; `*.json.<uuid>.tmp` files
are not committed records). **If any checkpoint remains or the state cannot be read, do not switch releases
or roots or delete the evidence.** An old binary cannot see `pi-runs/`, and a fresh root cannot see the old
state. Restart the release that can read the records, with the same data, Pi and runs directories, to finish
recovery and let the interrupted tool results commit. If a checkpoint is damaged or still cannot be cleared,
stop and investigate using the console diagnostics, saved process identities and run logs; do not bypass the
hold. Drain, stop and recheck before repointing `current` or switching roots. Keep the data and logs for rollback;
the ten-delegate setting is also supported by the previous pinned release.

## Fresh cutover from an old installation

Drain and verify the old state as described in [Pi run state cutover and rollback](#pi-run-state-cutover-and-rollback)
before changing roots.

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
   [one-time reviewer setting change](#first-deploy-from-a-release-with-an-unpinned-reviewer) while stopped.
   For the per-branch release, also [enable ten delegates per Pi](#enable-ten-delegates-per-pi).
   Keep the previous release for rollback; preserve `$ROOT/data`,
   `$ROOT/pi`, `$ROOT/work`, and `$ROOT/runs` across both redeploy and rollback.
5. `node src/cli.ts health` reports the new commit, and `node src/cli.ts log` still has the conversation. Send it
   another message. For manual rollback, [drain and verify Pi run state](#pi-run-state-cutover-and-rollback),
   repoint `current` at the retained release after shutdown and those checks, restart with the same root, and
   verify its SHA and conversation. Keep the same reviewer setting
   when rolling back between pinned releases; for an older release, restore its previous reviewer setting while
   stopped as described above. Ensure releases are compatible with the shared state.

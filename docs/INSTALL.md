# Installing aipatty on the Mac mini

This is build step 3 of [PLAN.md](PLAN.md): install by hand, then prove that aipatty can change itself through a
reviewed PR. Use a committed `main` release containing `--install-dir`. Deploys and rollback are manual; the
supervisor is future work (step 4). No installer, migration, or automatic deletion is involved.

Choose one absolute root, here `ROOT=/opt/aipatty`, and use it consistently. Commands run as the `aipatty` user on
the mini unless they say otherwise. Set `ROOT=/opt/aipatty` in each shell that runs them. The root is private and
writable by the service user, not a security boundary against that user.

## Once, as an administrator

1. Create a standard macOS user `aipatty`. It gets none of Steve's credentials.
2. Install Node 26 or newer, Git and `gh` where that user can run them.
3. Provision `/opt/aipatty` as a private directory owned and writable by `aipatty` (for example, create it as
   administrator, set its owner to `aipatty`, and its mode to `0700`).
4. Add the `ci` check to the `protect-main` ruleset as a required status check, once the CI workflow is on `main`.

## Once, as `aipatty`

```sh
ROOT=/opt/aipatty
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

4. **pi-review**, installed in the same Pi directory for now ([PLAN.md](PLAN.md#pi-extensions)):

   ```sh
   PI_CODING_AGENT_DIR="$ROOT/pi" node "$ROOT/deploy/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" install git:github.com/earendil-works/pi-review
   ```

   Then remove the `packages` entry it added to `$ROOT/pi/settings.json`: runs load no packages, and the copy
   in `$ROOT/pi/git/github.com/earendil-works/pi-review/` is what `delegates` reads. The pinned CLI and
   `delegates` extension are loaded from the active release; pi-review remains in the Pi directory for now.

5. **`delegates` settings**, in `$ROOT/pi/settings.json`. Its jobs and clones live under `$ROOT/pi/delegates/jobs/`.
   Checkout settings are not read, so the checks live here:

   ```json
   {
     "delegates": {
       "version": 1,
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

For example, to refresh the shared model cache with the pinned CLI, run:

```sh
PI_CODING_AGENT_DIR="$ROOT/pi" node "$ROOT/deploy/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" update --models
```

## Start

From any working directory, with `ROOT=/opt/aipatty` set:

```sh
node "$ROOT/deploy/current/src/main.ts" --install-dir "$ROOT"
```

The option derives `$ROOT/data` (or `$ROOT/faux` in faux mode), `$ROOT/pi`, `$ROOT/work`, and `$ROOT/runs`.
The database, ownership lock, and run logs live in the data directory; Pi auth, model cache, settings, jobs, and
installed pi-review live in the Pi directory. Model scratch lives in `work`; disposable Pi workspaces live in `runs`.
An individual directory option overrides its derived path. Omitting the root leaves the legacy defaults unchanged.
The option is server-only; it adds no environment variable or API. State is outside the release tree. The server
already forwards its configured Pi directory to Pi subprocesses; bootstrap commands must set it explicitly as above.

From the laptop, using its own checkout for the CLI:

```sh
ssh -N -L 8790:127.0.0.1:8790 macmini &
node src/cli.ts health          # compare the commit with the expected release SHA
```

## Fresh cutover from an old installation

Stop the old server before starting the new one. Start with a fresh root: do not migrate conversations. Reauthenticate
with the pinned CLI as above and configure pi-review and delegates in the new Pi directory. Verify `health` reports
the expected SHA, `node src/cli.ts log` shows an empty transcript, and a send succeeds. Then exercise the actual Pi
run and review loop below. Only after all of those checks succeed, identify and delete old paths **confirmed** to be
owned solely by aipatty, if no longer needed. Never blindly delete `~/.pi`: it may contain other state. Preserve the
account's SSH keys and configuration, Git configuration, and `gh` login and settings.

## Prove the loop and redeploy

1. Ask for a small change: `node src/cli.ts send "Use the pi tool to ..."`.
2. The answer names an issue and a PR, the PR's head commit, and says `Review: reviewed`. Check that CI passed on
   that commit and that an actual `crmanager` Pi review ran.
3. Steve merges the PR.
4. Deploy by hand: make a release of the new committed `main` as in "First release", without changing the current
   symlink yet. Stop the server (Ctrl-C or `SIGTERM`), point `$ROOT/deploy/current` at the new release, and start it
   again with the same root. Keep the previous release for rollback; preserve `$ROOT/data`, `$ROOT/pi`, `$ROOT/work`,
   and `$ROOT/runs` across both redeploy and rollback.
5. `node src/cli.ts health` reports the new commit, and `node src/cli.ts log` still has the conversation. Send it
   another message. For manual rollback, stop the server, repoint `current` at the retained release, restart with
   the same root, and verify its SHA and conversation. Ensure releases are compatible with the shared state.

# Installing aipatty on the Mac mini

This is build step 3 of [PLAN.md](PLAN.md): install by hand, then prove that aipatty can change itself through a
reviewed PR. Deploys are manual until the supervisor exists (step 4).

Commands run as the `aipatty` user on the mini unless they say otherwise.

## Once, as an administrator

1. Create a standard macOS user `aipatty`. It gets none of Steve's credentials.
2. Install Node 26.3 or newer, Git and `gh` where that user can run them.
3. Add the `ci` check to the `protect-main` ruleset as a required status check, once the CI workflow is on `main`.

## Once, as `aipatty`

1. **GitHub.** Give the `pattycaik` account an SSH key and sign `gh` in as it:

   ```sh
   ssh-keygen -t ed25519 -C pattycaik          # add the public key to the pattycaik account
   gh auth login --hostname github.com --git-protocol ssh
   git config --global user.name pattycaik
   git config --global user.email <pattycaik's noreply address>
   ssh -T git@github.com                       # "Hi pattycaik!"
   ```

2. **First release.** Releases are checkouts of committed `main`, one directory per commit:

   ```sh
   mkdir -p ~/deploy ~/work ~/runs ~/data
   git clone git@github.com:atlargelabs/aipatty.git ~/deploy/<sha>
   cd ~/deploy/<sha> && git checkout --detach <sha> && npm ci --ignore-scripts
   ln -sfn ~/deploy/<sha> ~/deploy/current
   ```

3. **Pi sign-in**, with the release's own CLI, into the service account's Pi directory (`~/.pi/agent`):

   ```sh
   node ~/deploy/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js auth login openai
   ```

4. **pi-review**, from the agent directory for now ([PLAN.md](PLAN.md#pi-extensions)):

   ```sh
   node ~/deploy/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js install git:github.com/earendil-works/pi-review
   ```

   Then remove the `packages` entry it added to `~/.pi/agent/settings.json`: runs load no packages, and the copy
   in `~/.pi/agent/git/github.com/earendil-works/pi-review/` is what `delegates` reads.

5. **`delegates` settings**, in `~/.pi/agent/settings.json`. Checkout settings are not read, so the checks live here:

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

## Start

```sh
cd ~/deploy/current
node src/main.ts --data-dir ~/data --work-dir ~/work --runs-dir ~/runs
```

From the laptop:

```sh
ssh -N -L 8790:127.0.0.1:8790 macmini &
node src/cli.ts health          # the commit is the release's
```

## Prove the loop

1. Ask for a small change: `node src/cli.ts send "Use the pi tool to ..."`.
2. The answer names an issue and a PR, the PR's head commit, and says `Review: reviewed`. Check that CI passed on
   that commit.
3. Merge the PR.
4. Deploy by hand: make a release of the new `main` as in "First release", stop the server (Ctrl-C or `SIGTERM`),
   point `~/deploy/current` at the new release, and start it again. Keep the previous release for rollback.
5. `node src/cli.ts health` reports the new commit, and `node src/cli.ts log` still has the conversation. Send it
   another message.

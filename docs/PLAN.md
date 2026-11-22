# aipatty: plan for the minimal agent

aipatty is a personal assistant agent that runs on Steve's Mac mini. The next goal is self-upgrade with a human merge
and deploy gate: ask aipatty for a change, get a tested PR, merge it, request an upgrade, and see the result in the same
conversation. The conversation host, branch tree, CLI, web page, and commit-reporting `/health` already exist.

## Decisions

| Area | Decision |
| --- | --- |
| Base | A small host of our own on the `@earendil-works/pi-durable` library. Not p2 or p3; p2's plugins are reference code only. |
| Remote access | HTTP and WebSocket on loopback only, one crude web page, and a CLI client. The laptop reaches them through an SSH port forward; the phone's route is not settled (see [Remote access](#remote-access)). No notifications. |
| Merging | Only Steve merges PRs in `atlargelabs/aipatty`. |
| Upgrade | Explicit, never automatic. If rollback also fails, Steve uses SSH or remote desktop. |
| GitHub identity | The `pattycaik` account with write access, behind a ruleset on `main`. Other repos only when Steve directs it. |
| Coding | Aipatty has pi-durable's built-in tools for inspection, scratch work and `gh`. Work intended for a PR goes to its own pinned Pi CLI in a disposable workspace, with the `delegates` and `pi-review` extensions installed. Pi can write the change directly or through a delegate. Every PR is reviewed by a `crmanager` delegate, and Pi keeps fixing until no important finding remains. |
| Tree | Branches are independent workstreams. Steve and aipatty can both fork. All branches stay listed. No automatic report-back. |
| Models | Default `openai/gpt-6.2-sol`, on the `openai` provider with the OpenAI subscription, for aipatty's conversations and for Pi runs. Per-branch model, set by Steve or by aipatty. Spark later. Claude through the `pi` CLI only, for now. |
| Cost | Shown per branch and in total as `$<branch> / $<total>`. No spend limit. |
| macOS account | A standard user `aipatty`; Steve keeps administrator access. |
| Guard rails | No approval prompts. The `protect-main` ruleset with required CI is the enforcement. No hooks for now. |
| MCP | Gmail first (`aipattychestnut@gmail.com`). OAuth by link. Gmail is off by default and off for every new branch; it is switched on per branch. |

## Shape

One Node process runs a pi-durable `Harness` over SQLite. A small supervisor beside it is planned for step 4;
until then releases are deployed and rolled back manually.

- **Stack:** TypeScript on Node 26. The Pi packages (`pi-durable`, `pi-ai`, `pi-codemode`, `chord`, `pi-schema`, and
  the `pi-coding-agent` CLI) are pinned at exactly 1.6.0 from npm, all at the same version so the host and the CLI share
  one `pi-ai`. Later bumps are normal reviewed PRs.
- **Service installation layout:** an administrator provisions a private, service-user-writable absolute root,
  `ROOT=/opt/aipatty`. Manual committed-main releases live at `$ROOT/deploy/<sha>`, with dependencies installed
  per release and `$ROOT/deploy/current` pointing at the active one. Keep the last-known-good release for rollback.
  - `$ROOT/work/`: working directory of aipatty's own tools, for inspection and scratch, not PR work.
  - `$ROOT/runs/`: disposable workspaces for [`pi` runs](#pi-runs).
  - `$ROOT/data/`: SQLite, logs, and later upgrade state and MCP configuration and sign-ins.
  - `$ROOT/pi/`: shared Pi sign-in, model cache, delegates settings and jobs.

  The server-only `--install-dir` derives these four state paths (using `$ROOT/faux` instead of
  `$ROOT/data` in faux mode); each individual directory option takes precedence. Without it the legacy defaults
  remain unchanged. It adds no environment variable or API. Launch from any cwd with
  `node "$ROOT/deploy/current/src/main.ts" --install-dir "$ROOT"`. State stays outside releases on redeploy and
  rollback; see [INSTALL.md](INSTALL.md) for the manual procedure and fresh cutover.
- **Conversations:** one root plus forks. Each has a title and its own model.

### Pi installation

Aipatty installs its own copy of the upstream `@earendil-works/pi-coding-agent` 1.6.0 as an exact-version runtime
npm dependency. Commit the lockfile and install with `npm ci --ignore-scripts`. Launch the executable from the
running release by absolute path, never via `PATH` or `npx`. Do not fork Pi or update it in place with `pi update`;
bump the dependency through a reviewed PR so rolling back aipatty also rolls back its Pi CLI.

Use a dedicated Pi agent directory owned by the `aipatty` account, outside the release and run directories. The
legacy default is `~/.pi/agent`; the root install derives `$ROOT/pi`. Point the host and CLI at the same
path: for root installs explicitly set `PI_CODING_AGENT_DIR="$ROOT/pi"` for pinned CLI login/bootstrap, pi-review
installation, and model-cache commands (see [INSTALL.md](INSTALL.md)). The host and CLI share that account's OpenAI sign-in (`auth.json`, with compatible refresh locking) and the Pi
model catalog cache (`models-store.json`, which supplies models newer than the bundled catalog). Steve bootstraps the service
login with the pinned CLI; neither process uses Steve's personal Pi install, settings, or credential files. When
bumping Pi, verify that the active and rollback releases can both use the shared sign-in and model cache.

### Pi extensions

Pi runs use two extensions, and only these two:

- **`delegates`** (`github.com/stephenchestnut/delegates`): the `delegate` and `delegate_parallel` tools, with the
  `thinker`, `thinktank`, `worker`, `prmanager` and `crmanager` profiles. The run loads it with `-e`.
- **`pi-review`** (`github.com/earendil-works/pi-review`): the `/review` command. The run does not load it.
  `delegates` loads it inside a `crmanager` job and runs `/review` there without its interactive UI.

Neither is published on npm. `delegates` is a git dependency pinned to a full commit SHA, so the lockfile fixes
it and a rollback of aipatty rolls it back too; the run loads the copy in the running release by absolute path.
`pi-review` is to be pinned the same way. For now it is the copy `pi install` puts in the agent directory, which
`delegates` finds by itself and which is not tied to a release.

`delegates` reads its settings from the service account's `settings.json` in the Pi agent directory, not from the
checkout:

- **Publication:** `atlargelabs/aipatty` as the one authorized repository, with base branch `main`.
- **Models:** none set. The extension's defaults are on the `openai` provider: `openai/gpt-6.2-sol` for every
  profile except `crmanager`, which reviews with `openai/gpt-6.2-astra`.
- **Review extension:** unset for now, so `delegates` uses the `pi install` copy at
  `git/github.com/earendil-works/pi-review/review.ts` in the agent directory. Once `pi-review` is pinned,
  `delegates.reviewExtension` names the pinned `review.ts` by absolute path.
- **Checks:** `npm ci --ignore-scripts` as setup, and `npm run check` and `npm test` as required checks. A
  `prmanager` refuses to submit with no checks configured, and the copy in the repo's `.pi/settings.json` is not
  read because checkout settings stay untrusted.

`delegates` keeps its jobs, logs, and `prmanager` and `crmanager` clones in `delegates/jobs/` under the agent
directory, outside `runs/`.

**Not settled:** how to pin `pi-review`. The settings file is shared by every release, but a pinned `review.ts`
sits at a different absolute path in each one. `reviewExtension` needs either a stable path to the active release
or an update on each deploy and rollback.

## Tools the model gets

| Tool | What it does |
| --- | --- |
| `read`, `write`, `edit`, `bash`, `codemode`, `tool_search` | pi-durable built-ins, working in `work/`. |
| `pi` | Runs one Pi session on a bounded coding task in a fresh clone and returns the result to the calling branch. One run at a time across all branches. Inside the run Pi may delegate the work, and always delegates the review. |
| `upgrade` | Asks the supervisor to deploy the latest `main`, when Steve asks for it. Refuses while a `pi` run is active. |
| `fork_branch`, `list_branches`, `read_branch`, `set_model` | Tree management, plus paging and text search over any branch. |
| `mcp_status`, `mcp_reload`, `mcp_sign_in` | Later: server state, re-reading `mcp.json`, and OAuth by link. |

Pass relevant conversation context in the handoff. A branch-reading interface for Pi can come later if needed;
Pi does not receive aipatty's MCP tools.

## `pi` runs

Every `pi` call starts a fresh session. A later run does not inherit the session or checkout. Published issues and PRs,
the tool result, and operator logs remain available.

1. **Request and workspace:** refuse if another run is active. Record the run ID, calling branch, requested
   outcome, and base, then create `runs/<run-id>/`. `atlargelabs/aipatty` is the only allowed repo for now. Clone it
   with the service account's GitHub access and record the resolved base SHA.
2. **Launch:** use the pinned CLI in one-shot JSON mode (`--mode json --no-session`). Collect structured events and
   stderr separately. Use `openai/gpt-6.2-sol` unless the call names another model. Disable automatic loading of
   checkout settings and executable resources, extensions, and MCP, then load the pinned
   [`delegates` extension](#pi-extensions) explicitly. Aipatty can ask Pi to delegate particular work or leave
   that to Pi; the tool does not map a task to a profile.
   Give Pi the git-hygiene skill and issue workflow: every change has an issue, a task branch, and a PR linking the
   issue, and Pi runs `npm run check` and `npm test` before it pushes. Pi passes the same rules to any writable
   delegate. Only Steve merges.
3. **Review:** when the change is committed, Pi delegates a review to a `crmanager`: `/review branch main` before
   a PR exists, `/review pr <number>` after. A `crmanager` is read-only, runs no tests and returns findings only.
   Important findings are those tagged P0 or P1, and any that give the verdict "needs attention". Pi fixes them,
   or continues the `prmanager` job that opened the PR, reruns the checks, and starts a fresh `crmanager` on the
   new commit. It repeats until a review of the final commit reports no important finding. Lesser findings go in
   the result without blocking it. If the runtime bound ends the loop first, the result says so and lists what
   remains.
4. **Result:** return a typed outcome with the run ID, summary, the last review's verdict and reviewed SHA, and,
   when a PR was requested, the issue and PR links. Confirm with `gh` that the PR exists and report its head SHA.
   A successful process exit or a URL in model output is not proof of delivery. [CI](#guard-rails) on that head SHA is the authoritative check; the tool does
   not wait for it. This holds whether Pi or a `prmanager` opened the PR. Charge the usage Pi reports, including
   its delegates' usage, to the calling branch once, and mark it incomplete when it cannot be recovered. Bound the
   runtime and tool-result size.
5. **Abort and cleanup:** on abort or timeout, stop Pi and its child processes, delegates included, before
   releasing the run slot. On exit, retain the transcript and diagnostics in `data/logs/runs/`, including the logs
   of the run's delegate jobs. Then delete the disposable workspace and the clones those jobs left under the agent
   directory, which `delegates` does not remove itself. Treat logs as private service data.
6. **Restart:** after taking the data-directory lock and before resuming conversations, stop any surviving processes
   owned by interrupted runs and finish cleanup. Report the call as `interrupted`, with any known PR link. Never
   rerun a call or repeat publication automatically.

Deferred until something needs them: a read-only research mode, concurrent runs, and repos other than aipatty.

## Remote access

- **API:** bound to `127.0.0.1`, with no listen address to configure. List branches, send, steer, abort, fork, set
  the model, stream live output, and `/health` with the running commit.
- **Page:** branch list, transcript, input box, fork button, model picker, and cost. Add a Gmail switch when Gmail ships.
- **CLI:** the same API from a terminal.
- **Auth:** SSH to the mini. The server has no login of its own and answers only to `127.0.0.1` or `localhost` at
  its own port, so a web page on another site cannot drive it through a browser.
- **Laptop:** `ssh -N -L 8790:127.0.0.1:8790 macmini`, then the page or the CLI at `127.0.0.1:8790`.
- **Phone:** not settled. An SSH app can hold the same forward, but iOS suspends it in the background. The
  alternative is `tailscale serve` on the mini, which would need an option naming the public origin the server
  accepts; that option is not built and the route is not tested.

## Upgrade and rollback

This section describes the future supervisor, not an implemented or required part of the manual install.

1. Steve says "upgrade" in a branch and aipatty calls the `upgrade` tool. The tool refuses while a Pi run is
   active and blocks new runs once it accepts. It persists a request ID and the calling branch, hands off to the
   supervisor, and ends the turn.
2. The supervisor fetches `main` from the configured origin and resolves it once to a target SHA. Install and check
   that release separately before stopping the current process. Deploy only committed `main`; never build a release
   from a Pi workspace or a PR branch.
3. Stop the current process, copy the SQLite database, and start the target release. Verify `/health` reports the
   expected SHA and that the host is ready to accept work. A 200 can already mean the saved model is unavailable,
   so status code alone is insufficient. If staging fails, leave the old release running. If startup or readiness
   fails, stop the new release, restore the database copy, restart the intact last-known-good release, and verify it
   too. Keep the copy until the next successful upgrade.
4. Persist the outcome so the running release can post it once in the requesting branch, including the active SHA
   and any rollback reason. Resume the existing conversation; if rollback also fails, retain diagnostics for Steve
   to recover over SSH or remote desktop.

The supervisor is a small launchd daemon that runs as `aipatty`, installed once by an administrator, so it starts
at boot without a login. It is not replaced by the normal aipatty upgrade.

## Guard rails

- **Enforced outside the agent:** `pattycaik` has write, not admin; the `protect-main` ruleset; a standard macOS user
  with none of Steve's credentials in its home.
- **`protect-main` ruleset:** no deletion, no force push, PR with one approval required, the CI check required to
  pass, and only repository admins may update `main`, through a PR. Admins can merge a PR without the approval,
  since an author cannot approve their own PR.
- **CI:** a GitHub Actions workflow runs `npm ci --ignore-scripts`, `npm run check` and `npm test` on Node 26 for
  every PR and every push to `main`. A PR can change the workflow itself, so Steve reviews workflow changes before
  merging.
- **No hooks for now:** the ruleset already stops `pattycaik` pushing to or merging into `main`. Add hooks against
  mistakes only if a real one shows up. Aipatty's own `write`, `edit` and `bash` start in `work/` but are not
  confined to it: they have the service user's permissions, including write access to `deploy/` and `data/`.
- **Disposable runs:** fresh workspaces keep one run's checkout out of the next. Working directories are not
  OS isolation; Pi and its delegates still have the service user's permissions. Deleting a workspace does not undo
  publication.

## Gmail and OAuth

- **Server:** Google's hosted Gmail MCP server, reported at `https://gmailmcp.googleapis.com/mcp/v1`, in developer
  preview. It needs a Google Cloud project and an OAuth client marked for AI-agent use, owned by
  `aipattychestnut@gmail.com`. Reported to read, search, draft and label, not send. Verify against Google's page
  before building.
- **Sign-in:** `mcp_sign_in` returns a link. Steve approves in a browser and pastes back the address it lands on.
  `pi-mcp` ships both halves (`startMcpSignIn`, `completeMcpSignIn`).
- **Why off by default:** email is untrusted text, and the agent has a shell and GitHub access.

## Build order

1. **Done: skeleton and tree.** Durable SQLite conversations, restart/resume, subscription login, loopback API,
   CLI and web page, per-branch models and cost, and `/health` reporting the commit.
2. **Done: the Pi tool.** [CI](#guard-rails), the Pi packages at 1.6.0 with the [pinned Pi CLI](#pi-installation)
   and the pinned `delegates` [extension](#pi-extensions), pi-durable's coding tools, codemode and tool search in
   `work/`, and the [run contract](#pi-runs) with the git/issue workflow. Tested with a fake CLI: a second run
   refused, missing auth or model, malformed output, false success, abort, child cleanup, restart, the launch
   loading only the pinned extension, delegate usage charged once, delegate clones removed, and a result not
   reported as reviewed when its review is missing, has important findings, or covers a different SHA from the PR
   head. The real CLI, with both extensions and the review loop, is first exercised in step 3.
3. **Install on the mini and prove the loop by hand.** From the laptop over SSH, ask aipatty for a small change to
   itself. It opens an issue and a checked PR that a `crmanager` has reviewed. Steve merges and deploys it by
   hand; verify the new SHA and keep talking in the original conversation. At this point aipatty can help build the supervisor.
   The steps are in [INSTALL.md](INSTALL.md).
4. **Automate explicit upgrade and rollback.** Install the supervisor and replace the manual deploy with the
   `upgrade` tool. Repeat the end-to-end test and verify the originating branch reports the new SHA.
   Test a release that fails readiness and confirm the old release and conversation come back with the failure
   reported. This is the self-upgrade milestone.
5. **After self-upgrade:** phone access, MCP configuration and OAuth, the per-branch switch, and Gmail. Add research
   mode, concurrent runs, hooks, or more repos only when needed.

## Setup only Steve can do

- Create the `aipatty` user on the mini, provision the private writable `/opt/aipatty` root, and install Node 26 or newer, Git, and `gh`. Set up the service account's
  model sign-in with the release's Pi CLI and configure `pattycaik`'s SSH key and `gh` login. Write the
  [`delegates` settings](#pi-extensions) into the service account's Pi agent directory. Confirm `main` protection,
  with the CI check required, before enabling PR publication. No global Pi install or copy of Steve's dotfiles is
  needed.
- Fix SSH from the laptop to `macmini` (host key verification fails), and later install the launchd supervisor.
- For Gmail later, create the Google Cloud project and OAuth client.

## Left for aipatty to build

Claude for its own conversations, the Spark models, notifications, a chat bot, report-back from branches, approval
prompts, archiving, better search, and `pi` runs that survive a restart.

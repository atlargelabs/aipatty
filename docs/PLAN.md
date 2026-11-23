# aipatty: plan for the minimal agent

aipatty is a personal assistant agent that runs on Steve's Mac mini. Its change loop keeps a human merge and
deploy gate: ask aipatty for a change, get a tested PR, merge it, explicitly request an upgrade, and see the
result in the same conversation.

## Decisions

| Area | Decision |
| --- | --- |
| Base | A small host of our own on the `@earendil-works/pi-durable` library. Not p2 or p3; p2's plugins are reference code only. |
| Remote access | HTTP and WebSocket on loopback only, one crude web page, and a CLI client. The laptop reaches them through an SSH port forward; the phone's route is not settled (see [Remote access](#remote-access)). No notifications. |
| Merging | Only Steve merges PRs in `atlargelabs/aipatty`. |
| Upgrade | Explicit operator `/upgrade` and a one-shot helper, never automatic. If rollback also fails, Steve uses SSH or remote desktop. |
| GitHub identity | The `pattycaik` account with write access, behind a ruleset on `main`. Other repos only when Steve directs it. |
| Coding | Aipatty has pi-durable's built-in tools for inspection, scratch work and `gh`. Work intended for a PR goes to its own pinned Pi CLI in a disposable workspace, with the `delegates` and `pi-review` extensions installed. Pi can write the change directly or through a delegate. Every PR is reviewed by a `crmanager` delegate, and Pi keeps fixing until no important finding remains. |
| Tree | Branches are independent workstreams. Steve and aipatty can both fork. All branches stay listed. No automatic report-back. |
| Models | Default `openai/gpt-6.2-sol`, on the `openai` provider with the OpenAI subscription, for aipatty's conversations and for Pi runs. Per-branch model, set by Steve or by aipatty. Spark later. Claude through the `pi` CLI only, for now. |
| Cost | Shown per branch and in total as `$<branch> / $<total>`. No spend limit. |
| macOS account | An existing standard service user `aipatty`; manual app installation needs no macOS administrator access. Steve retains administrator access for separate machine provisioning. |
| Guard rails | No approval prompts. The `protect-main` ruleset with required CI is the enforcement. No hooks for now. |
| MCP | Gmail first (`aipattychestnut@gmail.com`). OAuth by link. Gmail is off by default and off for every new branch; it is switched on per branch. |

## Shape

One Node process runs a pi-durable `Harness` over SQLite. An explicit upgrade starts a detached one-shot helper
from a pinned release. There is no installed supervisor, launchd job, or always-on polling process.

- **Stack:** TypeScript on Node 26. The Pi packages (`pi-durable`, `pi-ai`, `pi-codemode`, `chord`, `pi-schema`, and
  the `pi-coding-agent` CLI) are pinned at exactly 1.6.0 from npm, all at the same version so the host and the CLI share
  one `pi-ai`. Later bumps are normal reviewed PRs.
- **Service installation layout:** the recommended root is `~/aipatty` in the service account's own home
  (`ROOT="$HOME/aipatty"`). Another writable absolute path is fine. The first release step creates the root
  if needed without administrator access. Committed-main releases live at `$ROOT/deploy/<sha>`, with
  dependencies installed per release and `$ROOT/deploy/current` pointing at the active one. Keep the
  last-known-good release for rollback.
  - `$ROOT/work/`: working directory of aipatty's own tools, for inspection and scratch, not PR work.
  - `$ROOT/runs/`: disposable workspaces for [`pi` runs](#pi-runs).
  - `$ROOT/data/`: conversation SQLite, Pi run logs, and later MCP configuration and sign-ins.
  - `$ROOT/pi/`: shared Pi sign-in, model cache, delegates settings and jobs.
  - `$ROOT/upgrade/`: the upgrade owner lock, durable journal, backups, and per-request helper and app logs.

  The server-only `--install-dir` derives these four state paths (using `$ROOT/faux` instead of
  `$ROOT/data` in faux mode); each individual directory option takes precedence. Without it the legacy defaults
  remain unchanged. It adds no environment variable or API. Launch from any cwd with
  `node "$ROOT/deploy/current/src/main.ts" --install-dir "$ROOT"`. State stays outside releases on redeploy and
  rollback; see [INSTALL.md](INSTALL.md) for bootstrap, normal operation, and recovery.
- **Conversations:** one root plus forks. Each has a title and its own model.

### Pi installation

Aipatty installs its own copy of the upstream `@earendil-works/pi-coding-agent` 1.6.0 as an exact-version runtime
npm dependency. Commit the lockfile and install with `npm ci --ignore-scripts`. Launch the executable from the
running release by absolute path, never via `PATH` or `npx`. Do not fork Pi or update it in place with `pi update`;
bump the dependency through a reviewed PR so rolling back aipatty also rolls back its Pi CLI.

Use a dedicated Pi agent directory owned by the `aipatty` account, outside the release and run directories. The
legacy default is `~/.pi/agent`; the root install derives `$ROOT/pi`. Point the host and CLI at the same
path: for root installs explicitly set `PI_CODING_AGENT_DIR="$ROOT/pi"` for pinned CLI login/bootstrap and
model-cache commands (see [INSTALL.md](INSTALL.md)). The host and CLI share that account's OpenAI sign-in
(`auth.json`, with compatible refresh locking) and the Pi
model catalog cache (`models-store.json`, which supplies models newer than the bundled catalog). Steve bootstraps the service
login with the pinned CLI; neither process uses Steve's personal Pi install, settings, or credential files. When
bumping Pi, verify that the active and rollback releases can both use the shared sign-in and model cache.

### Pi extensions

Pi runs use two extensions, and only these two:

- **`delegates`** (`github.com/stephenchestnut/delegates`): the `delegate` and `delegate_parallel` tools, with the
  `thinker`, `thinktank`, `worker`, `prmanager` and `crmanager` profiles. The run loads it with `-e`.
- **`pi-review`** (`github.com/earendil-works/pi-review`): the `/review` command. The run does not load it.
  `delegates` loads it inside a `crmanager` job and runs `/review` there without its interactive UI.

Both are direct git dependencies pinned to full commit SHAs in `package.json` and the lockfile. Each release
installs its own copies with `npm ci --ignore-scripts`; rolling back aipatty rolls both extensions back too.
`pi-review` uses the known working upstream revision `f1de050504936046c0f85b21fec0e0a93ef394eb`. Its
peers reuse Pi 1.6.0, including `pi-tui`, which the CLI already requires at exactly 1.6.0.

`delegates` reads its settings from the service account's `settings.json` in the Pi agent directory, not from the
checkout:

- **Publication:** `atlargelabs/aipatty` as the one authorized repository, with base branch `main`.
- **Models:** none set. The extension's defaults are on the `openai` provider: `openai/gpt-6.2-sol` for every
  profile except `crmanager`, which reviews with `openai/gpt-6.2-astra`.
- **Review extension:** `delegates.reviewExtension` names the pinned `review.ts` by absolute path through
  `deploy/current` for service installs, or directly into the running checkout for development. Before cloning for
  a PR, the host checks that it resolves to the running release's pinned file. There is no shared reviewer
  fallback for PR runs in pinned releases, and the top-level run does not load pi-review.
- **Checks:** `npm ci --ignore-scripts` as setup, and `npm run check` and `npm test` as required checks. A
  `prmanager` refuses to submit with no checks configured, and the copy in the repo's `.pi/settings.json` is not
  read because checkout settings stay untrusted.

`delegates` keeps its jobs, logs, and `prmanager` and `crmanager` clones in `delegates/jobs/` under the agent
directory, outside `runs/`.

The settings file is shared and never rewritten by the host. The stable path follows `current` on deploy and
rollback between pinned releases; stop the server and wait for it to exit before repointing the symlink or
changing the setting. See [INSTALL.md](INSTALL.md) for the first pinned deploy and rollback to older releases.

## Tools the model gets

| Tool | What it does |
| --- | --- |
| `read`, `write`, `edit`, `bash`, `codemode`, `tool_search` | pi-durable built-ins, working in `work/`. |
| `pi` | Runs one Pi session on a bounded coding task in a fresh clone and returns the result to the calling branch. One run at a time across all branches. Inside the run Pi may delegate the work, and always delegates the review. |
| `fork_branch`, `list_branches`, `read_branch`, `set_model` | Tree management, plus paging and text search over any branch. |
| `mcp_status`, `mcp_reload`, `mcp_sign_in` | Later: server state, re-reading `mcp.json`, and OAuth by link. |

Pass relevant conversation context in the handoff. A branch-reading interface for Pi can come later if needed;
Pi does not receive aipatty's MCP tools.

## `pi` runs

Every `pi` call starts a fresh session. A later run does not inherit the session or checkout. Published issues and PRs,
the tool result, and operator logs remain available.

1. **Request and workspace:** refuse if another run is active. Record the run ID, calling branch, requested
   outcome, and base, then create `runs/<run-id>/`. For a PR run, check the configured reviewer matches the running
   release. `atlargelabs/aipatty` is the only allowed repo for now. Clone it with the service account's GitHub access
   and record the resolved base SHA.
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

1. Steve sends exactly `/upgrade` in the originating branch, using the browser composer or CLI. It's an
   operator command, not a tool a model can call or a phrase interpreted as consent. The host requires an idle
   harness and reserves the Pi slot across all branches. It journals the unique ID and branch and immediately
   commits the command with Durable before spawning the helper. No model turn runs for the command or the result.
2. The helper owns the operation and resolves the configured GitHub origin's `main` to one commit. It stages
   and checks a clean checkout while the old host serves reads. It will not deploy a Pi checkout or any PR head.
3. After graceful stop, process exit and exclusive data ownership, it makes a standalone SQLite backup that
   includes committed WAL frames. It atomically switches `current` and starts the candidate with its scheduler
   paused and only health exposed. SHA and readiness must match (including the requesting branch) before the
   commit opens admissions. A pre-commit failure restores the intact old release and database, without copying
   live files or replaying candidate WAL. Both success and verified rollback report to the original branch.
4. The journal persists outside SQLite. An ordinary failed check reopens old admission. An interrupted stage
   leaves the old selection and data untouched, but blocks new work until the operator verifies the stage
   processes are gone and acknowledges the recorded request. Only the coordinator can publish. An interrupted
   cutover instead uses `recover` to restore the recorded old release; it never fetches a new target. A failed
   rollback preserves evidence and stops. Legacy bootstrap uses the same helper and rollback code, with exclusive
   operator maintenance because the old release has no journal or admission gate.

This one-shot design supersedes the always-on launchd supervisor. No administrator, daemon, automatic upgrade,
startup retry, or service registration is required. A future service manager for the app is separate and must
not respawn the app during an upgrade. See [the runbook](INSTALL.md#upgrade-an-existing-installation).

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
   and pinned `delegates` and `pi-review` [extensions](#pi-extensions), pi-durable's coding tools, codemode and tool search in
   `work/`, and the [run contract](#pi-runs) with the git/issue workflow. Tested with a fake CLI: a second run
   refused, missing auth or model, malformed output, false success, abort, child cleanup, restart, the launch
   loading only the pinned extension, delegate usage charged once, delegate clones removed, and a result not
   reported as reviewed when its review is missing, has important findings, or covers a different SHA from the PR
   head. Step 3 is the live end-to-end proof of the review and deploy loop.
3. **Install on the mini and prove the loop by hand.** From the laptop over SSH, ask aipatty for a small change to
   itself. It opens an issue and a checked PR that a `crmanager` has reviewed. Steve merges and deploys it by
   hand; verify the new SHA and keep talking in the original conversation. At this point aipatty can help build the supervisor.
   The steps are in [INSTALL.md](INSTALL.md).
4. **Explicit upgrade and rollback.** Bootstrap from a merged release as in [INSTALL.md](INSTALL.md), then
   use `/upgrade` to verify the originating branch reports the active SHA. Isolated process tests cover both
   directions of cutover, failed readiness, and interrupted recovery. No persistent supervisor is installed.
5. **After self-upgrade:** phone access, MCP configuration and OAuth, the per-branch switch, and Gmail. Add research
   mode, concurrent runs, hooks, or more repos only when needed.

## Setup responsibilities

- **Manual app install, as the service account:** assume an existing standard `aipatty` account with a writable
  home and user-accessible Node 26 or newer, Git, and `gh`. Follow [INSTALL.md](INSTALL.md) to set up its
  `~/aipatty` root, install releases, set up the model sign-in with the release's Pi CLI, configure `pattycaik`'s
  SSH key and `gh` login, and write the [`delegates` settings](#pi-extensions) into its Pi agent directory. None
  of this needs `sudo` or a macOS administrator account. No global Pi install or copy of Steve's dotfiles is needed.
- **GitHub maintainer work:** confirm `pattycaik` has write, not admin, access and `main` has the `protect-main`
  ruleset with the CI check required before enabling PR publication. These are repository permissions, separate
  from macOS administrator access. Only Steve merges PRs.
- **Optional machine provisioning, separately:** if the service account or system tools do not exist, arrange
  their creation or installation with the machine owner; this may need a macOS administrator. The service account
  still creates its own install root. Fix SSH from the laptop to `macmini` (host key verification fails).
- **Future work for Steve:** for Gmail later, create the Google Cloud project and OAuth client.

## Left for aipatty to build

Claude for its own conversations, the Spark models, notifications, a chat bot, report-back from branches, approval
prompts, archiving, better search, and `pi` runs that survive a restart.

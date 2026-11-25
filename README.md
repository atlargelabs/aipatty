# aipatty

aipatty is a personal assistant agent built on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable).
It runs as one long-lived process, keeps its conversations in SQLite, and continues interrupted work after a restart.
The design and build order are in [docs/PLAN.md](docs/PLAN.md). This checkout implements build steps 1 and 2: a tree
of conversation branches, each with its own model, over an HTTP and WebSocket API, a web page, and a CLI client; and
the `pi` tool, which hands coding work to a pinned Pi CLI. Installing it on the Mac mini is in
[docs/INSTALL.md](docs/INSTALL.md).

## Branches

The root conversation ("Main") and every branch forked from it are independent workstreams. A fork shares its
parent's history up to the fork point, starts with the parent's model and thinking level, and then continues on its
own. Nothing reports back between branches, and every branch stays listed. Each branch has a title, its own model and
thinking level, and its own cost; the page and the CLI show it as `$<branch> / $<total>`.

The model gets four tools for the tree: `list_branches`, `read_branch` (paging and case-insensitive text search over
any branch), `fork_branch` (optionally with a first message the new branch starts on), and `set_model`. A branch it
forks gets the model it has; its `set_model` on another branch is refused while that branch is busy. Forks at an
incomplete tool exchange are rejected: fork before the call or after its last result. A tool's default self-fork
ends before its own call. If the optional first message cannot be admitted, the tool reports the created branch ID and
the admission error; the branch remains available.

## Tools

Besides the tree tools, the model has pi-durable's `read`, `write`, `edit`, `bash`, `codemode` and `tool_search`.
They start in the work directory (`--work-dir`), for inspection and scratch files. They are not confined to it: they
have the permissions of the user the server runs as.

## `pi` runs

Work meant for a PR goes through the `pi` tool. Each call runs one session of the Pi CLI pinned in `package.json`,
in a fresh clone of `atlargelabs/aipatty` under the runs directory, and waits for it.

- **One per conversation branch.** A second call in the same branch is refused during startup, execution and
  cleanup. Different branches start and finish independently in separate clones; there is no global run cap
  or coordination of work in GitHub.
- **Launch.** The CLI runs in one-shot JSON mode with no session. It explicitly loads the release's pinned
  `delegates`, `just-web-fetch` (managed `web_fetch`) and `pi-web-search` (`web_search`, plus `url_context` on
  supported models). The default stays `openai/gpt-6.2-sol`. An explicit `model: "claude-code/<model-id>"`
  opts that run into the experimental Claude Code provider; there is no automatic Claude discovery or fallback
  on OpenAI runs. Nothing loads by discovery: no checkout settings, extensions, skills, context files or MCP
  servers. Pi shares the server's Pi directory, sign-in and `delegates` settings. Set `delegates.maxParallel`
  to `10` in that directory's `settings.json` for ten concurrent top-level delegates **per Pi** (not a shared
  pool or a cap on all nested jobs). See [the operator setup](docs/INSTALL.md#enable-ten-delegates-per-pi).
- **Rules.** Pi is told the git and issue workflow: an issue, a task branch and a PR that links the issue;
  `npm run check` and `npm test` before every push; a `crmanager` review of the final commit, repeated until it
  has no P0 or P1 finding; and that only Steve merges.
- **Result.** The tool returns a status, Pi's summary, the PR and issue, the last review, the cost, and anything
  the host found wrong. The host does not take Pi's word for it. A run that was asked for a PR is `completed`
  only when all of this holds, and `failed` otherwise:
  - Pi exited cleanly: the event stream is well-formed and ends settled, with a last message that stopped normally.
  - `gh` confirms the PR: open, against `main`, and listed by GitHub as closing a confirmed issue of this
    repository.
  - The last finished `crmanager` review was a `/review pr` of that PR, in a clone of this repository, at its
    head commit and after any change of its base branch; it declared the verdict "correct" and no other; and it
    had no P0 or P1 finding. Otherwise the
    result says `NOT REVIEWED` and why. The verdict is read from the reviewer's text, which is a model's: it is
    a check on the workflow, and Steve's review before merging is the gate.

  CI on the PR's head commit is the authoritative check. The tool does not wait for it.
- **Cost.** Pi's spend and its delegates' is charged to the calling branch, once. When a run is cut off, the
  cost includes what its unfinished delegate jobs had recorded, and is marked incomplete.
- **Abort and timeout.** Aborting the branch, or the run's time limit (60 minutes unless the call says otherwise,
  counted from the start of the clone), stops Pi and the processes it started, its delegates included. The result
  reports what the run had done. Once Pi has finished and the host is checking the result, the run ends as it
  ended. Stopping one branch does not stop another's run.
- **Cleanup.** New runs write events, error output and prompts to `logs/runs/<run-id>/` in the data directory.
  Delegates write their logs there too, directly under `delegates/<job-id>/` while they run. Cleanup keeps the
  final job manifests there and deletes the run workspace and delegate clones. Logs can hold private data.
  The host archives the result and indexes it by task under `pi-outcomes/` before clearing the run's
  checkpoint in `pi-runs/<run-id>.json`.
- **Restart.** Runs do not survive the server. On the next start, before conversations resume, the server
  independently stops and cleans up interrupted runs and reports each call as `interrupted` in its own branch,
  with any known PR link. It never runs the calls again; an already settled run keeps its result.
- **When cleanup fails.** If a known run's processes cannot be proved stopped or its files cannot be removed,
  that branch is held until the problem is resolved and the server restarted. Unreadable or conflicting run
  records can make ownership unknown, in which case no new Pi run starts. The refusal says what to inspect.
  Preserve the records and workspaces as evidence. A later cleanup may add spend to `result.json`; if the
  call's result was already committed in its branch, that spend is not charged there again.

A run needs `git`, `gh`, a GitHub login for the account running the server, and the Pi sign-in. For a PR run,
`delegates.reviewExtension` in the selected Pi directory's `settings.json` must be an absolute path to the
running release's `node_modules/@earendil-works/pi-review/review.ts`. The host checks it before cloning; a
missing path or an older or shared copy is refused. Only the `crmanager` job loads pi-review. Non-PR runs do
not require this setting. See [the runbook](docs/INSTALL.md) for the exact path and rollout steps.

Web and Claude Code extensions are for the top-level coding run only, not conversations, delegates, or the
reviewer. Fetch needs operator-installed Chrome/Chromium, trafilatura, and a filtering egress proxy; managed
runs do not load fetch hooks.
Search needs a provider/account with native search and can incur separate usage. Claude Code needs its own CLI
and service-account subscription login. See [optional coding extensions](docs/INSTALL.md#optional-coding-extensions)
for prerequisites, configuration, and data/usage boundaries.

A run's processes are identified by a remembered PID and start time or by a marker in their environment.
Discovery also follows their children and other members of their live process groups. A remembered group ID
alone can be reused: if the leader is gone and no member can be independently identified, the remaining
members are not signalled and cleanup stays pending. Inspect the reported PIDs and restart once the ambiguity
is resolved. Existing `pi-run.json` records are recovered in place; the legacy `asOf` timestamp is ignored for
ownership. See the [cutover and rollback procedure](docs/INSTALL.md#pi-run-state-cutover-and-rollback). A process that leaves both its parent and its group and hides its environment is not found unless
its identity was remembered.

## Page

Open `http://127.0.0.1:8790/` (or the port given with `--port`) for the branch list, transcript, input box, fork (of the whole branch, or
at a completed exchange with "Fork here"), rename, search, model and thinking pickers, and cost. In the message box,
Enter sends on desktop and inserts a newline when the primary pointer is coarse and cannot hover (touch-first).
Shift+Enter inserts a newline in either case. Use the Send button or ⌘/Ctrl+Enter (without Shift or Alt) to send.

The transcript shows a card for each message, and for an assistant message one for each run of text and each
tool call, in the order they were written. Below the saved transcript, dashed cards show what is in progress: the
answer being written and each tool call that has not finished. How the cards are made, and how to add to them, is
in [the card pipeline](docs/WEB-CARDS.md).

Saved user and assistant prose renders as Markdown. Single newlines are preserved, and wide tables and code
blocks scroll horizontally. Links must be absolute HTTP(S) URLs outside aipatty's hosts and open in a new tab.
Raw HTML is shown as text, and images are not loaded. Live previews (including partial tool arguments), tool
cards, system messages, notices, and the Pi run pane stay plain text.

Use **Open Pi run** on a `pi` call's result, or on its dashed card while it runs, to inspect that run beside the
conversation. On a narrow screen it uses the full screen; Close or Esc goes back to the same place in chat. Inherited calls open the original run.
The pane shows its status and elapsed time when known, recent tool starts and finishes, assistant text, bash output,
Pi stderr, and the final result. It links only to PRs and issues the host confirmed, and shows the confirmed PR head
and reviewed SHA **at the time of the run**, not current GitHub state.

The pane opens at the bottom and checks for new output about every 1.5 seconds while the run is active. Scroll
up to freeze the excerpt you're reading, even as newer output replaces older lines on the server. The status can
still change while the excerpt is frozen. Scroll back to the bottom or use **Jump to latest** to show the newest
snapshot and resume following. The pane stops checking when it receives a final snapshot or you close it or
switch branches. This is a read-only viewer, not a terminal: you can't send input to Pi from it.

Refused requests have no run. A finished run opens at the bottom too and remains readable after its clone is
deleted if its archive is retained. Output depends on the available logs and is a bounded excerpt, not a complete
transcript. It can contain sensitive information printed by the run. Anyone allowed to reach aipatty, including
through Tailscale Serve if enabled, can read these archives.

## Install

Requires Node 26 or newer.

```sh
npm ci --ignore-scripts
```

The CLI and extensions are pinned in the release's dependencies and lockfile. This checkout's `.npmrc` allows
only direct git dependencies. Do not use a global Pi install or register these extensions with `pi install` or
Pi's `packages` settings.

## Run

```sh
npm start                  # uses the pi CLI's ChatGPT subscription login
AIPATTY_FAUX=1 npm start   # a fake model that echoes, for demos; needs no login
npm start -- --port 9000   # server options go after the --
```

The server uses only the pi CLI’s ChatGPT subscription login and takes the same lock when refreshing it.
If a send reports that OpenAI is not configured, sign in with the pi CLI. Stored API keys and
`OPENAI_API_KEY` are not used.

## Configure

The server takes six command-line options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--port <n>` | `8790` | Listen port. `0` asks the operating system for a free one, which the server prints |
| `--install-dir <path>` | Unset | Derive the state directories below from one installation root |
| `--data-dir <path>` | `~/.aipatty/data` (`~/.aipatty/faux` in faux mode) | Where the conversation database, the ownership lock and the run logs live |
| `--pi-dir <path>` | `~/.pi/agent` | The Pi directory, shared with the pinned CLI: its login file `auth.json`, its cached model catalog `models-store.json`, which the server only reads, and the `delegates` settings and jobs |
| `--work-dir <path>` | `~/.aipatty/work` | Where the model's own file and shell tools start |
| `--runs-dir <path>` | `~/.aipatty/runs` | Where each `pi` run gets its disposable workspace |

The defaults in the table apply when `--install-dir` is omitted. With it, the server derives `data/` (or `faux/`
in faux mode), `pi/`, `work/`, and `runs/` under that root. Each individual directory option overrides only its
corresponding derived path. Paths may be absolute, relative to the starting directory, or start with `~`; quote
paths containing spaces. Blank paths are rejected. The root option is server-only: there is no new environment
variable, CLI client option, or API setting. The Pi CLI and its pinned extensions come from the running release,
not the state root.

For a service install, the recommended root is `~/aipatty` in the service account's own home, not a new
runtime default. Set `ROOT="$HOME/aipatty"` or choose another writable absolute path. The first release step
creates the root if needed. The manual app install needs no `sudo` or macOS administrator account: an existing
standard service account and user-accessible Node 26 or newer, Git, and `gh` are prerequisites. Optional machine
provisioning and GitHub maintainer setup are separate; retain the `pattycaik` service identity and `protect-main`
branch protection described in the runbook.

Keep committed-main releases in `$ROOT/deploy/<sha>` with a `deploy/current` symlink and launch
`node "$ROOT/deploy/current/src/main.ts" --install-dir "$ROOT"`. Explicitly set `PI_CODING_AGENT_DIR="$ROOT/pi"`
when using the pinned Pi CLI for login or model-cache updates. Set `delegates.reviewExtension` to the absolute
path through `deploy/current` so it follows deployment and rollback between pinned releases. Deploy later
releases with [`/upgrade`](#upgrade); by hand, stop and wait before repointing `current`. Follow
[the runbook](docs/INSTALL.md) for first installs, migrating existing settings,
rollback to releases with an unpinned reviewer, and development without `deploy/current`.

The server also takes one environment variable, `AIPATTY_FAUX`: `1` uses the fake model. An empty value counts as unset.

An unknown option stops the server. Any other `AIPATTY_` variable stops the server and the CLI with an error that
names it, so a setting left over from an earlier version is not silently ignored.

The server listens on `127.0.0.1` only; there is no listen address to configure. See [From another machine](#from-another-machine).

A new root conversation starts with the model `gpt-6.2-sol` and the thinking level `high`. Both are saved with the
conversation; change them with `model set` and `thinking set` (add `--branch <id>` for a branch).

`gpt-6.2-sol` is in the catalog bundled with pi-ai 1.6.0. A model newer than that catalog resolves only if the pi
CLI has cached a newer catalog in the pi directory. If a branch's saved model is missing from both, the server
still serves transcripts, branches and model commands. `/health` returns HTTP 200, `modelStatus: "unavailable"`, and the
model reference; sends return 409. Availability means present in the local catalog, not that a login or network call succeeded.
A branch whose model is missing refuses sends; the others keep working. If a branch has *interrupted work* waiting
for a missing model, nothing runs anywhere until that branch's model is switched (the error names the branch), so
that work is neither run on the wrong model nor silently failed.

To keep interrupted work pending, restore the original model (e.g. `pi update --models`) and restart.
Alternatively, select an available model. Switching withdraws outstanding work from the blocked turn, including
queued messages; it does **not** rerun them. Send any message you want to retry explicitly. A switch during an
actively running turn returns 409: wait for the turn to finish, or run `abort` first.

Only one process can open a data directory, regardless of listen port. The server holds an OS-backed lock in
a separate `owner.sqlite` file before opening the conversation database. A crash releases the lock; do not delete the file.

## CLI

```sh
node src/cli.ts health                # the running commit, version, start time, root model and thinking level
node src/cli.ts models                # list available model IDs and providers
node src/cli.ts model set <id>        # select a model from that list (optional provider before ID)
node src/cli.ts thinking set <level>  # off, minimal, low, medium, high, xhigh or max
node src/cli.ts send "hello"          # send a message and stream the answer
node src/cli.ts upgrade               # deploy the latest main in a managed install; the result appears in the log
node src/cli.ts abort                 # withdraw queued messages and stop the running turn
node src/cli.ts shutdown              # request a graceful stop of the whole server
node src/cli.ts log                   # print the transcript
node src/cli.ts branches              # list branches: ID, title, model, own cost, fork point; and the total
node src/cli.ts branches read <id> [--limit n]     # the newest n messages of a branch (default 50), with entry IDs
node src/cli.ts branches search <id> "<text>"      # case-insensitive matches, newest first
node src/cli.ts fork "<title>" [--at <entryId>]    # fork the root (or --branch <id>) at its newest or a given entry
node src/cli.ts rename "<title>"                   # retitle the root (or --branch <id>)
```

`--branch <id>` before or after the command points `model set`, `thinking set`, `send`, `abort`, `log`, `fork`,
`rename` and `upgrade` at a branch instead of the root.

The CLI connects to `127.0.0.1:8790`. `--port <n>` names another port, for a server started with `--port`
(or a matching SSH forward). For example: `aipatty --port 9000 shutdown` (or `node src/cli.ts --port 9000 shutdown`).

`shutdown` is server-wide, takes no branch, and works even when no saved model is available. `Shutdown requested.`
acknowledges the request, not that cleanup has finished. The server closes its HTTP and WebSocket connections and
cleans up as for Ctrl-C or `SIGTERM`, without waiting for a conversation to go idle. Unlike `abort`, it doesn't
withdraw queued messages. Conversations persist, and interrupted conversation work continues on restart unless
scheduling is [blocked by an unavailable model](#configure). Partial answers may remain in the transcript.
Active [`pi` runs](#pi-runs) are stopped and reported as interrupted on restart, not replayed. Wait for the server
process to exit before starting another one on the same data directory.

## Upgrade

In a [service install](#configure), typing `/upgrade` in a branch on the page, or running the CLI's `upgrade`,
deploys the latest committed `main`. It goes to the server, not the model, and is refused while any branch is busy. A one-shot
supervisor script stages the release beside the running one, then stops the server, backs up the database and
starts the new release. Every release checks its own health as it starts; `health` lists any `problems`. A new
release that exits or reports a problem is replaced by the old one with the database restored. The outcome, with
the reason for a failure, is posted in the branch that asked. Nothing is installed and nothing runs between
upgrades. See [the runbook](docs/INSTALL.md#upgrade) for the files it keeps and what to do after an interruption.

## From another machine

The server has no login and listens on loopback only. To use the page or the CLI from a laptop,
forward the port over SSH and open `http://127.0.0.1:8790/` there. The SSH host can be the mini's Tailscale name:

```sh
ssh -N -L 8790:127.0.0.1:8790 <the machine aipatty runs on>
```

Use the same port number at both ends. SSH authenticates this connection.

For a normal HTTPS bookmark on your phone or laptop, use [Tailscale Serve](docs/INSTALL.md#optional-tailnet-browser-access).
Start aipatty with `--tailscale-origin <https-url>` set to the exact URL Serve prints. The listener stays on
loopback; access to the HTTPS URL is controlled by your tailnet policy. Do not use Tailscale Funnel.

## API

- `GET /` the page (and `/app.js`, `/app.css`, `/markdown-it.js`, and the modules of `src/web/` as `/web/<name>.ts`)
- `GET /health` (includes the process ID, the root's saved model, its catalog availability, the thinking level,
  and `problems`: what the startup health check found, empty when healthy)
- `GET /api/models`
- `GET /api/pi-runs/:runId`: a no-store, read-only snapshot of one active or archived Pi run. Uses the ID from
  the `pi` tool's structured progress/result. Returns `runId`, `status`, `durationMs` when known, bounded `activity`
  and `stderr` when available, and a terminal `result` with confirmed links and review status. No file or path
  parameter is accepted. A bad ID is `400`; an unknown run or missing/unusable result record is `404`. An archive
  with intact result metadata but missing event logs still shows its result.
- `POST /api/shutdown` (no body needed): requires the `X-Aipatty-Shutdown: 1` header so ordinary browser forms
  cannot trigger it. No CORS is enabled. Returns `202 { "status": "shutdown-requested" }` before stopping the
  server; it does not wait for cleanup. The same Host and Origin rules below apply.
- `GET /api/branches`: `{ branches: [{ id, title, parent, model, modelStatus, thinking, busy, cost }], totalCost }`
- `PUT /api/model` and `PUT /api/thinking`: the root's, as below
- `GET /api/conversations/:id` (`root` is the root conversation; `?limit=` and `?before=` page backwards); also
  carries `branch` and `totalCost`
- `POST /api/conversations/:id/fork` with `{ title, at? }`: a new branch from `:id`'s history through entry `at`
  (default its newest); returns the branch
- `PUT /api/conversations/:id/title` with `{ title }` (1 to 100 characters)
- `PUT /api/conversations/:id/model` with `{ modelId, provider? }`; 409 while the branch has active work
- `PUT /api/conversations/:id/thinking` with `{ level }`
- `GET /api/conversations/:id/search?q=&limit=&before=`: `{ matches: [{ entryId, role, excerpt }], before }`,
  newest first; pass `before` back for the next page
- `POST /api/conversations/:id/messages` with `{ content, requestId?, whenBusy?: "followUp" | "steer" }`. The
  content `/upgrade` starts an [upgrade](#upgrade) instead: `202 { "upgrade": "started" }`, or 409 when the server
  is busy or not a managed install
- `POST /api/conversations/:id/abort` (returns once the conversation is idle)
- `WS /api/conversations/:id/stream` sends one `state` frame (the newest 50 entries and the live state), then an
  `update` frame per change: the live state plus any `appended` entries, without the window. It falls back to a full
  `state` frame if an entry it already sent changes or a slow client misses part of the window. With `?submissionId=`, it also sends one `settled` frame: the
  answer, or the `reason` and `detail` of a failed run. The server pings every 30 s and drops a stream that does
  not answer.

For HTTP and WebSocket requests, `Host` must name `127.0.0.1` or `localhost` at the actual listener port, or the
exact configured Tailscale Serve hostname and port. If present, `Origin` must match the origin for that `Host`
(HTTP on loopback, HTTPS for Serve). This stops another site from driving the server through the browser. It is
not authentication: any process on the machine can connect, and any tailnet client allowed to reach Serve gets
full access.

## Test

```sh
npm run check
npm test
```

Tests use temporary files, fake credentials and the fake model. The page test drives headless Chrome over the
DevTools protocol; it finds Chrome in the usual places or at `CHROME_PATH`, and is skipped when there is none. In faux mode, a message of the form
`call <tool> <json arguments>` makes the fake model call that tool once, to try the tools by hand.

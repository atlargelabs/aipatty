# aipatty

aipatty is a personal assistant agent built on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable).
It runs as one long-lived process, keeps its conversations in SQLite, and continues interrupted work after a restart.
The design and build order are in [docs/PLAN.md](docs/PLAN.md). This checkout implements steps 1 and 2: a tree of
conversation branches, each with its own model, over an HTTP and WebSocket API, a web page, and a CLI client.

## Branches

The root conversation ("Main") and every branch forked from it are independent workstreams. A fork shares its
parent's history up to the fork point, starts with the parent's model and thinking level, and then continues on its
own. Nothing reports back between branches, and every branch stays listed. Each branch has a title, its own model and
thinking level, and its own cost; the page and the CLI show it as `$<branch> / $<total>`.

The model gets four tools for the tree: `list_branches`, `read_branch` (paging and case-insensitive text search over
any branch), `fork_branch` (optionally with a first message the new branch starts on), and `set_model`. A branch it
forks gets the model it has; its `set_model` on another branch is refused while that branch is busy.

## Page

Open `http://<AIPATTY_HOST>:<AIPATTY_PORT>/` for the branch list, transcript, input box, fork (of the whole branch, or
at any message with "Fork here"), rename, search, model and thinking pickers, and cost. ⌘/Ctrl+Enter sends.

## Install

Requires Node 26 or newer.

```sh
npm install --ignore-scripts
```

## Run

```sh
npm start                  # uses the pi CLI's ChatGPT subscription login
AIPATTY_FAUX=1 npm start   # a fake model that echoes, for demos; needs no login
```

The server uses only the pi CLI’s ChatGPT subscription login and takes the same lock when refreshing it.
If a send reports that OpenAI is not configured, sign in with the pi CLI. Stored API keys and
`OPENAI_API_KEY` are not used.

## Configure

| Variable | Default | Meaning |
| --- | --- | --- |
| `AIPATTY_DATA_DIR` | `~/.aipatty/data` (`~/.aipatty/faux` in faux mode) | Where the conversation database and ownership lock live |
| `AIPATTY_HOST` | `127.0.0.1` | Listen address; the tailnet address on the Mac mini. A wildcard (`0.0.0.0`, `::`) needs `AIPATTY_TRUSTED_HOSTS` |
| `AIPATTY_TRUSTED_HOSTS` | unset | Additional trusted hostnames, comma-separated, without scheme or port (e.g. the mini’s Tailscale DNS name) |
| `AIPATTY_PORT` | `8790` | Listen port |
| `AIPATTY_PI_DIR` | `~/.pi/agent` | The pi CLI's directory: its login file `auth.json` and its cached model catalog `models-store.json`, which is only read |
| `AIPATTY_FAUX` | unset | `1` uses the fake model |
| `AIPATTY_URL` | `http://127.0.0.1:8790` | Server address for the CLI client |

An empty value counts as unset. Any other `AIPATTY_` variable stops the server and the CLI with an error that names it.

A new root conversation starts with the model `gpt-6.2-sol` and the thinking level `high`. Both are saved with the
conversation; change them with `model set` and `thinking set` (add `--branch <id>` for a branch).

`gpt-6.2-sol` is newer than the catalog bundled with pi-ai 1.5.2. It resolves only if the pi CLI has cached a newer
catalog in `AIPATTY_PI_DIR`. If the saved model (or the default on first launch) is missing, the server
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
node src/cli.ts abort                 # withdraw queued messages and stop the running turn
node src/cli.ts log                   # print the transcript
node src/cli.ts branches              # list branches: ID, title, model, own cost, fork point; and the total
node src/cli.ts branches read <id> [--limit n]     # the newest n messages of a branch (default 50), with entry IDs
node src/cli.ts branches search <id> "<text>"      # case-insensitive matches, newest first
node src/cli.ts fork "<title>" [--at <entryId>]    # fork the root (or --branch <id>) at its newest or a given entry
node src/cli.ts rename "<title>"                   # retitle the root (or --branch <id>)
```

`--branch <id>` before or after the command points `model set`, `thinking set`, `send`, `abort`, `log`, `fork` and
`rename` at a branch instead of the root.

## API

- `GET /` the page (and `/app.js`, `/app.css`)
- `GET /health` (includes the root's saved model, its catalog availability, and the thinking level)
- `GET /api/models`
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
- `POST /api/conversations/:id/messages` with `{ content, requestId?, whenBusy?: "followUp" | "steer" }`
- `POST /api/conversations/:id/abort` (returns once the conversation is idle)
- `WS /api/conversations/:id/stream` sends one `state` frame (the newest 50 entries and the live state), then an
  `update` frame per change: the live state plus any `appended` entries, without the window. It falls back to a full
  `state` frame if an entry it already sent changes or a slow client misses part of the window. With `?submissionId=`, it also sends one `settled` frame: the
  answer, or the `reason` and `detail` of a failed run. The server pings every 30 s and drops a stream that does
  not answer.

Both HTTP and WebSocket requests must use the configured listen name/address or an explicitly trusted hostname,
at the actual listener port. If present, `Origin` must also match that same HTTP origin. Host validation is not
authentication: bind only to loopback or the private tailnet address.

## Test

```sh
npm run check
npm test
```

Tests use temporary files, fake credentials and the fake model. In faux mode, a message of the form
`call <tool> <json arguments>` makes the fake model call that tool once, to try the tools by hand.

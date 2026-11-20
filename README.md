# aipatty

aipatty is a personal assistant agent built on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable).
It runs as one long-lived process, keeps its conversations in SQLite, and continues interrupted work after a restart.
The design and build order are in [docs/PLAN.md](docs/PLAN.md). This checkout implements step 1, the skeleton: one
conversation, an HTTP and WebSocket API, and a CLI client.

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

The server shares the pi CLI's login file and takes the same lock on it, so both can run at once. A stored API key
may be a literal, an environment template (`$VAR`, `${VAR}`) or a `!command`, as in the pi CLI. The server runs a
command key in its own shell and keeps the result until it exits, so restart it after rotating such a key.

## Configure

| Variable | Default | Meaning |
| --- | --- | --- |
| `AIPATTY_DATA_DIR` | `~/.aipatty/data` (`~/.aipatty/faux` in faux mode) | Where the conversation database and ownership lock live |
| `AIPATTY_HOST` | `127.0.0.1` | Listen address; the tailnet address on the Mac mini |
| `AIPATTY_TRUSTED_HOSTS` | unset | Additional trusted hostnames, comma-separated, without scheme or port (e.g. the mini’s Tailscale DNS name) |
| `AIPATTY_PORT` | `8790` | Listen port |
| `AIPATTY_PROVIDER` | `openai` | Provider for a new root conversation |
| `AIPATTY_MODEL` | `gpt-6.2-sol` | Model for a new root conversation |
| `AIPATTY_THINKING` | unset | Thinking level, applied at every start when set. Unset keeps the saved level; a new root conversation gets `high` |
| `AIPATTY_AUTH_FILE` | `~/.pi/agent/auth.json` | The pi CLI's login file |
| `AIPATTY_MODELS_STORE` | `~/.pi/agent/models-store.json` | The pi CLI's cached model catalog, read-only |
| `AIPATTY_FAUX` | unset | `1` uses the fake model |
| `AIPATTY_URL` | `http://127.0.0.1:8790` | Server address for the CLI client |

`gpt-6.2-sol` is newer than the catalog bundled with pi-ai 1.5.2. It resolves only if the pi CLI has cached a newer
catalog in `AIPATTY_MODELS_STORE`. If the saved model (or the default on first launch) is missing, the server
still serves the transcript and model commands. `/health` returns HTTP 200, `modelStatus: "unavailable"`, and the
model reference; sends return 409. Availability means present in the local catalog, not that a login or network call succeeded.

To keep interrupted work pending, restore the original model (e.g. `pi update --models`) and restart.
Alternatively, select an available model. Switching withdraws outstanding work from the blocked turn, including
queued messages; it does **not** rerun them. Send any message you want to retry explicitly. A switch during an
actively running turn returns 409: wait for the turn to finish or abort it first.

Only one process can open a data directory, regardless of listen port. The server holds an OS-backed lock in
a separate `owner.sqlite` file before opening the conversation database. A crash releases the lock; do not delete the file.

## CLI

```sh
node src/cli.ts health          # the running commit, version and start time
node src/cli.ts models          # list available model IDs and providers
node src/cli.ts model set <id>  # select a model from that list (optional provider before ID)
node src/cli.ts send "hello"    # send a message and stream the answer
node src/cli.ts log             # print the transcript
```

## API

- `GET /health` (includes the saved model and its catalog availability)
- `GET /api/models`
- `PUT /api/model` with `{ modelId, provider? }` to switch the root conversation
- `GET /api/conversations/:id` (`root` is the root conversation; `?limit=` and `?before=` page backwards)
- `POST /api/conversations/:id/messages` with `{ content, requestId?, whenBusy?: "followUp" | "steer" }`
- `POST /api/conversations/:id/abort`
- `WS /api/conversations/:id/stream` sends one `state` frame (the newest 50 entries and the live state), then an
  `update` frame per change: the live state plus any `appended` entries, without the window. It falls back to a full
  `state` frame if an entry it already sent changes. With `?submissionId=`, it also sends one `settled` frame: the
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

Tests use temporary files, fake credentials and the fake model.

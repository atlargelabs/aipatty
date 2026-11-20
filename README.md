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

The server shares the pi CLI's login file and takes the same lock on it, so both can run at once.

## Configure

| Variable | Default | Meaning |
| --- | --- | --- |
| `AIPATTY_DATA_DIR` | `~/.aipatty/data` | Where `aipatty.sqlite` lives |
| `AIPATTY_HOST` | `127.0.0.1` | Listen address; the tailnet address on the Mac mini |
| `AIPATTY_PORT` | `8790` | Listen port |
| `AIPATTY_PROVIDER` | `openai` | Provider for a new root conversation |
| `AIPATTY_MODEL` | `gpt-6.2-sol` | Model for a new root conversation |
| `AIPATTY_THINKING` | `high` | Thinking level |
| `AIPATTY_AUTH_FILE` | `~/.pi/agent/auth.json` | The pi CLI's login file |
| `AIPATTY_MODELS_STORE` | `~/.pi/agent/models-store.json` | The pi CLI's cached model catalog, read-only |
| `AIPATTY_FAUX` | unset | `1` uses the fake model |
| `AIPATTY_URL` | `http://127.0.0.1:8790` | Server address for the CLI client |

`gpt-6.2-sol` is newer than the catalog bundled with pi-ai 1.5.2. It resolves only if the pi CLI has cached a newer
catalog in `AIPATTY_MODELS_STORE`; run `pi update --models` if startup reports the model as not found.

## CLI

```sh
node src/cli.ts health          # the running commit, version and start time
node src/cli.ts send "hello"    # send a message and stream the answer
node src/cli.ts log             # print the transcript
```

## API

- `GET /health`
- `GET /api/conversations/:id` (`root` is the root conversation; `?limit=` and `?before=` page backwards)
- `POST /api/conversations/:id/messages` with `{ content, requestId?, whenBusy?: "followUp" | "steer" }`
- `POST /api/conversations/:id/abort`
- `WS /api/conversations/:id/stream` sends the current state, then every change

Requests with an `Origin` header from another origin are rejected.

## Test

```sh
npm run check
npm test
```

Tests use temporary files, fake credentials and the fake model.

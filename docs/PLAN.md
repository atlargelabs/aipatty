# aipatty: plan for the minimal agent

aipatty is a personal assistant agent that runs on Steve's Mac mini. This plan covers the smallest version that can be
installed and then asked to keep building itself. It is not the finished product.

## Decisions

| Area | Decision |
| --- | --- |
| Base | A small host of our own on the `@earendil-works/pi-durable` library. Not p2 or p3; p2's plugins are reference code only. |
| Remote access | HTTP and WebSocket on the tailnet only, one crude web page, and a CLI client. Used from phone and laptop. No notifications. |
| Merging | Only Steve merges PRs in `atlargelabs/aipatty`. |
| Upgrade | Explicit, never automatic. If rollback also fails, Steve uses SSH or remote desktop. |
| GitHub identity | The `pattycaik` account with write access, behind a ruleset on `main`. Other repos only when Steve directs it. |
| Coding | Direct tools for inspection and `gh`; anything that ends in a PR goes through the `pi` CLI and a `prmanager` delegate. |
| Tree | Branches are independent workstreams. Steve and aipatty can both fork. All branches stay listed. No automatic report-back. |
| Models | Default `gpt-6.2-sol` on the OpenAI subscription. Per-branch model, set by Steve or by aipatty. Spark later. Claude through the `pi` CLI only, for now. |
| Cost | Shown per branch and in total as `$<branch> / $<total>`. No spend limit. |
| macOS account | A standard user `aipatty`; Steve keeps administrator access. |
| Guard rails | No approval prompts. Hooks block pushing to `main`, `gh pr merge`, and writes inside the deploy checkout. |
| MCP | Gmail first (`aipattychestnut@gmail.com`). OAuth by link. Gmail is off by default and off for every new branch; it is switched on per branch. |

## Shape

One Node process runs a pi-durable `Harness` over SQLite, with a small supervisor beside it.

- **Stack:** TypeScript on Node 26. `pi-durable`, `pi-ai`, `pi-mcp`, `pi-codemode` and `pi-schema` are pinned at exactly
  1.5.2 from npm. Bumping them is a normal reviewed PR.
- **Layout in the `aipatty` user's home:**
  - `deploy/`: the checkout the process runs from, always a commit of `main`.
  - `work/`: clones where coding happens.
  - `data/`: the SQLite database, `mcp.json`, MCP sign-ins, logs and the last-known-good commit.
- **Conversations:** one root plus forks. Each has a title and its own model.
- **Model catalog:** `gpt-6.2-sol` is not in pi-ai 1.5.2's bundled catalog. The pi CLI gets it from the pi.dev
  catalog overlay it caches in `~/.pi/agent/models-store.json`. aipatty must load that overlay (or fetch the catalog
  itself) before the default model resolves.
- **Model login:** aipatty shares the pi CLI's stored sign-in (`~/.pi/agent/auth.json`) through its own file-backed
  pi-ai `CredentialStore`, which takes the same lock as the CLI. The default provider is `openai`, the one the CLI
  uses; `openai-codex` is also registered.

## Tools the model gets

| Tool | What it does |
| --- | --- |
| `read`, `write`, `edit`, `bash`, `codemode`, `tool_search` | pi-durable built-ins. |
| `pi` | Runs the `pi` CLI as a subagent. Research mode is read-only (`thinker`, `thinktank`) and returns a report. Code mode uses `prmanager` in a work clone and returns a PR link. Code mode: one per branch, at most 3 at once. Its cost counts toward the branch. |
| `fork_branch`, `list_branches`, `read_branch`, `set_model` | Tree management, plus paging and text search over any branch. |
| `upgrade` | Asks the supervisor to deploy the latest `main`. Refuses while any `pi` run is active. |
| `mcp_status`, `mcp_reload`, `mcp_sign_in` | Server state, re-reading `mcp.json`, and OAuth by link. |

A `pi` subagent reads branches through the `aipatty` CLI client (`aipatty branches list|read|search`). It never sees
aipatty's MCP tools.

The system prompt carries the git-hygiene skill and the issue workflow: every change has an issue, a task branch and a
PR that links the issue.

## Remote access

- **API:** bound to the tailnet address. List branches, send, steer, abort, fork, set the model, stream live output,
  and `/health` with the running commit.
- **Page:** branch list, transcript, input box, fork button, model picker, Gmail switch, and cost.
- **CLI:** the same API from a terminal.
- **Auth:** the tailnet. No one else's devices are on it.

## Upgrade and rollback

1. `upgrade` records the request and ends the run.
2. The supervisor fetches `main`, installs, builds, and restarts the agent.
3. If `/health` does not report the new commit within a time limit, the supervisor checks out last-known-good and
   restarts that.
4. On startup the agent calls `resume()` and posts the outcome into the branch that asked.

The supervisor is a launchd daemon that runs as `aipatty`, installed once by an administrator, so it starts at boot
without a login. It changes rarely.

## Guard rails

- **Enforced outside the agent:** `pattycaik` has write, not admin; the `protect-main` ruleset; a standard macOS user
  with none of Steve's credentials in its home.
- **`protect-main` ruleset:** no deletion, no force push, PR with one approval required, and only repository admins
  may update `main`, through a PR. Admins can merge a PR without the approval, since an author cannot approve their
  own PR.
- **Hooks against mistakes:** block pushing to `main`, `gh pr merge`, and writes inside `deploy/`.

## Gmail and OAuth

- **Server:** Google's hosted Gmail MCP server, reported at `https://gmailmcp.googleapis.com/mcp/v1`, in developer
  preview. It needs a Google Cloud project and an OAuth client marked for AI-agent use, owned by
  `aipattychestnut@gmail.com`. Reported to read, search, draft and label, not send. Verify against Google's page
  before building.
- **Sign-in:** `mcp_sign_in` returns a link. Steve approves in a browser and pastes back the address it lands on.
  `pi-mcp` ships both halves (`startMcpSignIn`, `completeMcpSignIn`).
- **Why off by default:** email is untrusted text, and the agent has a shell and GitHub access.

## Build order

1. **Skeleton:** harness, SQLite, the subscription login, one conversation over the API, resume after a kill.
2. **Tree:** fork, list, read and search, per-branch model, the page, cost.
3. **Coding:** the `pi` tool, the git and issue prompt, the hooks.
4. **Upgrade:** supervisor, health check, rollback, tested with a deliberately broken commit.
5. **MCP:** config, one extension per server, reload, OAuth, the per-branch switch, then Gmail.
6. **Install on the mini** and run the acceptance test: from a phone, ask aipatty to open an issue and a PR against
   itself, merge it, say "upgrade", and see the same conversation continue on the new commit.

## Setup only Steve can do

- Create the `aipatty` user on the mini; install Node 26.3 or newer, the pi CLI, dotfiles, model logins, and
  `pattycaik`'s SSH key and `gh` login.
- Fix SSH from the laptop to `macmini` (host key verification fails).
- Create the Google Cloud project and OAuth client for Gmail.

## Left for aipatty to build

Claude for its own conversations, the Spark models, notifications, a chat bot, report-back from branches, approval
prompts, archiving, better search, and `pi` runs that survive a restart.

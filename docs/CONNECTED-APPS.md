# Connected apps

[Gym](GYM-APP.md) is the first connected app. This is the API reference for reviewed apps in this repo.

A connected app is a reviewed module in this repo that gives the branches connected to it:

- **tools and instructions** for the model;
- **card steps** that format its own tool cards and add items to the header strip;
- **pages** of its own, served under `/apps/<id>/`;
- **data** of its own, in `data/apps/<id>/`.

A branch that is not connected to an app sees none of it. If an app fails, aipatty carries on as normal chat.

## What an app is

One interface in `src/apps/app.ts`, one explicit list of apps in [`src/host.ts`](../src/host.ts), and everything
else about an app in `src/apps/<id>/`:

```ts
interface ConnectedApp {
  /** `gym`. Lower-case letters and digits. It is the app's namespace everywhere: see the table below. */
  id: string;
  title: string;
  /** Added to the system prompt of connected branches. */
  instructions: string;
  /** Called once at startup. Throwing marks the app unavailable; it must not leave anything open. */
  open(context: { dataDir: string }): OpenApp;
}

interface OpenApp {
  /** The model's tools, each named `<id>_…`. The host wraps them in one extension. */
  tools: Tool[];
  /** Everything under `/apps/<id>/`. `path` is the rest of the pathname, starting with `/`. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
  /** A browser module that exports `steps: Step[]`, served with its types removed. Omit for no steps. */
  web?: URL;
  close(): void;
}
```

The app imports from the host only `src/apps/app.ts`, the card types in `src/web/cards.ts` and the small HTTP
helpers in [`src/http.ts`](../src/http.ts) (`HttpError`, `jsonBody`, `sendJson`, `requireMethod`). The host
imports only each app's `ConnectedApp` export.

### One namespace per app

The ID is the only thing two apps must not share, and the host checks each use of it at startup:

| What | Namespace | Enforced by |
| --- | --- | --- |
| Tools | names start `<id>_` | the host rejects other names and collisions |
| Routes | `/apps/<id>/…` | the host's router |
| Data | `data/apps/<id>/` | the host creates it and passes it to `open` |
| Card steps | only cards of the app's own tools | the step wrapper, below |
| CSS classes | start `<id>-` | convention; the app's CSS is served from its own route |
| Transcript notices | none of its own | apps do not write entries; their tools return results |

A check that fails makes that app unavailable. It does not stop the server.

## What the host does

### Data

The host creates `data/apps/<id>/` (mode `0700`) and passes the path to `open`. The app decides what is in it.
Data belongs to the app, not to a branch: every connected branch and the app's pages see the same data, and a
fork does not copy it. Faux mode already uses a separate data directory, so it gets separate app data.

### Pages

The host mounts `handle` at `/apps/<id>/` behind the same Host and Origin checks as the rest of
[the API](../src/api.ts), and sets the page's strict CSP and `Cache-Control: no-store` on the response before
calling it, so an app cannot forget them. A handler that throws returns that request's error and affects nothing
else. An app serves its own HTML, scripts, CSS and JSON API from there.

A page is not tied to a branch. A link from a branch carries `?branch=<id>` so the page can link back to
`/#<id>`.

### Tools and instructions

- **Off unless connected.** pi-durable selects every installed extension for a conversation that names none, so
  the host sets the default selection explicitly to the built-in extensions. Unselected app tools are not
  reachable through `tool_search` or through nested `codemode` calls.
- **On a connected branch,** the branch's selection adds each connected app's extension, and its instructions are
  the connected apps' instructions joined in connection order.

### Card steps

The page draws the transcript through [the card pipeline](WEB-CARDS.md). `BranchInfo` reports `connectedApps`
(saved IDs), `availableApps` (all opened modules), and `apps` (the effective intersection in connection order).
The selected branch's stream sends `apps` on attachment and when an app notice arrives.

- The host serves each app's `web` module at `/apps/<id>/web.ts` with its types removed, like the modules in
  `src/web/`. It may import types only, plus `/web/cards.ts` and `/web/shared.ts`. An app with no `web` exports an
  empty steps list from that route.
- For the selected branch the page imports those modules and runs `builtInSteps` followed by each app's steps.
  A module that fails to load is left out, with a notice naming the app.
- **Each app step is wrapped** so that it cannot reach past its own app:
  - `card` is called only for a `toolCall`, `toolResult` or `liveTool` whose tool name starts `<id>_`;
  - `surround` sees only those cards, not the raw live state. It may add `header` items; a `style` it returns
    is dropped.

  So an app can hide, style, re-format, and add buttons and links to its own tool cards, and add links and text
  to the header, and nothing else. The existing rule that a throwing step is skipped still applies.
- **Formatting is a step's `format`.** An app's tools return Markdown, tables included, and its step sets
  `format: "markdown"` on their results. That needs no new renderer. An app supplying its own renderer is left
  until Markdown is not enough.
- `Surround.branch` and `Precard.branch` are the selected branch's read-only ID, including when a card's entry
  was inherited from another branch. Use it for links with `?branch=`.

The header strip shows only what a step can compute from the loaded cards, which in practice is the app's
links. Showing live app data there (such as the last workout) would need a second data source in the pipeline
and a way to know when it is stale; the app's page shows that instead.

## Connecting a branch

Send these in chat, or with `aipatty --branch <id> send '<command>'`. Like `/upgrade`, they are operator
commands intercepted before the model. The response is an operator notice in the transcript, not a model turn.

| Command | Effect |
| --- | --- |
| `/connect` | Lists the apps, whether each is available, and what this branch is connected to. |
| `/connect gym` | Connects this branch to Gym. |
| `/disconnect gym` | Disconnects it. The app's data is untouched. |

- **Record:** one field, `apps: string[]`, on [`BranchDoc`](../src/branches.ts), in connection order. It is the
  only record of a connection.
- **Several apps per branch:** each app is confined to its namespace, so a second connection adds its tools,
  instructions and steps after the first's.
- **Idle only:** connecting and disconnecting are refused with a 409 while the branch is busy.
- **Idempotent:** running either command twice gives the same result.
- **Forks** copy the list. No branch is connected by default, the root included.

## Robustness

One rule: **a branch gets an app only if the app is in its list and the app opened; otherwise that app is
absent from the branch.** One function applies the rule to a branch by setting its extensions and
instructions. It runs for every branch at startup, before interrupted work resumes, and on connect, disconnect
and fork. A failed app is skipped, not disconnected, so its branches get it back once it opens. If a restart
changes a branch's effective app configuration, already interrupted work on that branch is stopped with a
notice to resend: Durable can otherwise reuse the model request it prepared before the restart.

| Failure | What happens |
| --- | --- |
| An app fails to open, or fails a namespace check | See server stderr, `/health` (`appProblems`) or `/connect` for the error and data path. Its branches run without it. Optional app problems do not fail an upgrade's core health check. |
| The app is fixed and aipatty restarts | Its branches have it again, with nothing to redo. |
| A tool throws | The model sees an ordinary tool error and the turn continues. |
| A page handler throws | That request fails. |
| An app's web module fails to load, or a step throws | The page draws without it and shows a notice. |
| A branch lists an app this release does not have | Treated as an app that failed to open. |

Not handled, as decisions:

- **In-process code.** Apps run inside the server. One that hangs the event loop or crashes the process takes
  aipatty down. Apps are reviewed code in this repo, not installed at runtime.
- **Upgrade rollback.** `/upgrade` backs up and restores only `aipatty.sqlite`. App data is not rolled back, so
  an app's schema changes must be additive.
- **Not access control.** A connection selects tools and instructions for the model. Anyone who can reach
  aipatty can open any app's page, and the built-in tools can read `data/apps/` with the service account's
  permissions.
- **Not now:** apps installed at runtime, scheduled jobs, an app changing the composer or prose cards, app-supplied
  renderers and panes, live app data in the header, and app data in the upgrade backup.

## Tests

The seam tests use fixture apps: real pinned Durable turns (including tool search and codemode), idle-only
commands, restart/fork behavior, route headers and errors, and scoped steps with browser fallback. Gym has
separate temporary SQLite and headless Chrome tests with scripted Faux coaching, not live history or credentials.

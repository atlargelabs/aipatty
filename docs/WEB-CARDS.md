# The page's card pipeline

How the web page turns the selected branch's data into the cards of its transcript, and how to add to it. The
types are in [`src/web/cards.ts`](../src/web/cards.ts), the built-in steps in
[`src/web/steps.ts`](../src/web/steps.ts), and the code that draws the result in [`src/page.ts`](../src/page.ts).

This covers the transcript of the selected branch and what surrounds it. The branch list, the model and thinking
pickers, the message box and the CLI are separate and do not use it.

## The idea

```
agent data ──initial()──▶ precards X0, surround Y0 ──step 1──▶ X1, Y1 ──step 2──▶ … ──▶ cards on screen
```

- **Agent data** is what the server sends for the branch: its loaded entries (the newest 50, plus any older pages
  loaded since) and its live state, the work in progress that is not yet in the transcript.
- A **precard** is one card before it is drawn. It holds the part of the data it came from, its text, and a few
  display fields.
- The **surround** is what is drawn around the cards: a header strip, a style for the page, and the open pane.
- **`initial`** makes the first precards and surround from the data alone.
- A **step** changes the display fields of precards, and the surround. Steps run in a fixed order, each on the
  output of the one before.

Every part is a pure function, so the same data and steps always give the same cards. The page stores no
intermediate result. Whenever anything changes (a stream frame, a reconnect, **Load older**, a pane opening) it
runs the whole pipeline again, then keeps each card on screen whose key is still produced and updates only the
parts of it that differ. A stream frame arrives about ten times a second during an answer, so this is what lets a
click, a text selection and the scroll position survive.

## What `initial` produces

`initial` does all the splitting and joining, so that every step works on one precard at a time. In the order of
the conversation:

| `kind` | Made from | Extra data on the precard |
| --- | --- | --- |
| `prose` | The text of a user or system message, or a run of text in an assistant message | `entry`, `message` |
| `toolCall` | One tool call of an assistant message | `entry`, `message`, `call` |
| `toolResult` | A tool's result | `entry`, `message`, and `call` when it is known |
| `notice` | An entry for people and not the model, such as an upgrade's report | `entry` |
| `liveText` | The answer the model is writing now | `message` |
| `liveTool` | A tool call of the current round that has not finished | `slot`, and `call` when it is known |
| `runFailure` | Why the newest run ended without an answer | `failure` |

An assistant message that says something, calls two tools and says something more is four cards, in that order.
Thinking is not shown.

The first four kinds are **settled**: they have an `entry`, come from the saved transcript, and never change. The
last three are **live**: they come from the live state, are always after the settled ones, and come and go with
it. A finished tool call has no live card, because its result is in the transcript.

A `toolResult` and a `liveTool` carry the `call` they belong to: the newest earlier call with the same ID among
the loaded entries. It is absent when that call is on an older page that is not loaded, or when one message used
the same ID for two calls. This is the one place a card looks at another, and it only looks back.

Every precard also has a `key` that identifies its card across runs, a `label` (the small heading, such as
`User · 12`) and `text` (the body). Every settled precard starts with a **Fork here** button.

## What a step can change

A step returns a change to these fields and nothing else:

| Field | Meaning | When two steps set it |
| --- | --- | --- |
| `hidden` | Do not show the card. It stays in the list. | The later step wins |
| `style` | A CSS class added to the card | The later step wins |
| `format` | The renderer for the card's body: `"text"` or `"markdown"`. | The later step wins |
| `buttons` | Buttons in the card's heading, each with an action | Added after the earlier ones |
| `links` | Links in the card's heading | Added after the earlier ones |

And around the cards:

| Field | Meaning | When two steps set it |
| --- | --- | --- |
| `header` | Items in a strip above the transcript: links, or plain text without an `href` | Added after the earlier ones |
| `style` | A CSS class on the page's `<body>` | The later step wins |

A step cannot change a card's text, key or position, cannot remove a card, and cannot remove a button, link or
header item an earlier step added. It hides a card instead of discarding it, so keys and fork points stay valid.

A link's `href` is an absolute `http(s)` URL, which opens in a new tab, or a path on this server starting with one
`/`. Anything else is shown as plain text.

### Buttons and actions

A button names one of four actions, which the page carries out on the selected branch when it is pressed:

| Action | What it does |
| --- | --- |
| `{ type: "send", content }` | Sends `content` as a message, queued as a follow-up if the branch is busy |
| `{ type: "abort" }` | Stops the branch's current run |
| `{ type: "fork", at }` | Asks for a title, then forks the branch with its history through entry `at` |
| `{ type: "openPane", pane }` | Shows `pane` beside the transcript, replacing any pane that is open |

A step chooses an action; it does not supply code to run. That keeps a step a pure function and the cards plain
data. An action that fails shows its error in the notice above the transcript.

### Panes

A pane is named by a reference: plain JSON with a `type` and that pane's arguments. One pane is open at a time. It
opens when the reader presses an `openPane` button and closes when they close it or switch branches, so the open
pane is part of what the reader did, not something a step decides. `Surround.pane` reports it, and steps can read
it there.

A pane fetches its own data and has its own lifecycle. The one pane today is `pi-run`, which polls
`/api/pi-runs/:id`. Adding a pane type means adding its code to the page and a case to `showPane` in
[`src/page.ts`](../src/page.ts).

## The rules a step follows

1. **Pure.** A step's functions compute their result from their arguments. They do not modify them, and read
   nothing else: no clock, no DOM, no network, no variable that changes.
2. **One precard at a time.** `card(precard)` sees that precard only. It cannot see its neighbours or the
   surround, and it sees the live state only when the precard is a live one. So a settled card cannot depend on
   anything that changes.
3. **The surround can see the pipeline so far.** A built-in `surround(surround, precards, live)` gets the surround
   so far, the precards the previous step produced, and the live state. An app gets only its own tool cards and
   no raw live state, and can append header items, not set page style.
4. **Order is the order of the list.** A step sees what the steps before it did and nothing of the steps after it.

Rule 2 is what makes stacking predictable. A step that needed to look ahead in the conversation, such as hiding a
call because its result failed, cannot be written: put that decision on the result's card, which has the call.

A step that throws is skipped where it threw, for that one precard or for the surround. The card is drawn as the
earlier steps left it, and the page shows a notice naming the step, once.

## Writing a step

A step is an object with a name and either or both functions:

```ts
import type { Step } from "./cards.ts";

/** Marks failed tool results, and counts them in the header. */
export const failedResults: Step = {
  name: "failed-results",
  card(precard) {
    if (precard.kind === "toolResult" && precard.message.isError) return { style: "failed" };
  },
  surround(surround, precards) {
    const failed = precards.filter(card => card.kind === "toolResult" && card.message.isError).length;
    if (failed) return { header: [{ label: failed + " failed tool calls" }] };
  },
};
```

Return nothing to leave a card alone. Narrow on `precard.kind` to reach the data of that kind.

To add it:

1. Put the step in [`src/web/steps.ts`](../src/web/steps.ts) and add it to `builtInSteps`, in the position it
   should run.
2. Add the CSS for any class it uses to [`src/web/chat.css`](../src/web/chat.css).
3. If it uses a new `format`, add the renderer to `formats` in `src/page.ts`. The page calls it with the card's
   body element and text whenever the format or text changes.
4. Test it in [`test/cards.test.ts`](../test/cards.test.ts) with `derive(data, steps)`, which needs no browser.

The files in `src/web/` are served to the browser as they are, with their types removed. They may import each
other and import types from anywhere, but must not import values from outside the directory. A new file there
must be added to `pageModules` in `src/page.ts`.

## The built-in steps

Every branch runs these, in this order:

- **`pi-run`** adds **Open Pi run** to a `pi` tool result that names a run, and to the live card of a `pi` call
  while it runs. The button from a live card names the call, not the run, so an open pane keeps following when
  the run starts and when the result's card replaces the live one.
- **`markdown`** sets the format on saved user and assistant prose. Tables scroll horizontally when too wide,
  and column alignment uses CSS classes rather than inline styles. The renderer turns off raw HTML and images
  and allows only absolute HTTP(S) links outside aipatty's hosts. Math is parsed outside code and rendered by
  local KaTeX with trust disabled. KaTeX's DOM renderer applies layout via CSSOM without relaxing the chat CSP;
  rejected formulas show as text. All other cards stay plain text.

## Connected app steps

For the selected branch, the page imports modules for its connected and available apps and adds their wrapped
steps after the built-ins, in connection order. A fork inherits the app list; `/disconnect` removes the app's
steps without changing the transcript. Loading or running a step can fail without breaking built-in cards.
See the [app step contract](CONNECTED-APPS.md#card-steps).

## Not built

- **State in a card.** A card is its precard and nothing more, so it has no form fields or other state of its
  own. A form belongs on an app's own page, reached by a link.
- **A step that reads several earlier cards.** Only the join of a result to its call exists, in `initial`. If
  another join is needed, add it there.
- **Caching.** Every change runs every step over every loaded card. That is cheap at this size: 50 entries a page.

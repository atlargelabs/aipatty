import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradeEntryKind } from "../src/protocol.ts";
import { derive, type AgentData, type Precard, type Step } from "../src/web/cards.ts";
import { builtInSteps } from "../src/web/steps.ts";

const branch = 2;
let nextId = 1;
/** A saved entry of the branch. */
function entry(model: Message[], extra: object = {}): EntryRecord {
  return { id: nextId++, conversationId: branch, kind: "test", model, ...extra } as unknown as EntryRecord;
}
const user = (content: string): Message => ({ role: "user", content, timestamp: 0 });
const result = (toolName: string, toolCallId: string, text: string, details?: object): Message => ({
  role: "toolResult", toolName, toolCallId, content: [{ type: "text", text }], isError: false, timestamp: 0,
  ...(details && { details, durationMs: 2500 }),
} as Message);
const data = (entries: EntryRecord[], live: LiveState = {}): AgentData => ({ branch, entries, live });
/** What a card shows, without the data it was made from. */
const shown = (precards: readonly Precard[]) => precards.map(card => [card.key, card.kind, card.label, card.text]);
const runButtons = (precards: readonly Precard[]) => precards.flatMap(card => card.buttons)
  .filter(button => button.action.type === "openPane");

const first = "20260101T010101-aaaaaaaa";

test("the data alone gives a card per message part, a result its call, and live cards last", () => {
  nextId = 1;
  const bash = fauxToolCall("bash", { command: "ls" }, { id: "b" });
  const pi = fauxToolCall("pi", { task: "Fix it\nand more" }, { id: "p" });
  const entries = [
    entry([user("hello")], { conversationId: 1 }),
    entry([fauxAssistantMessage([
      { type: "thinking", thinking: "hidden" }, { type: "text", text: "one" }, { type: "text", text: "two" }, bash,
      { type: "text", text: "three" }, pi,
    ], { stopReason: "toolUse" })]),
    entry([result("bash", "b", "files"), user("")]),
    entry([], { kind: upgradeEntryKind, data: { text: "Upgrade complete." } }),
    entry([{ role: "system", content: "instructions", timestamp: 0 }]),
  ];
  const live: LiveState = {
    generation: { attempt: 1, message: fauxAssistantMessage([{ type: "text", text: "partial" }, fauxToolCall("bash", { command: "p" })]) as never },
    tools: [{ callId: "b", name: "bash", status: "done" }, { callId: "p", name: "pi", status: "running", details: { runId: first } }],
    runFailure: { taskId: 1 as never, inputs: [], reason: "model_error", detail: "boom" },
  };
  const { precards, surround } = derive(data(entries, live), []);
  assert.deepEqual(shown(precards), [
    ["1:0", "prose", "user · 1", "hello"],
    ["2:0:1", "prose", "assistant · 2", "one\ntwo"],
    ["2:0:3", "toolCall", "assistant · 2", '→ bash {"command":"ls"}'],
    ["2:0:4", "prose", "assistant · 2", "three"],
    ["2:0:5", "toolCall", "assistant · 2", '→ pi {"task":"Fix it\\nand more"}'],
    ["3:0", "toolResult", "toolResult · 3", "files"],
    ["4:notice", "notice", "upgrade · 4", "Upgrade complete."],
    ["5:0", "prose", "system · 5", "instructions"],
    ["live:text", "liveText", "", 'partial\n→ bash {"command":"p"}'],
    ["live:tool:1", "liveTool", "tool · running", "→ pi"],
    ["live:failure", "runFailure", "", "Run failed: model_error: boom"],
  ]);
  assert.deepEqual(surround, { header: [], style: "", pane: undefined });
  assert.deepEqual(derive(data(entries, live), builtInSteps).precards.map(card => card.format), [
    "markdown", "markdown", "text", "markdown", "text", "text", "text", "text", "text", "text", "text",
  ]);
  const [inherited, , , , , bashResult, , , , liveTool] = precards;
  assert.equal("inherited" in inherited && inherited.inherited, true);
  assert.deepEqual(inherited.buttons, [{ label: "Fork here", action: { type: "fork", at: 1 } }]);
  assert.equal(bashResult.kind === "toolResult" && bashResult.call, bash);
  assert.equal(liveTool.kind === "liveTool" && liveTool.call, pi);
  assert.deepEqual(liveTool.buttons, []);
});

test("steps change only the display fields, in order, and a failing step is skipped where it fails", () => {
  nextId = 1;
  const entries = [entry([user("a")]), entry([user("b")]), entry([user("skip")])];
  const failures: string[] = [];
  const steps: Step[] = [
    {
      name: "first",
      card: card => ({ style: "red", buttons: [{ label: "One", action: { type: "send", content: card.text } }], links: [{ label: "L", href: "/x" }] }),
      surround: () => ({ header: [{ label: "Gym", href: "/apps/gym/" }], style: "busy" }),
    },
    {
      name: "second",
      card(card) {
        if (card.text === "skip") throw new Error("no");
        // The step before is visible; what this one returns for other cards is not.
        assert.equal(card.style, "red");
        return card.text === "b" ? { hidden: true, style: "blue", format: "markdown", buttons: [{ label: "Two", action: { type: "abort" } }] } : undefined;
      },
      surround(surround, precards, live) {
        assert.deepEqual([surround.style, precards.map(card => card.style), live], ["busy", ["red", "red", "red"], {}]);
        return { header: [{ label: precards.length + " cards" }] };
      },
    },
    { name: "third", surround() { throw new Error("no"); } },
  ];
  const pane = { type: "pi-run", runId: first };
  const run = () => derive(data(entries), steps, { pane, report: step => failures.push(step) });
  const { precards, surround } = run();
  assert.deepEqual(precards.map(({ hidden, style, format, buttons, links }) => [hidden, style, format, buttons.map(b => b.label), links.length]), [
    [false, "red", "text", ["Fork here", "One"], 1],
    [true, "blue", "markdown", ["Fork here", "One", "Two"], 1],
    [false, "red", "text", ["Fork here", "One"], 1],
  ]);
  assert.deepEqual(surround, { header: [{ label: "Gym", href: "/apps/gym/" }, { label: "3 cards" }], style: "busy", pane });
  assert.deepEqual(failures, ["second", "third"]);
  // The same data gives the same cards, which is what lets the page keep the ones on screen.
  assert.deepEqual(run(), { precards, surround });
});

test("the Pi run step adds a button to a result that names a run and to a running call", () => {
  nextId = 1;
  const call = (task: string, id: string) => fauxToolCall("pi", { task }, { id });
  const older = entry([fauxAssistantMessage([call("First line\nrest", "a")], { stopReason: "toolUse" })]);
  const entries = [
    entry([result("pi", "a", "done", { runId: first })]),
    entry([result("pi", "a", "refused")]),
    entry([result("bash", "a", "not pi", { runId: first })]),
    entry([result("pi", "x", "bad id", { runId: "../etc" })]),
    entry([fauxAssistantMessage([call("Twice", "d"), call("Twice again", "d"), call("Now", "live")], { stopReason: "toolUse" })]),
    entry([result("pi", "d", "ambiguous", { runId: first })]),
  ];
  const live: LiveState = { tools: [
    { callId: "d", name: "pi", status: "done" }, { callId: "live", name: "pi", status: "pending" },
    { callId: "other", name: "bash", status: "running" },
  ] };
  const run = { type: "pi-run", runId: first, durationMs: 2500 };
  // The call is on an older page that is not loaded: the result still opens its run, without the task's title.
  assert.deepEqual(runButtons(derive(data(entries, live), builtInSteps).precards), [
    { label: "Open Pi run", action: { type: "openPane", pane: { ...run, title: "" } } },
    { label: "Open Pi run", action: { type: "openPane", pane: { ...run, title: "" } } },
    { label: "Open Pi run · Now", action: { type: "openPane", pane: { type: "pi-run", title: "Now", callId: "live" } } },
  ]);
  const loaded = derive(data([older, ...entries], live), builtInSteps).precards;
  assert.deepEqual(runButtons(loaded).map(button => button.label), ["Open Pi run · First line", "Open Pi run", "Open Pi run · Now"]);
  // A button is on a result or a live card, never on the call's own card.
  assert.deepEqual(loaded.filter(card => runButtons([card]).length).map(card => card.kind), ["toolResult", "toolResult", "liveTool"]);
});

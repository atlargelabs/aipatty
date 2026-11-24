/**
 * The crude web page: branch list, transcript, input box, fork, rename, model picker and cost. Served by the API
 * with a strict CSP, so the script is a separate same-origin file and every value is rendered as text.
 */
import { piRunApiPath, piRunId, upgradeEntryKind } from "./protocol.ts";

export const pageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aipatty</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header>
  <button id="menu" type="button" aria-label="Branches">☰</button>
  <h1 id="title">aipatty</h1>
  <span id="cost" title="This branch / all branches"></span>
</header>
<div id="layout">
  <nav id="branches" aria-label="Branches">
    <ul id="branch-list"></ul>
  </nav>
  <main>
    <div id="controls">
      <label>Model <select id="model"></select></label>
      <label>Thinking <select id="thinking"></select></label>
      <button id="fork" type="button">Fork</button>
      <button id="rename" type="button">Rename</button>
      <button id="search" type="button">Search</button>
    </div>
    <div id="notice" role="status" hidden></div>
    <section id="transcript" aria-live="polite">
      <button id="older" type="button" hidden>Load older</button>
      <div id="entries"></div>
      <div id="live"></div>
      <div id="run-failure" class="entry" role="status" hidden></div>
    </section>
    <form id="composer">
      <textarea id="input" rows="3" placeholder="Message" required></textarea>
      <div id="actions">
        <button id="send" type="submit">Send</button>
        <button id="abort" type="button">Abort</button>
      </div>
    </form>
  </main>
  <aside id="pi-run" aria-labelledby="pi-run-heading" hidden>
    <div class="run-controls">
      <h2 id="pi-run-heading">Pi run</h2>
      <button id="pi-run-refresh" type="button">Refresh</button>
      <button id="pi-run-close" type="button" aria-label="Close Pi run">Close</button>
    </div>
    <div id="pi-run-view" tabindex="0" aria-label="Run details">
      <p id="pi-run-task" hidden></p>
      <p id="pi-run-message" role="status"></p>
      <div id="pi-run-data"></div>
    </div>
  </aside>
</div>
</body>
</html>
`;

export const pageCss = `
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.45 system-ui, sans-serif; color: #1d1d1f; background: #fafafa; height: 100dvh; display: flex; flex-direction: column; }
header { display: flex; align-items: center; gap: .6rem; padding: .5rem .8rem; background: #fff; border-bottom: 1px solid #ddd; }
header h1 { font-size: 1rem; margin: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#cost { font-variant-numeric: tabular-nums; color: #555; }
#menu { display: none; }
#layout { flex: 1; display: flex; min-height: 0; }
nav { width: 16rem; border-right: 1px solid #ddd; background: #fff; overflow-y: auto; }
nav ul { list-style: none; margin: 0; padding: 0; }
nav li { padding: .5rem .8rem; border-bottom: 1px solid #eee; cursor: pointer; }
nav li.current { background: #e8f0fe; }
nav li .meta { font-size: .8rem; color: #666; }
nav li .busy { color: #0a7d32; }
main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
#controls { display: flex; flex-wrap: wrap; gap: .5rem; padding: .5rem .8rem; border-bottom: 1px solid #eee; align-items: center; }
#controls select { max-width: 14rem; }
#notice { padding: .4rem .8rem; background: #fff4e5; color: #8a4b00; }
#transcript { flex: 1; overflow-y: auto; padding: .8rem; }
.entry { margin: 0 0 .8rem; padding: .5rem .7rem; border-radius: 8px; background: #fff; border: 1px solid #e4e4e4; white-space: pre-wrap; overflow-wrap: anywhere; }
.entry.user { background: #eef5ff; border-color: #cfe0fb; }
.entry.toolResult, .entry.tool { font: 12px/1.4 ui-monospace, monospace; color: #444; background: #f4f4f4; max-height: 12rem; overflow: auto; }
.entry .role { display: block; font-size: .75rem; color: #777; margin-bottom: .2rem; }
.entry .fork-here { float: right; font-size: .75rem; }
.entry.inherited { opacity: .7; }
#live .entry { border-style: dashed; }
#run-failure { background: #fff4e5; color: #8a4b00; }
#composer { display: flex; gap: .5rem; padding: .6rem .8rem; border-top: 1px solid #ddd; background: #fff; }
#composer textarea { flex: 1; min-width: 0; font: inherit; padding: .4rem; resize: vertical; }
#actions { display: flex; flex-direction: column; gap: .4rem; }
button { font: inherit; padding: .3rem .7rem; }
.pi-call { max-width: 100%; text-align: left; white-space: normal; overflow-wrap: anywhere; color: #17458a; }
#pi-run:not([hidden]) { display: flex; }
#pi-run { flex: 0 0 clamp(18rem, 36vw, 35rem); min-width: 0; flex-direction: column; border-left: 1px solid #ddd; background: #fff; }
.run-controls { display: flex; align-items: center; gap: .5rem; padding: .5rem .8rem; border-bottom: 1px solid #ddd; }
.run-controls h2 { flex: 1; font-size: 1rem; margin: 0; }
#pi-run-view { overflow: auto; padding: .5rem .8rem; overflow-wrap: anywhere; }
#pi-run-view h3 { font-size: .95rem; margin-bottom: .35rem; }
#pi-run-view p { white-space: pre-wrap; }
#pi-run-view pre { white-space: pre-wrap; background: #f4f4f4; padding: .5rem; font: 12px/1.45 ui-monospace, monospace; }
#pi-run-view li { margin-bottom: .35rem; }
@media (max-width: 900px) {
  #pi-run { position: fixed; inset: 0; z-index: 3; border: 0; }
}
@media (max-width: 700px) {
  #menu { display: inline-block; }
  nav { position: fixed; top: 2.8rem; left: 0; bottom: 0; z-index: 2; display: none; box-shadow: 2px 0 8px #0003; }
  nav.open { display: block; }
}
`;

export const pageJs = `"use strict";
const $ = id => document.getElementById(id);
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const piRunId = ${piRunId};
const piRunApiPath = ${JSON.stringify(piRunApiPath)};
const app = { branch: null, branches: [], totalCost: 0, entries: [], before: null, live: {}, socket: null, models: [] };

function money(value) { return "$" + value.toFixed(value > 0 && value < 0.01 ? 4 : 2); }

async function api(path, options = {}) {
  const init = { ...options };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { "Content-Type": "application/json" };
  }
  const response = await fetch(path, init);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "HTTP " + response.status);
  return value;
}

function notice(text) {
  $("notice").textContent = text || "";
  $("notice").hidden = !text;
}

function guard(fn) {
  return async (...args) => {
    try { notice(""); await fn(...args); } catch (error) { notice(error.message); }
  };
}

function blockText(block) {
  if (block.type === "text") return block.text;
  if (block.type === "toolCall") return "→ " + block.name + " " + JSON.stringify(block.arguments);
  if (block.type === "image") return "[image]";
  return "";
}

/** The in-flight generation is still text: partial tool arguments are not a durable call yet. */
function messageText(message) {
  if (typeof message.content === "string") return message.content;
  return (message.content || []).map(blockText).filter(Boolean).join("\\n");
}

function isPiCall(block) { return block.type === "toolCall" && block.name === "pi"; }
function isToolRound(message) { return message.role === "assistant" && message.stopReason === "toolUse"; }
function isPiResult(message) { return message.role === "toolResult" && message.toolName === "pi"; }
function runIdOf(details) {
  return typeof details?.runId === "string" && piRunId.test(details.runId) ? details.runId : undefined;
}

function taskTitle(value) {
  const line = typeof value === "string" ? value.trim().split("\\n", 1)[0].trim() : "";
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

function runButton(label, source) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pi-call";
  button.setAttribute("aria-controls", "pi-run");
  button.textContent = label;
  button.addEventListener("click", () => openRun(button, source));
  return button;
}

function messageNodes(entry, message) {
  if (!isToolRound(message) || !message.content.some(isPiCall)) {
    const text = document.createTextNode(messageText(message));
    const id = isPiResult(message) ? runIdOf(message.details) : undefined;
    return id ? [runButton("Open Pi run", { id, durationMs: message.durationMs }), document.createTextNode("\\n"), text] : [text];
  }
  const nodes = [];
  const ids = new Map();
  for (const block of message.content) {
    if (block.type === "toolCall") ids.set(block.id, (ids.get(block.id) || 0) + 1);
  }
  for (const block of message.content) {
    let node;
    if (isPiCall(block)) {
      const title = taskTitle(block.arguments?.task);
      // Duplicate IDs in one round are ambiguous; only the result's own run ID can address it.
      if (ids.get(block.id) > 1) node = "→ pi (duplicate call ID; open the run from its result)";
      else node = runButton("Open Pi run" + (title ? " · " + title : ""), { entry, callId: block.id, title });
    } else node = blockText(block);
    if (!node) continue;
    if (nodes.length) nodes.push(document.createTextNode("\\n"));
    nodes.push(typeof node === "string" ? document.createTextNode(node) : node);
  }
  return nodes;
}

// Follow the durable exchange, not a run ID printed by a model or a tool error. A result may be on
// a newer transcript page; all newer loaded entries are still present when paging back to the call.
function resolveRun(source) {
  if (source.id) return source;
  const { entry, callId } = source;
  const start = app.entries.findIndex(item => item.id === entry.id);
  if (start === -1) return {};
  for (let i = start + 1; i < app.entries.length; i++) {
    const next = app.entries[i];
    if (next.conversationId !== entry.conversationId) continue;
    for (const message of next.model || []) {
      if (isPiResult(message) && message.toolCallId === callId) {
        return { id: runIdOf(message.details), durationMs: message.durationMs, settled: true };
      }
      // If a later round reused a provider's ID, it can't be the result of this call.
      if (isToolRound(message) && message.content.some(block => block.type === "toolCall" && block.id === callId)) return {};
    }
  }
  if (entry.conversationId !== app.branch) return {};
  const slot = app.live.tools?.find(slot => slot.name === "pi" && slot.callId === callId);
  return { id: runIdOf(slot?.details), pending: slot && slot.status !== "done" };
}

let openedRun;
const narrowPane = matchMedia("(max-width: 900px)");
function syncPane() {
  const inert = !!openedRun && narrowPane.matches;
  for (const element of document.querySelectorAll("header, #branches, main")) element.inert = inert;
}

// Keep the first visible entry at the same offset when the desktop pane reflows the chat.
function keepChatPlace(change) {
  const box = $("transcript");
  const top = box.getBoundingClientRect().top;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 2;
  const children = $("entries").children;
  let lo = 0, hi = children.length;
  while (lo < hi) {
    const i = (lo + hi) >>> 1;
    if (children[i].getBoundingClientRect().bottom <= top) lo = i + 1; else hi = i;
  }
  const anchor = children[lo];
  const offset = anchor && anchor.getBoundingClientRect().top - top;
  change();
  if (atBottom) box.scrollTop = box.scrollHeight;
  else if (anchor) box.scrollTop += anchor.getBoundingClientRect().top - box.getBoundingClientRect().top - offset;
}

function openRun(button, source) {
  const alreadyOpen = !!openedRun;
  openedRun = { button, source: { ...source } };
  if (!alreadyOpen) keepChatPlace(() => { $("pi-run").hidden = false; });
  $("pi-run-task").textContent = source.title || "";
  $("pi-run-task").hidden = !source.title;
  $("pi-run-data").replaceChildren();
  $("pi-run-refresh").disabled = false;
  $("pi-run-view").scrollTop = 0;
  syncPane();
  $("pi-run-close").focus({ preventScroll: true });
  void refreshRun();
}

function closeRun(restoreFocus = true) {
  if (!openedRun) return;
  const { button } = openedRun;
  openedRun = undefined;
  keepChatPlace(() => { $("pi-run").hidden = true; });
  $("pi-run-data").replaceChildren();
  syncPane();
  if (restoreFocus && button.isConnected) button.focus({ preventScroll: true });
}

async function refreshRun() {
  const open = openedRun;
  const refresh = $("pi-run-refresh");
  if (!open || refresh.disabled) return;
  const { id, durationMs, settled, pending } = resolveRun(open.source);
  const message = $("pi-run-message");
  if (!id) {
    message.textContent = settled ? "This request did not start a Pi run. See the tool result in chat."
      : pending ? "No run is available for this call yet. If it starts, use Refresh to see it."
      : "No Pi run record is available for this call.";
    return;
  }
  // Once selected, the pane stays on that exact run, even if the live tool slot disappears or the chat resyncs.
  open.source.id = id;
  open.source.durationMs = durationMs;
  refresh.disabled = true;
  message.textContent = "Loading Pi run…";
  try {
    const snapshot = await api(piRunApiPath + id);
    if (openedRun !== open) return;
    renderRun(snapshot, durationMs);
  } catch (error) {
    if (openedRun !== open) return;
    $("pi-run-data").replaceChildren();
    message.textContent = "Could not open run " + id + ": " + error.message;
  } finally {
    if (openedRun === open) refresh.disabled = false;
  }
}

function renderRun(snapshot, durationMs) {
  const status = snapshot.status.replaceAll("_", " ");
  const ms = snapshot.durationMs ?? durationMs;
  const elapsed = ms === undefined ? "" : " · " + Math.floor(ms / 60000) + "m " + Math.floor(ms / 1000) % 60 + "s";
  $("pi-run-message").textContent = snapshot.runId + " · " + status + elapsed
    + (snapshot.status === "running" ? " (snapshot; refresh for more)" : "");
  const data = $("pi-run-data");
  data.replaceChildren();
  const add = (tag, text, parent = data) => {
    const node = document.createElement(tag);
    node.textContent = text;
    parent.append(node);
    return node;
  };
  const shown = output => output.text + (output.truncated ? "\\n[Truncated]" : "");
  const result = snapshot.result;
  if (result) {
    add("h3", "Result");
    if (result.summary) add("p", shown(result.summary));
    for (const [label, link] of [["Confirmed PR", result.pr], ["Confirmed issue", result.issue]]) {
      if (!link) continue;
      const anchor = add("a", label + " #" + link.url.split("/").at(-1), add("p", ""));
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
    }
    if (result.pr?.headSha) add("p", "PR head: " + result.pr.headSha);
    if (result.review && result.review.status !== "none") {
      const review = result.review;
      add("p", "Review: " + review.status + (review.verdict ? " · verdict: " + review.verdict : "")
        + "\\nReviewed SHA: " + (review.sha ?? "unknown")
        + "\\nFindings: " + (review.important ?? "unknown") + " important, " + (review.lesser ?? "unknown") + " lesser");
    }
    for (const [label, items] of [["Problems", result.problems], ["Remaining", result.remaining]]) {
      if (!items.length) continue;
      add("h3", label);
      const list = add("ul", "");
      for (const item of items) add("li", shown(item), list);
    }
    if (result.listsTruncated) add("p", "Result lists truncated.");
  }
  add("h3", "Recent activity");
  const activity = snapshot.activity;
  if (activity?.truncated) add("p", "Activity truncated; only a recent excerpt is shown.");
  if (activity?.incomplete) add("p", "Incomplete or unreadable events skipped.");
  if (!activity?.items.length) add("p", activity ? "No visible activity in this snapshot." : "No activity log available.");
  for (const item of activity?.items ?? []) {
    if (item.kind === "tool") add("div", "→ " + item.name + " · " + item.status);
    if (item.output) add("pre", shown(item.output));
  }
  if (snapshot.stderr) {
    add("h3", "Pi stderr");
    add("pre", (snapshot.stderr.truncated ? "[Earlier stderr omitted]\\n" : "") + snapshot.stderr.text);
  }
}

narrowPane.addEventListener("change", syncPane);
$("pi-run-refresh").addEventListener("click", refreshRun);
$("pi-run-close").addEventListener("click", () => closeRun());
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && openedRun) closeRun();
});

function current() { return app.branches.find(branch => branch.id === app.branch); }

/*
 * A stream frame arrives about ten times a second while a branch answers. Rendering one must leave the nodes already
 * on the page in place: a node replaced between a press and its release gets no click, and loses its selection and
 * scroll position. So the branch list is updated in place, and a frame only adds the transcript's new entries.
 */
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

const branchNodes = new Map();

/** The list item of a branch, made once and then kept. */
function branchNode(id) {
  let node = branchNodes.get(id);
  if (!node) {
    const li = document.createElement("li");
    li.dataset.branch = id;
    const title = document.createElement("div");
    const meta = document.createElement("div");
    meta.className = "meta";
    const info = document.createElement("span");
    const busy = document.createElement("span");
    busy.className = "busy";
    busy.textContent = " · busy";
    meta.append(info, busy);
    li.append(title, meta);
    node = { li, title, info, busy };
    branchNodes.set(id, node);
  }
  return node;
}

function renderBranches() {
  const list = $("branch-list");
  for (const [id, node] of branchNodes) {
    if (app.branches.some(branch => branch.id === id)) continue;
    node.li.remove();
    branchNodes.delete(id);
  }
  app.branches.forEach((branch, index) => {
    const node = branchNode(branch.id);
    node.li.classList.toggle("current", branch.id === app.branch);
    setText(node.title, branch.title);
    const model = branch.model ? branch.model.modelId : "no model";
    setText(node.info, "#" + branch.id + " · " + model + " · " + money(branch.cost));
    node.busy.hidden = !branch.busy;
    if (list.children[index] !== node.li) list.insertBefore(node.li, list.children[index] || null);
  });
  const branch = current();
  if (!branch) return;
  setText($("title"), branch.title);
  document.title = branch.title + " · aipatty";
  setText($("cost"), money(branch.cost) + " / " + money(app.totalCost));
  const ref = branch.model ? branch.model.provider + "/" + branch.model.modelId : "";
  const picker = $("model");
  if (![...picker.options].some(option => option.value === ref)) {
    const option = document.createElement("option");
    option.value = ref;
    option.textContent = (branch.model ? branch.model.modelId : "(none)") + " (unavailable)";
    picker.prepend(option);
  }
  if (picker.value !== ref) picker.value = ref;
  if ($("thinking").value !== branch.thinking) $("thinking").value = branch.thinking;
}

function entryNode(entry, message) {
  const div = document.createElement("div");
  div.className = "entry " + message.role + (entry.conversationId !== app.branch ? " inherited" : "");
  const role = document.createElement("span");
  role.className = "role";
  role.textContent = message.role + " · " + entry.id;
  const fork = document.createElement("button");
  fork.type = "button";
  fork.className = "fork-here";
  fork.textContent = "Fork here";
  fork.addEventListener("click", guard(() => forkAt(entry.id)));
  div.append(fork, role, ...messageNodes(entry, message));
  return div;
}

function entryNodes(entries) {
  const nodes = [];
  for (const entry of entries) {
    if (entry.kind === ${JSON.stringify(upgradeEntryKind)} && entry.data && typeof entry.data.text === "string") {
      nodes.push(entryNode(entry, { role: "upgrade", content: entry.data.text }));
    }
    for (const message of entry.model || []) {
      if (isToolRound(message) && message.content.some(isPiCall)
          || isPiResult(message) && runIdOf(message.details) || messageText(message)) nodes.push(entryNode(entry, message));
    }
  }
  return nodes;
}

/** Change the transcript, and keep it scrolled to the bottom if it was there. */
function keepAtBottom(change) {
  const box = $("transcript");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  change();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// A branch switch or replacement snapshot supersedes any pending load for the old transcript.
let transcriptRevision = 0;
function renderEntries() {
  transcriptRevision++;
  $("older").disabled = false;
  keepAtBottom(() => {
    $("entries").replaceChildren(...entryNodes(app.entries));
    $("older").hidden = app.before === null;
    renderLive();
  });
}

/** Add the entries of a stream update below the ones shown. */
function appendEntries(entries) {
  keepAtBottom(() => {
    $("entries").append(...entryNodes(entries));
    renderLive();
  });
}

function renderLive() {
  $("abort").disabled = !app.live.run;
  const failure = app.live.runFailure;
  setText($("run-failure"), failure ? "Run failed: " + failure.reason + (failure.detail ? ": " + failure.detail : "") : "");
  $("run-failure").hidden = !failure;
  const live = $("live");
  const message = app.live.generation && app.live.generation.message;
  const text = message ? messageText(message) : "";
  if (!text) { live.replaceChildren(); return; }
  let div = live.firstElementChild;
  if (!div) {
    div = document.createElement("div");
    div.className = "entry assistant";
    live.append(div);
  }
  setText(div, text);
}

function connect(id) {
  if (app.socket) app.socket.close();
  const url = new URL("/api/conversations/" + id + "/stream", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  app.socket = socket;
  socket.addEventListener("message", event => {
    if (app.socket !== socket) return;
    const frame = JSON.parse(event.data);
    if (frame.type === "state") {
      app.entries = frame.entries;
      app.before = frame.before;
    } else if (frame.type === "update") {
      app.entries = app.entries.concat(frame.appended);
    } else {
      return;
    }
    app.live = frame.live || {};
    const branch = current();
    if (branch) {
      const wasBusy = branch.busy;
      branch.busy = frame.busy;
      branch.cost = frame.usage.cost;
      if (wasBusy && !frame.busy) refreshBranches();
    }
    if (frame.type === "state") renderEntries(); else appendEntries(frame.appended);
    renderBranches();
  });
  socket.addEventListener("close", () => {
    if (app.socket === socket) setTimeout(() => { if (app.socket === socket) connect(id); }, 2000);
  });
}

async function refreshBranches() {
  const { branches, totalCost } = await api("/api/branches");
  app.branches = branches;
  app.totalCost = totalCost;
  renderBranches();
}

async function selectBranch(id) {
  closeRun(false);
  app.branch = id;
  app.entries = [];
  app.before = null;
  app.live = {};
  history.replaceState(null, "", "#" + id);
  renderEntries();
  renderBranches();
  connect(id);
}

async function forkAt(at) {
  const title = prompt("Title for the new branch");
  if (!title) return;
  const created = await api("/api/conversations/" + app.branch + "/fork", { method: "POST", body: at ? { title, at } : { title } });
  await refreshBranches();
  await selectBranch(created.id);
}

async function loadModels() {
  const { models } = await api("/api/models");
  app.models = models;
  $("model").replaceChildren(...models.map(model => {
    const option = document.createElement("option");
    option.value = model.provider + "/" + model.modelId;
    option.textContent = model.modelId + " (" + model.provider + ")";
    return option;
  }));
  $("thinking").replaceChildren(...thinkingLevels.map(level => {
    const option = document.createElement("option");
    option.value = option.textContent = level;
    return option;
  }));
}

let draftRevision = 0;
$("input").addEventListener("input", () => { draftRevision++; });
$("composer").addEventListener("submit", guard(async event => {
  event.preventDefault();
  const send = $("send");
  const branch = app.branch;
  const revision = draftRevision;
  const content = $("input").value;
  if (send.disabled || branch === null || !content.trim()) return;
  send.disabled = true;
  try {
    // Unlike randomUUID, getRandomValues does not need a secure context.
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    await api("/api/conversations/" + branch + "/messages", {
      method: "POST", body: { content, requestId, whenBusy: "followUp" },
    });
    if (branch === app.branch && revision === draftRevision) $("input").value = "";
  } finally {
    send.disabled = false;
  }
}));
$("input").addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
  // Safari can report isComposing=false on the Enter that commits an IME candidate.
  if (event.isComposing || event.keyCode === 229) return;
  if (!event.ctrlKey && !event.metaKey && window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;
  event.preventDefault();
  if (!event.repeat) $("composer").requestSubmit();
});
$("abort").addEventListener("click", guard(() => api("/api/conversations/" + app.branch + "/abort", { method: "POST" })));
$("fork").addEventListener("click", guard(() => forkAt()));
$("rename").addEventListener("click", guard(async () => {
  const branch = current();
  const title = prompt("Branch title", branch ? branch.title : "");
  if (!title) return;
  await api("/api/conversations/" + app.branch + "/title", { method: "PUT", body: { title } });
  await refreshBranches();
}));
$("search").addEventListener("click", guard(async () => {
  const q = prompt("Search this branch for");
  if (!q) return;
  const { matches } = await api("/api/conversations/" + app.branch + "/search?q=" + encodeURIComponent(q));
  notice(matches.length ? matches.map(m => "[" + m.entryId + "] " + m.role + ": " + m.excerpt).join("\\n") : "No matches");
}));
$("model").addEventListener("change", guard(async event => {
  const [provider, ...rest] = event.target.value.split("/");
  try {
    await api("/api/conversations/" + app.branch + "/model", { method: "PUT", body: { provider, modelId: rest.join("/") } });
  } finally {
    await refreshBranches();
  }
}));
$("thinking").addEventListener("change", guard(async event => {
  try {
    await api("/api/conversations/" + app.branch + "/thinking", { method: "PUT", body: { level: event.target.value } });
  } finally {
    await refreshBranches();
  }
}));
$("older").addEventListener("click", guard(async () => {
  const button = $("older");
  if (button.disabled || app.before === null) return;
  const revision = transcriptRevision;
  button.disabled = true;
  try {
    const page = await api("/api/conversations/" + app.branch + "?before=" + app.before);
    if (revision !== transcriptRevision) return;
    app.entries = page.entries.concat(app.entries);
    app.before = page.before;
    const box = $("transcript");
    const { scrollHeight, scrollTop } = box;
    $("entries").prepend(...entryNodes(page.entries));
    $("older").hidden = app.before === null;
    box.scrollTop = scrollTop + box.scrollHeight - scrollHeight;
  } finally {
    if (revision === transcriptRevision) button.disabled = false;
  }
}));
$("menu").addEventListener("click", () => $("branches").classList.toggle("open"));
$("branch-list").addEventListener("click", event => {
  const li = event.target.closest("li");
  if (!li) return;
  selectBranch(Number(li.dataset.branch));
  $("branches").classList.remove("open");
});

guard(async () => {
  await loadModels();
  await refreshBranches();
  const wanted = Number(location.hash.slice(1));
  await selectBranch(app.branches.some(branch => branch.id === wanted) ? wanted : app.branches[0].id);
  setInterval(() => { refreshBranches().catch(() => {}); }, 10000);
})();
`;

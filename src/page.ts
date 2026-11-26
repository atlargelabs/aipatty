/**
 * The crude web page: branch list, transcript, input box, branch controls, model picker and cost. Served by the API
 * with a strict CSP and same-origin scripts. The pipeline selects which cards use the built-in Markdown renderer.
 *
 * The transcript is drawn from the card pipeline in ./web/cards.ts (see docs/WEB-CARDS.md). This file is the
 * shell around it and the code that puts its cards on screen.
 */
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const markdownScriptPath = "/markdown-it.js";

/** Browser modules by URL: our own with types removed, and the pinned parser's standalone ESM bundle. */
export const pageModules: Readonly<Record<string, string>> = {
  ...Object.fromEntries(["cards", "shared", "steps"].map(name => [
    `/web/${name}.ts`, stripTypeScriptTypes(readFileSync(new URL(`./web/${name}.ts`, import.meta.url), "utf8")),
  ])),
  [markdownScriptPath]: readFileSync(new URL(import.meta.resolve("markdown-it/browser")), "utf8"),
};

export const pageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aipatty</title>
<link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script>
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
      <button id="new" type="button">New</button>
      <button id="rename" type="button">Rename</button>
      <button id="archive" type="button" hidden>Archive</button>
      <button id="search" type="button">Search</button>
    </div>
    <div id="notice" role="status" hidden></div>
    <div id="card-notice" role="status" hidden></div>
    <div id="card-header" hidden></div>
    <section id="transcript" aria-live="polite">
      <button id="older" type="button" hidden>Load older</button>
      <div id="entries"></div>
      <div id="live"></div>
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
      <button id="pi-run-jump" type="button" aria-controls="pi-run-view" hidden>Jump to latest</button>
      <button id="pi-run-close" type="button" aria-label="Close Pi run">Close</button>
    </div>
    <p class="run-status"><span id="pi-run-message" role="status"></span><span id="pi-run-elapsed"></span></p>
    <div id="pi-run-view" tabindex="0" aria-label="Run details">
      <p id="pi-run-task" hidden></p>
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
#notice, #card-notice { padding: .4rem .8rem; background: #fff4e5; color: #8a4b00; white-space: pre-line; }
#transcript { flex: 1; overflow-y: auto; padding: .8rem; }
.entry { margin: 0 0 .8rem; padding: .5rem .7rem; border-radius: 8px; background: #fff; border: 1px solid #e4e4e4; white-space: pre-wrap; overflow-wrap: anywhere; }
.entry.user { background: #eef5ff; border-color: #cfe0fb; }
.entry:is(.toolCall, .toolResult, .liveTool) { font: 12px/1.4 ui-monospace, monospace; color: #444; background: #f4f4f4; max-height: 12rem; overflow: auto; }
.entry.inherited { opacity: .7; }
.entry:is(.liveText, .liveTool) { border-style: dashed; }
.entry.runFailure { background: #fff4e5; color: #8a4b00; }
.card-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: .2rem .5rem; margin-bottom: .2rem; white-space: normal; font: .75rem/1.45 system-ui, sans-serif; }
.card-head[hidden] { display: none; }
.card-head .role { flex: 1; color: #777; }
.card-head button { max-width: 100%; padding: .1rem .5rem; text-align: left; overflow-wrap: anywhere; }
.card-head button[data-action="openPane"] { color: #17458a; }
.card-body[data-format="markdown"] { display: flow-root; white-space: normal; }
.card-body[data-format="markdown"] :where(p, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6, .markdown-table) { margin: .55rem 0; }
.card-body[data-format="markdown"] > :first-child { margin-top: 0; }
.card-body[data-format="markdown"] > :last-child { margin-bottom: 0; }
.card-body[data-format="markdown"] h1 { font-size: 1.35rem; }
.card-body[data-format="markdown"] h2 { font-size: 1.2rem; }
.card-body[data-format="markdown"] :is(h3, h4, h5, h6) { font-size: 1rem; }
.card-body[data-format="markdown"] :is(ul, ol) { padding-inline-start: 1.5rem; }
.card-body[data-format="markdown"] blockquote { border-inline-start: 3px solid #b9c2ce; padding-inline-start: .65rem; }
.card-body[data-format="markdown"] code { font: .9em ui-monospace, monospace; background: #f0f0f0; border-radius: 4px; padding: .1em .25em; }
.card-body[data-format="markdown"] pre { overflow-x: auto; white-space: pre; overflow-wrap: normal; background: #f0f0f0; border-radius: 4px; padding: .55rem; }
.card-body[data-format="markdown"] pre code { padding: 0; background: none; }
.markdown-table { overflow-x: auto; }
.markdown-table table { width: 100%; border-collapse: collapse; }
.markdown-table :is(th, td) { border: 1px solid #ddd; padding: .25rem .5rem; overflow-wrap: normal; text-align: left; }
.markdown-table th { background: #f4f4f4; }
.markdown-table .align-center { text-align: center; }
.markdown-table .align-right { text-align: right; }
#card-header:not([hidden]) { display: flex; flex-wrap: wrap; gap: .3rem 1rem; padding: .4rem .8rem; border-bottom: 1px solid #eee; background: #fff; }
#composer { display: flex; gap: .5rem; padding: .6rem .8rem; border-top: 1px solid #ddd; background: #fff; }
#composer textarea { flex: 1; min-width: 0; font: inherit; padding: .4rem; resize: vertical; }
#actions { display: flex; flex-direction: column; gap: .4rem; }
button { font: inherit; padding: .3rem .7rem; }
#pi-run:not([hidden]) { display: flex; }
#pi-run { flex: 0 0 clamp(18rem, 36vw, 35rem); min-width: 0; flex-direction: column; border-left: 1px solid #ddd; background: #fff; }
.run-controls { display: flex; align-items: center; gap: .5rem; padding: .5rem .8rem; border-bottom: 1px solid #ddd; }
.run-controls h2 { flex: 1; font-size: 1rem; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#pi-run-jump { white-space: nowrap; }
.run-status { flex: none; height: calc(2.9em + .4rem); margin: 0; padding: .2rem .8rem; overflow: auto; overflow-wrap: anywhere; }
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

export const pageJs = (appHostnames: readonly string[]) => `import markdownit from ${JSON.stringify(markdownScriptPath)};
import { derive, scopeAppStep } from "/web/cards.ts";
import { piRunApiPath } from "/web/shared.ts";
import { builtInSteps, runIdOf } from "/web/steps.ts";

const $ = id => document.getElementById(id);
const rootId = ${ROOT_CONVERSATION_ID};
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// What the page holds: the agent data of the selected branch (entries, live), and what the reader has done to the
// view (the pane they opened and the button that opened it).
const app = {
  branch: null, branches: [], totalCost: 0, entries: [], before: null, live: {}, socket: null, models: [],
  pane: undefined, opener: undefined,
};
// The selected branch's app steps follow the built-ins. Switching invalidates any import still in flight.
let steps = builtInSteps;
let appKey = "";
let appRevision = 0;

function money(value) { return "$" + value.toFixed(value > 0 && value < 0.01 ? 4 : 2); }

async function api(path, options = {}) {
  const init = { ...options };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { "Content-Type": "application/json" };
  }
  const response = await fetch(path, init);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || "HTTP " + response.status), { status: response.status });
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

// The run a "pi-run" pane is about (see piRunStep). One opened from a result names its run. One opened from a live
// card names the call: read the run from the call's live slot, and once that is gone, from the result it left.
function resolveRun(ref) {
  if (ref.runId) return { id: ref.runId, durationMs: ref.durationMs };
  const slot = app.live.tools?.find(slot => slot.name === "pi" && slot.callId === ref.callId);
  if (slot && slot.status !== "done") return { id: runIdOf(slot.details), pending: true };
  for (let i = app.entries.length - 1; i >= 0; i--) {
    for (const message of (app.entries[i].model || []).toReversed()) {
      if (message.role === "toolResult" && message.toolName === "pi" && message.toolCallId === ref.callId) {
        return { id: runIdOf(message.details), durationMs: message.durationMs, settled: true };
      }
      // An earlier round that reused the ID is not this call: stop at the call itself.
      if (message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === ref.callId)) return {};
    }
  }
  return {};
}

let openedRun;
const runPane = $("pi-run");
const runView = $("pi-run-view");
const runJump = $("pi-run-jump");
const runPollMs = 1500;
const runBottomTolerance = 4;
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

function stopRunWatch() {
  if (!openedRun) return;
  clearTimeout(openedRun.timer);
  openedRun.cancelRequest?.();
  openedRun = undefined;
}

function openRun(ref) {
  const alreadyOpen = !!openedRun;
  stopRunWatch();
  openedRun = { ref };
  if (!alreadyOpen) keepChatPlace(() => { runPane.hidden = false; });
  $("pi-run-task").textContent = ref.title || "";
  $("pi-run-task").hidden = !ref.title;
  $("pi-run-data").replaceChildren();
  runJump.hidden = true;
  runView.scrollTop = 0;
  syncPane();
  $("pi-run-close").focus({ preventScroll: true });
  resolveOpenedRun();
}

function closeRun() {
  if (!openedRun) return;
  stopRunWatch();
  keepChatPlace(() => { runPane.hidden = true; });
  $("pi-run-data").replaceChildren();
  syncPane();
  if (app.opener?.isConnected) app.opener.focus({ preventScroll: true });
}

// Reserve space outside the log for polling status so it stays visible without shifting the reading position.
function setRunStatus(text, elapsed = "", detail = "") {
  const message = $("pi-run-message");
  setText(message, text);
  if (message.title !== detail) message.title = detail;
  setText($("pi-run-elapsed"), elapsed);
}

function resolveOpenedRun() {
  const open = openedRun;
  if (!open || open.run) return;
  const run = resolveRun(open.ref);
  if (!run.id) {
    if (run.settled) open.run = run;
    setRunStatus(run.settled ? "This request did not start a Pi run. See the tool result in chat."
      : run.pending ? "Waiting for this call to start a Pi run…"
      : "No Pi run record is available for this call.");
    return;
  }
  // Stay on this exact ID even if the live slot disappears or the transcript resyncs.
  open.run = run;
  setRunStatus("Loading Pi run…");
  void pollRun(open, run.pending);
}

async function pollRun(open, active) {
  const { id, durationMs } = open.run;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10000);
  open.cancelRequest = () => {
    clearTimeout(deadline);
    controller.abort();
  };
  try {
    const snapshot = await api(piRunApiPath + id, { signal: controller.signal });
    if (openedRun !== open) return;
    const status = snapshot.status.replaceAll("_", " ");
    const ms = snapshot.durationMs ?? durationMs;
    const elapsed = ms === undefined ? "" : " · " + Math.floor(ms / 60000) + "m " + Math.floor(ms / 1000) % 60 + "s";
    setRunStatus(snapshot.runId + " · " + status, elapsed);
    open.latest = snapshot;
    open.logKey = JSON.stringify([snapshot.result, snapshot.activity, snapshot.stderr]);
    active = snapshot.status === "running";
  } catch (error) {
    if (openedRun !== open) return;
    // The host writes the archive before releasing the active slot; 404 means there is no run to follow.
    active = active && error.status !== 404;
    const detail = (open.latest ? "Could not refresh run " : "Could not open run ") + id + ": " + error.message;
    if (!open.latest) setText($("pi-run-data"), detail);
    setRunStatus(active ? "Could not get new output. Retrying…"
      : open.latest ? "Run unavailable. Updates stopped." : "Could not open Pi run.", "", detail);
  } finally {
    clearTimeout(deadline);
    open.cancelRequest = undefined;
  }
  syncRunScroll();
  // Wait for the entire response before scheduling the next fetch.
  if (active) open.timer = setTimeout(() => void pollRun(open, true), runPollMs);
}

function syncRunScroll(jump = false) {
  const open = openedRun;
  if (!open) return;
  // Read the actual position before touching the DOM. A scroll event may still be queued.
  const bottom = runView.scrollHeight - runView.clientHeight;
  const near = runView.scrollTop + runBottomTolerance;
  const { clientWidth: width, clientHeight: height } = runPane;
  // Resizing can move the bottom without scrolling. Follow if we're still at the old bottom.
  const resizedAtBottom = (width !== open.width || height !== open.height) && near >= open.bottom;
  const following = jump || open.shownLogKey === undefined || near >= bottom || resizedAtBottom;
  open.width = width;
  open.height = height;
  open.bottom = bottom;
  const restoreFocus = following && document.activeElement === runJump;
  runJump.hidden = following;
  if (!following) return;

  const logChanged = open.logKey !== open.shownLogKey;
  // Leave the log nodes alone if only the elapsed time changed, or while the reader is away from the bottom.
  if (logChanged) {
    renderRun(open.latest);
    open.shownLogKey = open.logKey;
  }
  if (jump || resizedAtBottom || logChanged) {
    runView.scrollTop = runView.scrollHeight;
    open.bottom = runView.scrollHeight - runView.clientHeight;
  }
  if (restoreFocus) runView.focus({ preventScroll: true });
}

function renderRun(snapshot) {
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
runView.addEventListener("scroll", () => syncRunScroll());
new ResizeObserver(() => syncRunScroll()).observe(runPane);
runJump.addEventListener("click", () => syncRunScroll(true));
function closePane() {
  app.pane = undefined;
  render();
}
$("pi-run-close").addEventListener("click", closePane);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && openedRun) closePane();
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
  $("archive").hidden = !branch || branch.id === rootId;
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

/*
 * Drawing the card pipeline's output. A stream frame arrives about ten times a second while a branch answers, and
 * the whole pipeline runs again for each. A card on screen is kept and only the parts of it that changed are
 * touched, for the same reason as the branch list above.
 */

// No raw HTML or plugins.
const markdown = markdownit({ html: false, breaks: true });
const appHostnames = ${JSON.stringify(appHostnames.map(host => host.replace(/\.$/, "")))};
markdown.validateLink = href => {
  if (!/^https?:\\/\\//i.test(href)) return false;
  try {
    const url = new URL(href);
    return !url.username && !url.password && !appHostnames.includes(url.hostname.replace(/\\.$/, ""));
  } catch { return false; }
};
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index];
  // The parser can emit an empty href for [label](); don't navigate back to the app.
  if (!markdown.validateLink(token.attrGet("href") || "")) return "<a>";
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = () => "[image]";
markdown.renderer.rules.table_open = () => '<div class="markdown-table"><table>\\n';
markdown.renderer.rules.table_close = () => "</table></div>\\n";

function renderTableCell(tokens, index, options, _env, renderer) {
  const token = tokens[index];
  const style = token.attrIndex("style");
  if (style !== -1) {
    // markdown-it sets a style attribute for alignment. Use stylesheet classes under the page's CSP.
    const [, value] = token.attrs[style];
    token.attrs.splice(style, 1);
    if (value === "text-align:center") token.attrJoin("class", "align-center");
    if (value === "text-align:right") token.attrJoin("class", "align-right");
    // Left is already the stylesheet default.
  }
  return renderer.renderToken(tokens, index, options);
}
markdown.renderer.rules.th_open = renderTableCell;
markdown.renderer.rules.td_open = renderTableCell;

// Only draw a body when its text or format changes, so nested nodes survive stream updates.
const bodyText = new WeakMap();
const formats = {
  text(body, text) { body.textContent = text; },
  markdown(body, text) { body.innerHTML = markdown.render(text); },
};

function sendMessage(branch, content) {
  // Unlike randomUUID, getRandomValues does not need a secure context.
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  return api("/api/conversations/" + branch + "/messages", { method: "POST", body: { content, requestId, whenBusy: "followUp" } });
}

// Carry out a button's action against the selected branch. These are all the actions there are (see Action in
// src/web/cards.ts).
async function act(action, button) {
  if (action.type === "send") await sendMessage(app.branch, action.content);
  else if (action.type === "abort") await api("/api/conversations/" + app.branch + "/abort", { method: "POST" });
  else if (action.type === "fork") await forkAt(action.at);
  else if (action.type === "openPane") {
    app.pane = action.pane;
    app.opener = button;
    // Pressing the button of the pane that is open starts it again.
    shownPane = undefined;
    render();
  } else throw new Error("Unknown action " + action.type);
}

function buttonNode({ label, action }) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action.type;
  button.textContent = label;
  button.addEventListener("click", guard(() => act(action, button)));
  return button;
}

// An absolute http(s) URL opens in a new tab and a path stays on this server. Anything else is not a link.
function linkNode({ label, href = "" }) {
  const external = /^https?:\\/\\//i.test(href) && URL.canParse(href);
  const local = href[0] === "/" && href[1] !== "/" && href[1] !== "\\\\";
  const node = document.createElement(external || local ? "a" : "span");
  node.textContent = label;
  if (external || local) node.href = href;
  if (external) {
    node.target = "_blank";
    node.rel = "noopener noreferrer";
  }
  return node;
}

function drawCard(node, precard) {
  const classes = new Set(["entry", precard.kind, precard.message?.role, precard.inherited && "inherited", precard.style]);
  const className = [...classes].filter(Boolean).join(" ");
  if (node.className !== className) node.className = className;
  if (node.hidden !== precard.hidden) node.hidden = precard.hidden;
  const [head, body] = node.children;
  setText(head.firstChild, precard.label);
  const controls = JSON.stringify([precard.links, precard.buttons]);
  if (node.dataset.controls !== controls) {
    node.dataset.controls = controls;
    head.replaceChildren(head.firstChild, ...precard.links.map(linkNode), ...precard.buttons.map(buttonNode));
  }
  head.hidden = !precard.label && !precard.links.length && !precard.buttons.length;
  const format = Object.hasOwn(formats, precard.format) ? precard.format : "text";
  if (body.dataset.format !== format || bodyText.get(body) !== precard.text) {
    formats[format](body, precard.text);
    body.dataset.format = format;
    bodyText.set(body, precard.text);
  }
}

/** Make a container show the given precards, in order, keeping the card of every key it already shows. */
function drawCards(container, precards) {
  const old = new Map([...container.children].map(node => [node.dataset.key, node]));
  precards.forEach((precard, index) => {
    let node = old.get(precard.key);
    old.delete(precard.key);
    if (!node) {
      node = document.createElement("div");
      node.dataset.key = precard.key;
      const head = document.createElement("div");
      head.className = "card-head";
      const label = document.createElement("span");
      label.className = "role";
      head.append(label);
      const body = document.createElement("div");
      body.className = "card-body";
      node.append(head, body);
    }
    drawCard(node, precard);
    if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
  });
  for (const node of old.values()) node.remove();
}

function drawSurround(surround) {
  const header = $("card-header");
  const items = JSON.stringify(surround.header);
  if (header.dataset.items !== items) {
    header.dataset.items = items;
    header.replaceChildren(...surround.header.map(linkNode));
  }
  header.hidden = !surround.header.length;
  if (document.body.className !== surround.style) document.body.className = surround.style;
}

// The pane on screen, as the JSON of its reference.
let shownPane;
function showPane(ref) {
  const key = ref && JSON.stringify(ref);
  if (key === shownPane) return;
  shownPane = key;
  if (ref?.type === "pi-run") openRun(ref);
  else {
    closeRun();
    if (ref) notice("This page has no pane of type " + ref.type + ".");
  }
}

// A failure is reported once per selection, not once a frame. Keep it separate from composer/action notices.
const cardProblems = new Map();
function showCardProblems() {
  $("card-notice").textContent = [...cardProblems.values()].join("\\n");
  $("card-notice").hidden = !cardProblems.size;
}
function reportStep(step, error) {
  if (cardProblems.has(step)) return;
  cardProblems.set(step, "Card step " + step + " failed (" + error + "). The cards it could not change are shown without it.");
  showCardProblems();
}
function setAppSteps(ids) {
  const key = ids.join(",");
  if (appKey === key) return;
  appKey = key;
  const revision = ++appRevision;
  steps = builtInSteps;
  cardProblems.clear();
  showCardProblems();
  if (!ids.length) return;
  void Promise.all(ids.map(async id => {
    try {
      const { steps } = await import("/apps/" + id + "/web.ts");
      if (!Array.isArray(steps) || steps.some(step => typeof step?.name !== "string"
        || (step.card !== undefined && typeof step.card !== "function")
        || (step.surround !== undefined && typeof step.surround !== "function"))) {
        throw new Error("Expected an array of named card steps");
      }
      return { id, steps: steps.map(step => scopeAppStep(id, step)) };
    } catch (error) { return { id, error }; }
  })).then(results => {
    if (revision !== appRevision) return;
    for (const { id, error } of results) {
      if (error) cardProblems.set(id, "Could not load cards for app " + id + " (" + error + "). Showing the built-in cards instead.");
    }
    showCardProblems();
    steps = [...builtInSteps, ...results.flatMap(result => result.steps || [])];
    render();
  });
}

/** Change the transcript, and keep it scrolled to the bottom if it was there. */
function keepAtBottom(change) {
  const box = $("transcript");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  change();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** Change the transcript above what is shown, and keep what is shown where it is. */
function keepBelow(change) {
  const box = $("transcript");
  const { scrollHeight, scrollTop } = box;
  change();
  box.scrollTop = scrollTop + box.scrollHeight - scrollHeight;
}

/** Run the card pipeline on what the page holds, and make the screen show the result. */
function render(keep = keepAtBottom) {
  const { precards, surround } = derive(
    { branch: app.branch, entries: app.entries, live: app.live }, steps, { pane: app.pane, report: reportStep },
  );
  keep(() => {
    drawCards($("entries"), precards.filter(precard => precard.entry));
    drawCards($("live"), precards.filter(precard => !precard.entry));
    $("older").hidden = app.before === null;
    drawSurround(surround);
  });
  $("abort").disabled = !app.live.run;
  showPane(surround.pane);
  resolveOpenedRun();
}

// A branch switch or replacement snapshot supersedes any pending load for the old transcript.
let transcriptRevision = 0;
function newTranscript() {
  transcriptRevision++;
  $("older").disabled = false;
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
      newTranscript();
    } else if (frame.type === "update") {
      app.entries = app.entries.concat(frame.appended);
    } else {
      return;
    }
    app.live = frame.live || {};
    if (frame.apps) setAppSteps(frame.apps);
    const branch = current();
    if (branch) {
      const wasBusy = branch.busy;
      branch.busy = frame.busy;
      branch.cost = frame.usage.cost;
      if (wasBusy && !frame.busy) refreshBranches();
    }
    render();
    renderBranches();
  });
  socket.addEventListener("close", () => {
    if (app.socket === socket) setTimeout(() => { if (app.socket === socket) connect(id); }, 2000);
  });
}

let branchListRequest = 0;
let branchListApplied = 0;
async function refreshBranches() {
  const request = ++branchListRequest;
  const { branches, totalCost } = await api("/api/branches");
  // A poll started before a branch change can return after the new list.
  if (request < branchListApplied) return;
  branchListApplied = request;
  app.branches = branches;
  app.totalCost = totalCost;
  if (app.branch !== null && !current()) await leaveArchivedBranch();
  else renderBranches();
}

async function selectBranch(id) {
  notice("");
  // Reset even if the next branch has the same app list: its stream supplies the authoritative selection.
  appKey = null;
  setAppSteps([]);
  app.branch = id;
  app.entries = [];
  app.before = null;
  app.live = {};
  app.pane = app.opener = undefined;
  history.replaceState(null, "", "#" + id);
  newTranscript();
  render();
  renderBranches();
  connect(id);
}

async function leaveArchivedBranch() {
  await selectBranch(rootId);
  if ($("input").value.trim()) notice("Branch archived. Your draft was kept; sending it now goes to the root branch.");
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
    await sendMessage(branch, content);
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
$("abort").addEventListener("click", guard(() => act({ type: "abort" })));
$("new").addEventListener("click", guard(async () => {
  const title = prompt("Title for the new branch");
  if (!title) return;
  const created = await api("/api/branches", { method: "POST", body: { title } });
  await refreshBranches();
  await selectBranch(created.id);
}));
$("rename").addEventListener("click", guard(async () => {
  const branch = current();
  const title = prompt("Branch title", branch ? branch.title : "");
  if (!title) return;
  await api("/api/conversations/" + app.branch + "/title", { method: "PUT", body: { title } });
  await refreshBranches();
}));
$("archive").addEventListener("click", guard(async () => {
  const branch = current();
  if (!branch || branch.id === rootId) return;
  const { id, title } = branch;
  if (!confirm("Archive “" + title + "” (#" + id + ")? It will be removed from the sidebar, but its history and forks will be kept.")) return;
  await api("/api/conversations/" + id + "/archive", { method: "POST" });
  if (app.branch === id) await leaveArchivedBranch();
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
    render(keepBelow);
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
  await selectBranch(app.branches.some(branch => branch.id === wanted) ? wanted : rootId);
  setInterval(() => { refreshBranches().catch(() => {}); }, 10000);
})();
`;

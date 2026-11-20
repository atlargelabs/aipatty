/**
 * The crude web page: branch list, transcript, input box, fork, rename, model picker and cost. Served by the API
 * with a strict CSP, so the script is a separate same-origin file and every value is rendered as text.
 */

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
    </section>
    <form id="composer">
      <textarea id="input" rows="3" placeholder="Message" required></textarea>
      <div id="actions">
        <button id="send" type="submit">Send</button>
        <button id="abort" type="button">Abort</button>
      </div>
    </form>
  </main>
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
#composer { display: flex; gap: .5rem; padding: .6rem .8rem; border-top: 1px solid #ddd; background: #fff; }
#composer textarea { flex: 1; font: inherit; padding: .4rem; resize: vertical; }
#actions { display: flex; flex-direction: column; gap: .4rem; }
button { font: inherit; padding: .3rem .7rem; }
@media (max-width: 700px) {
  #menu { display: inline-block; }
  nav { position: fixed; top: 2.8rem; left: 0; bottom: 0; z-index: 2; display: none; box-shadow: 2px 0 8px #0003; }
  nav.open { display: block; }
}
`;

export const pageJs = `"use strict";
const $ = id => document.getElementById(id);
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
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

/** Visible text of a message: text blocks, and tool calls as one line each. */
function messageText(message) {
  if (typeof message.content === "string") return message.content;
  return (message.content || []).map(block => {
    if (block.type === "text") return block.text;
    if (block.type === "toolCall") return "→ " + block.name + " " + JSON.stringify(block.arguments);
    if (block.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\\n");
}

function current() { return app.branches.find(branch => branch.id === app.branch); }

function renderBranches() {
  const list = $("branch-list");
  list.replaceChildren(...app.branches.map(branch => {
    const li = document.createElement("li");
    if (branch.id === app.branch) li.className = "current";
    const title = document.createElement("div");
    title.textContent = branch.title;
    const meta = document.createElement("div");
    meta.className = "meta";
    const model = branch.model ? branch.model.modelId : "no model";
    meta.textContent = "#" + branch.id + " · " + model + " · " + money(branch.cost);
    if (branch.busy) {
      const busy = document.createElement("span");
      busy.className = "busy";
      busy.textContent = " · busy";
      meta.append(busy);
    }
    li.append(title, meta);
    li.addEventListener("click", () => { select(branch.id); $("branches").classList.remove("open"); });
    return li;
  }));
  const branch = current();
  if (!branch) return;
  $("title").textContent = branch.title;
  document.title = branch.title + " · aipatty";
  $("cost").textContent = money(branch.cost) + " / " + money(app.totalCost);
  const ref = branch.model ? branch.model.provider + "/" + branch.model.modelId : "";
  const select = $("model");
  if (![...select.options].some(option => option.value === ref)) {
    const option = document.createElement("option");
    option.value = ref;
    option.textContent = (branch.model ? branch.model.modelId : "(none)") + " (unavailable)";
    select.prepend(option);
  }
  select.value = ref;
  $("thinking").value = branch.thinking;
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
  div.append(fork, role, document.createTextNode(messageText(message)));
  return div;
}

function renderEntries() {
  const box = $("transcript");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const nodes = [];
  for (const entry of app.entries) {
    for (const message of entry.model || []) {
      if (messageText(message)) nodes.push(entryNode(entry, message));
    }
  }
  $("entries").replaceChildren(...nodes);
  $("older").hidden = app.before === null;
  renderLive();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderLive() {
  $("abort").disabled = !app.live.run;
  const live = $("live");
  const message = app.live.generation && app.live.generation.message;
  if (!message || !messageText(message)) { live.replaceChildren(); return; }
  const div = document.createElement("div");
  div.className = "entry assistant";
  div.textContent = messageText(message);
  live.replaceChildren(div);
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
    renderEntries();
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

async function select(id) {
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
  await select(created.id);
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

$("composer").addEventListener("submit", guard(async event => {
  event.preventDefault();
  const content = $("input").value;
  if (!content.trim()) return;
  await api("/api/conversations/" + app.branch + "/messages", {
    method: "POST", body: { content, requestId: crypto.randomUUID(), whenBusy: "followUp" },
  });
  $("input").value = "";
}));
$("input").addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) $("composer").requestSubmit();
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
  if (app.before === null) return;
  const page = await api("/api/conversations/" + app.branch + "?before=" + app.before);
  app.entries = page.entries.concat(app.entries);
  app.before = page.before;
  const box = $("transcript");
  const height = box.scrollHeight;
  renderEntries();
  box.scrollTop += box.scrollHeight - height;
}));
$("menu").addEventListener("click", () => $("branches").classList.toggle("open"));

guard(async () => {
  await loadModels();
  await refreshBranches();
  const wanted = Number(location.hash.slice(1));
  await select(app.branches.some(branch => branch.id === wanted) ? wanted : app.branches[0].id);
  setInterval(() => { refreshBranches().catch(() => {}); }, 10000);
})();
`;

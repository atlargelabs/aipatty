import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LiveDoc, type Tx } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { startApi } from "../src/api.ts";
import { openHost, type AgentHost } from "../src/host.ts";
import { piRunApiPath, upgradeEntryKind, type PiRunSnapshot } from "../src/protocol.ts";
import { archivedPiRun, checkout, fauxConfig, fixture, realConfig, until } from "./helpers.ts";

const health = { ok: true as const, commit: "test", startedAt: "now", version: "0" };

/** A Chrome or Chromium binary: `CHROME_PATH`, or the usual macOS and Linux locations. */
function findChrome(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find(path => path && existsSync(path));
}

const chrome = findChrome();

/** One headless Chrome page driven over the DevTools protocol, without a browser library. */
async function openBrowser(t: TestContext, flags: string[] = []) {
  // Chrome's own directory, removed only after Chrome has exited: it writes to its profile until then.
  const profile = await mkdtemp(join(checkout, "node_modules", "aipatty-test-chrome-"));
  const child = spawn(chrome!, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", ...flags, "about:blank",
  ], { stdio: "ignore" });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
    // Chrome's helper processes can outlive it for a moment.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Chrome writes the port it chose to this file once DevTools listens.
  const portFile = join(profile, "DevToolsActivePort");
  // The first launch on a cold machine, such as a CI runner, can take longer than the default wait.
  const port = await until(async () => (await readFile(portFile, "utf8").catch(() => "")).split("\n")[0], Boolean, 40_000);
  const target = await until<{ type: string; webSocketDebuggerUrl: string } | undefined>(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    return targets.find(candidate => candidate.type === "page");
  });

  const socket = new WebSocket(target!.webSocketDebuggerUrl);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const errors: string[] = [];
  const loaded = new Set<string>();
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    } else if (message.method === "Page.lifecycleEvent" && message.params.name === "load") {
      loaded.add(message.params.loaderId);
    } else if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      errors.push(details.exception?.description ?? details.text);
    } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      errors.push(message.params.args.map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description).join(" "));
    }
  };
  const send = (method: string, params: object = {}) => new Promise<unknown>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }) as {
      result: { value: T }; exceptionDetails?: { text: string };
    };
    if (result.exceptionDetails) throw new Error(`In the page: ${result.exceptionDetails.text}`);
    return result.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.setLifecycleEventsEnabled", { enabled: true });
  return {
    errors,
    evaluate,
    async navigate(url: string) {
      const { loaderId, errorText } = await send("Page.navigate", { url }) as { loaderId?: string; errorText?: string };
      if (errorText) throw new Error(`Could not navigate to ${url}: ${errorText}`);
      // The command can return before the new document is ready. A same-document navigation has no new loader.
      if (loaderId) await until(() => loaded.has(loaderId));
    },
    viewport: (width: number, height: number) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }),
    emulateTouch: () => send("Emulation.setTouchEmulationEnabled", { enabled: true }),
    async key(key: "Enter" | "Escape", modifiers = 0) {
      const params = { key, code: key, windowsVirtualKeyCode: key === "Enter" ? 13 : 27, modifiers };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...(key === "Enter" && { text: "\r" }) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    },
    /** Press or release the left mouse button at a point of the page, as a person's click does in two steps. */
    mouse: (type: "mousePressed" | "mouseReleased", x: number, y: number) =>
      send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }),
  };
}

/** What the page shows: the header title, the highlighted branch, the URL fragment and the visible messages. */
interface Shown { title: string; current: string | null; hash: string; messages: string[] }
const shown = `({
  title: document.getElementById("title").textContent,
  current: document.querySelector("#branch-list li.current div")?.textContent ?? null,
  hash: location.hash,
  messages: [...document.querySelectorAll("#entries .entry")].map(entry => entry.lastChild.textContent),
})`;

/** Wait until the page shows `done`; on timeout, fail with what it showed and any script errors. */
async function waitFor(browser: Awaited<ReturnType<typeof openBrowser>>, what: string, done: (value: Shown) => boolean): Promise<Shown> {
  let last: Shown | undefined;
  try {
    return await until(async () => (last = await browser.evaluate<Shown>(shown)), done);
  } catch (error) {
    throw new Error(`The page never showed ${what}. It showed ${JSON.stringify(last)}; script errors: ${JSON.stringify(browser.errors)}`, { cause: error });
  }
}

async function say(host: AgentHost, id: string, content: string): Promise<void> {
  const conversation = (await host.conversation(id))!;
  assert.equal((await (await host.submit(conversation, { type: "input", content })).wait(ctx)).status, "done");
}

test("clicking a branch in the page's list switches to it, and back", { skip: chrome ? false : "no Chrome found; set CHROME_PATH", timeout: 60_000 }, async t => {
  const dir = await fixture(t);
  const host = await openHost(fauxConfig(dir));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.harness.close(ctx); });
  const base = `http://127.0.0.1:${api.port}`;

  await say(host, "root", "on main");
  const side = await host.fork((await host.conversation("root"))!, { title: "Side" });
  await say(host, String(side.id), "only on side");

  const browser = await openBrowser(t);
  await browser.navigate(`${base}/`);
  const main = await waitFor(browser, "the main branch", value => value.messages.length === 2);
  assert.deepEqual(main, { title: "Main", current: "Main", hash: "#1", messages: ["on main", "Faux reply: on main"] });

  const clickBranch = (title: string) => browser.evaluate(`[...document.querySelectorAll("#branch-list li")]
    .find(li => li.querySelector("div").textContent === ${JSON.stringify(title)}).click()`);
  await clickBranch("Side");
  const onSide = await waitFor(browser, "the side branch after clicking it", value => value.messages.length === 4);
  assert.deepEqual(onSide, {
    title: "Side", current: "Side", hash: `#${side.id}`,
    messages: ["on main", "Faux reply: on main", "only on side", "Faux reply: only on side"],
  });

  await clickBranch("Main");
  const back = await waitFor(browser, "the main branch after clicking it", value => value.title === "Main" && value.messages.length === 2);
  assert.deepEqual(back.messages, ["on main", "Faux reply: on main"]);

  // Opening the page with a branch's fragment shows that branch. A fragment-only change would not reload the page.
  await browser.navigate("about:blank");
  await browser.navigate(`${base}/#${side.id}`);
  await waitFor(browser, "the branch named in the fragment", value => value.title === "Side" && value.messages.length === 4);
  assert.deepEqual(browser.errors, []);
});

test("Pi calls open the exact archive across pages and forks, without rebuilding the chat", { skip: !chrome, timeout: 60_000 }, async t => {
  const dir = await fixture(t);
  const host = await openHost(fauxConfig(dir));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });
  const root = (await host.conversation("root"))!;
  const first = "20260101T010101-aaaaaaaa", second = "20260101T020202-bbbbbbbb", missing = "20260101T030303-cccccccc";
  const duplicate = "20260101T040404-dddddddd";
  const markup = '<img src="x" onerror="window.bad = true">';
  const firstArchive = await archivedPiRun(dir, first, { summary: "First archive " + markup }, JSON.stringify({
    type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Visible activity" }] },
  }) + "\n");
  await writeFile(join(firstArchive, "stderr.log"), "x".repeat(15_000) + "recent diagnostic");
  await archivedPiRun(dir, second, { summary: "Second archive", status: "failed", durationMs: 65_000 });
  await archivedPiRun(dir, duplicate, { summary: "Duplicate-ID archive" });
  const call = (task: string, id: string) => fauxToolCall("pi", { task }, { id });
  const exchange = (tx: Tx, toolName: string, toolCallId: string, text: string, runId?: string) =>
    tx.appendEntry(root.id, { kind: "test", model: [{
      role: "toolResult", toolName, toolCallId, content: [{ type: "text", text }], timestamp: 0,
      isError: runId === undefined && toolName === "pi", ...(runId && { details: { runId }, durationMs: 2_500 }),
    }] });
  const forkAt = await root.commit(async tx => {
    await tx.appendEntry(root.id, { kind: "test", model: [{ role: "user", content: `→ pi {"runId":"${second}"}`, timestamp: 0 }] });
    await tx.appendEntry(root.id, { kind: "test", model: [fauxAssistantMessage([
      { type: "text", text: 'Pasted → pi {} stays plain' },
      call("First task\nDo not show the rest of the task", "first"), call("Second task", "second"),
      fauxToolCall("bash", { command: "echo fixture" }, { id: "shell" }),
    ], { stopReason: "toolUse" })] });
    // Parallel results can arrive in a different order than the calls.
    await exchange(tx, "pi", "second", "second result", second);
    await exchange(tx, "pi", "first", "first result", first);
    return (await exchange(tx, "bash", "shell", "fixture")).id;
  }, ctx);
  const side = await host.fork(root, { title: "Forked history", at: forkAt });
  await root.commit(async tx => {
    await tx.appendEntry(root.id, { kind: "test", model: [fauxAssistantMessage([call("Missing archive", "missing"), call("Refused", "first")], { stopReason: "toolUse" })] });
    await exchange(tx, "pi", "missing", "old result", missing);
    await exchange(tx, "pi", "first", `Pi run ${first} is still active on branch 1. Wait for it, or abort this branch.`);
    await tx.appendEntry(root.id, { kind: "test", model: [fauxAssistantMessage([call("Unfinished task", "never")], { stopReason: "aborted" })] });
    await tx.appendEntry(root.id, { kind: "test", model: [fauxAssistantMessage([call("Ambiguous A", "duplicate"), call("Ambiguous B", "duplicate")], { stopReason: "toolUse" })] });
    await exchange(tx, "pi", "duplicate", "Refused duplicate");
    await exchange(tx, "pi", "duplicate", "duplicate result", duplicate);
    for (let i = 0; i < 41; i++) await tx.appendEntry(root.id, { kind: "test", model: [{ role: "user", content: `filler ${i}`, timestamp: 0 }] });
  }, ctx);

  const browser = await openBrowser(t);
  await browser.viewport(1250, 850);
  const base = `http://127.0.0.1:${api.port}`;
  const html = await fetch(base);
  assert.equal(html.headers.get("content-security-policy"), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  await browser.navigate(base);
  await waitFor(browser, "50 newest entries", state => state.messages.length === 50);
  const click = async (label: string) => browser.evaluate(`(() => {
    const button = [...document.querySelectorAll('.assistant .pi-call')].find(button => button.textContent.includes(${JSON.stringify(label)}));
    button.click();
  })()`);
  const paneText = () => browser.evaluate<string>(`document.querySelector('#pi-run-view').textContent`);
  const shows = async (text: string) => {
    try { return await until(paneText, value => value.includes(text)); }
    catch { assert.fail(`Expected ${text} in the pane; found ${await paneText()}; errors: ${browser.errors.join(", ")}`); }
  };
  // The first result has its own control even though its call isn't on this page yet.
  assert.equal(await browser.evaluate(`document.querySelectorAll('.toolResult .pi-call').length`), 3);
  await browser.evaluate(`document.querySelector('.toolResult .pi-call').click()`);
  await shows("First archive");
  await browser.evaluate(`document.querySelector('#pi-run-close').click(); window.kept = document.querySelector('#entries .entry'); document.querySelector('#older').click()`);
  await until(() => browser.evaluate(`document.querySelector('#older').hidden`));
  assert.equal(await browser.evaluate("window.kept.isConnected"), true);
  assert.equal(await browser.evaluate(`document.querySelectorAll('.assistant .pi-call').length`), 4);
  assert.equal(await browser.evaluate(`document.querySelectorAll('.user .pi-call').length`), 0);
  assert.equal(await browser.evaluate(`document.querySelector('#entries').textContent.includes('→ bash {"command":"echo fixture"}')`), true);
  assert.equal(await browser.evaluate(`document.querySelector('#entries').textContent.includes('Do not show the rest of the task')`), false);

  // This desktop width wraps the controls when the side pane narrows the transcript.
  await browser.viewport(905, 850);
  const chatOffset = `document.querySelector('#entries .entry').getBoundingClientRect().top - document.querySelector('#transcript').getBoundingClientRect().top`;
  await browser.evaluate(`
    document.querySelector('#transcript').scrollTop = 0;
    window.entryOffset = ${chatOffset};
    window.openerButton = document.querySelector('.assistant .pi-call');
    window.openerButton.focus({ preventScroll: true });
  `);
  await browser.key("Enter");
  const content = await shows("First archive");
  assert.match(content, /completed · 0m 2s/);
  assert.ok(content.includes(markup) && content.includes("Visible activity"));
  assert.match(content.trimEnd(), /Pi stderr\[Earlier stderr omitted\][^]*recent diagnostic$/);
  assert.equal(await browser.evaluate(`(() => {
    const view = document.querySelector('#pi-run-view');
    return view.scrollTop > 0 && view.scrollHeight - view.clientHeight - view.scrollTop < 2;
  })()`), true);
  assert.equal(await browser.evaluate(`(${chatOffset}) === window.entryOffset`), true);
  assert.equal(await browser.evaluate(`!!document.querySelector('#pi-run img') || !!window.bad`), false);
  assert.equal(await browser.evaluate(`document.querySelector('main').getBoundingClientRect().right <= document.querySelector('#pi-run').getBoundingClientRect().left`), true);
  await browser.key("Escape");
  assert.equal(await browser.evaluate(`document.querySelector('#pi-run').hidden && document.activeElement === window.openerButton`), true);
  await click("Second task");
  const failed = await shows("Second archive");
  assert.match(failed, /failed · 1m 5s/);
  assert.match(failed, /No activity log available/);
  await click("Missing archive");
  await shows("archive unavailable");
  await click("Refused");
  await shows("did not start a Pi run");
  // A partial aborted message and ambiguous calls aren't controls; the real result still opens its own run.
  assert.equal(await browser.evaluate(`document.querySelector('#entries').textContent.includes('Unfinished task')`), true);
  await browser.evaluate(`[...document.querySelectorAll('.toolResult')].find(entry => entry.textContent.includes('duplicate result')).querySelector('.pi-call').click()`);
  await shows("Duplicate-ID archive");

  // A branch change closes the pane. A reload of the fork reads the original exchange, not the later reused ID.
  await browser.evaluate(`document.querySelector('[data-branch="${side.id}"]').click()`);
  await waitFor(browser, "the fork", state => state.current === "Forked history" && state.messages.length === 5);
  assert.equal(await browser.evaluate(`document.querySelector('#pi-run').hidden`), true);
  await browser.navigate("about:blank");
  await browser.navigate(base + "/#" + side.id);
  await waitFor(browser, "reloaded fork", state => state.current === "Forked history" && state.messages.length === 5);
  await browser.viewport(390, 480);
  await browser.evaluate(`document.querySelector('#transcript').scrollTop = 85; window.chatTop = document.querySelector('#transcript').scrollTop`);
  await click("First task");
  await shows("First archive");
  assert.equal(await browser.evaluate(`document.querySelector('main').inert && document.querySelector('#pi-run').getBoundingClientRect().width === 390`), true);
  await browser.evaluate(`document.querySelector('#pi-run-close').click()`);
  assert.equal(await browser.evaluate(`!document.querySelector('main').inert && document.querySelector('#transcript').scrollTop === window.chatTop`), true);
  assert.deepEqual(browser.errors, []);
});

test("the Pi run pane follows snapshots, freezes while reading, and stops watching", { skip: !chrome, timeout: 60_000 }, async t => {
  const host = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });
  const root = (await host.conversation("root"))!;
  const first = "20260102T010101-aaaaaaaa", second = "20260102T020202-bbbbbbbb";
  await root.commit(async tx => {
    await tx.appendEntry(root.id, { kind: "test", model: [{
      role: "toolResult", toolName: "pi", toolCallId: "old", content: [{ type: "text", text: "Old result" }],
      timestamp: 0, isError: false, details: { runId: second },
    }] });
    await tx.appendEntry(root.id, { kind: "test", model: [fauxAssistantMessage([
      fauxToolCall("pi", { task: "Current task" }, { id: "current" }),
    ], { stopReason: "toolUse" })] });
    (await tx.doc(LiveDoc, root.id)).tools = [{ name: "pi", callId: "current", status: "pending" }];
  }, ctx);

  const browser = await openBrowser(t);
  await browser.viewport(1100, 600);
  await browser.navigate(`http://127.0.0.1:${api.port}/`);
  await waitFor(browser, "the current Pi call", state => state.messages.length === 2);
  // Keep real browser timers and the conversation WS. Control only the snapshot responses, including allowing
  // a cancelled request to finish late so the stale-pane guard is exercised independently of fetch's abort.
  await browser.evaluate(`(() => {
    const fetch = window.fetch;
    window.runRequests = [];
    window.fetch = (path, init) => path.startsWith(${JSON.stringify(piRunApiPath)})
      ? new Promise(reply => window.runRequests.push({ path, signal: init.signal, reply }))
      : fetch(path, init);
  })()`);
  const requests = () => browser.evaluate<string[]>("window.runRequests.map(request => request.path)");
  let count = 0;
  const next = async (id = first) => {
    const seen = await until(requests, paths => paths.length > count);
    assert.equal(seen[count++], piRunApiPath + id);
    assert.equal(seen.length, count);
  };
  const reply = (body: PiRunSnapshot | { error: string }, status = 200, index = count - 1) =>
    browser.evaluate(`window.runRequests[${index}].reply(Response.json(${JSON.stringify(body)}, { status: ${status} }))`);
  const snapshot = (labels: string[], { runId = first, status = "running", truncated = false }: {
    runId?: string; status?: PiRunSnapshot["status"]; truncated?: boolean;
  } = {}): PiRunSnapshot => ({
    runId, status, activity: { truncated, incomplete: false, items: labels.map(label => ({
      kind: "text", output: { text: Array.from({ length: 40 }, (_, i) => `${label} ${i}`).join("\n"), truncated: false },
    })) },
  });
  const pane = () => browser.evaluate<{ text: string; top: number; bottom: boolean; jump: boolean }>(`(() => {
    const view = document.querySelector('#pi-run-view');
    return { text: view.textContent, top: view.scrollTop,
      bottom: view.scrollHeight - view.clientHeight - view.scrollTop < 2,
      jump: !document.querySelector('#pi-run-jump').hidden };
  })()`);
  const atLatest = (text: string) => until(pane, value => value.text.includes(text) && value.top > 0 && value.bottom && !value.jump);
  const click = (selector: string) => browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const pause = async () => {
    await browser.evaluate(`document.querySelector('#pi-run-view').scrollTop = 95`);
    return until(pane, value => value.top === 95 && value.jump);
  };

  await click(".assistant .pi-call");
  assert.match((await pane()).text, /Waiting for this call/);
  assert.deepEqual(await requests(), []);
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('#pi-run button')].some(button => button.textContent === 'Refresh')`), false);
  await root.commit(async tx => {
    (await tx.doc(LiveDoc, root.id)).tools = [{ name: "pi", callId: "current", status: "running", details: { runId: first } }];
  }, ctx);
  await next();
  const initialSnapshot = snapshot(["first output"]);
  await reply({ ...initialSnapshot, durationMs: 1000 });
  const initial = await atLatest("first output 39");
  await browser.viewport(1100, 470);
  assert.ok((await atLatest("first output 39")).top > initial.top);
  await browser.evaluate(`window.logBeforeTick = document.querySelector('#pi-run-data pre');
    window.statusBeforeTick = document.querySelector('#pi-run-message').firstChild`);
  await next();
  await reply({ ...initialSnapshot, durationMs: 2500 });
  await atLatest("running · 0m 2s");
  assert.equal(await browser.evaluate("window.logBeforeTick.isConnected && window.statusBeforeTick.isConnected"), true);
  await next();
  await reply(snapshot(["first output", "appended output"]));
  await atLatest("appended output 39");

  const reading = await pause();
  await browser.evaluate(`window.reading = document.querySelector('#pi-run-data pre')`);
  await next();
  await reply(snapshot(["superseded tail"], { truncated: true }));
  await next();
  await reply({ error: "Temporary failure" }, 503);
  await next();
  await reply(snapshot(["latest tail"], { truncated: true }));
  await next();
  assert.deepEqual(await pane(), reading);
  assert.equal(await browser.evaluate("window.reading.isConnected"), true);
  await browser.evaluate(`{
    const view = document.querySelector('#pi-run-view');
    view.scrollTop = view.scrollHeight - view.clientHeight - 2;
  }`);
  const resumed = await atLatest("latest tail 39");
  assert.doesNotMatch(resumed.text, /superseded tail|first output/);
  assert.match(resumed.text, /Activity truncated/);

  const beforeCompletion = await pause();
  // A slow request must not trigger a second one while still in flight.
  await sleep(1800);
  assert.equal((await requests()).length, count);
  await reply(snapshot(["final tail"], { status: "completed" }));
  await sleep(1800);
  assert.equal((await requests()).length, count);
  assert.deepEqual(await pane(), beforeCompletion);
  await browser.evaluate(`document.querySelector('#pi-run-jump').focus()`);
  await browser.key("Enter");
  assert.match((await atLatest("final tail 39")).text, /completed/);
  assert.equal(await browser.evaluate(`document.activeElement.id`), "pi-run-view");

  const stale = count;
  await click(".assistant .pi-call");
  await next();
  await click(".toolResult .pi-call");
  await next(second);
  assert.equal(await browser.evaluate(`window.runRequests[${stale}].signal.aborted`), true);
  await reply(snapshot(["other run"], { runId: second, status: "completed" }));
  const other = await atLatest("other run 39");
  await reply(snapshot(["stale response"]), 200, stale);
  await sleep(1800);
  assert.deepEqual(await pane(), other);
  assert.equal((await requests()).length, count);

  await click(".assistant .pi-call");
  await next();
  await reply(snapshot(["reopened"]));
  await atLatest("reopened 39");
  await click("#pi-run-close");
  await sleep(1800);
  assert.equal((await requests()).length, count);
  assert.equal(await browser.evaluate(`document.querySelector('#pi-run').hidden`), true);
  assert.deepEqual(browser.errors, []);
});

test("an upgrade's report appears in the open transcript", { skip: !chrome, timeout: 60_000 }, async t => {
  const host = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.harness.close(ctx); });
  await say(host, "root", "on main");
  const browser = await openBrowser(t);
  await browser.navigate(`http://127.0.0.1:${api.port}/`);
  await waitFor(browser, "the main branch", value => value.messages.length === 2);

  const root = (await host.conversation("root"))!;
  await root.commit(tx => tx.appendEntry(root.id, { kind: upgradeEntryKind, data: { text: "Upgrade complete." } }), ctx);
  const after = await waitFor(browser, "the upgrade report", value => value.messages.length === 3);
  assert.deepEqual(after.messages, ["on main", "Faux reply: on main", "Upgrade complete."]);
  assert.deepEqual(browser.errors, []);
});

test("composer Enter starts a new line on touch-first input and sends on desktop", { skip: !chrome, timeout: 60_000 }, async t => {
  const host = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });
  const browser = await openBrowser(t);
  await browser.navigate(`http://127.0.0.1:${api.port}/`);
  await waitFor(browser, "the main branch", state => state.current === "Main");

  const input = `document.getElementById('input')`;
  const touchFirst = `matchMedia('(hover: none) and (pointer: coarse)').matches`;
  assert.equal(await browser.evaluate(touchFirst), false);
  await browser.evaluate(`${input}.focus(); ${input}.value = 'first';`);
  await browser.key("Enter", 8); // DevTools uses bit 8 for Shift.
  assert.equal(await browser.evaluate(`${input}.value`), "first\n");

  // Synthetic keydowns exercise modifier and IME flags without changing the draft.
  for (const [init, prevented, submitted] of [
    [{ shiftKey: true, ctrlKey: true, metaKey: true }, false, false],
    [{ altKey: true }, false, false],
    [{ isComposing: true }, false, false],
    [{ keyCode: 229 }, false, false],
    [{ repeat: true }, true, false],
    [{ ctrlKey: true }, true, true],
    [{ metaKey: true }, true, true],
  ]) {
    const result = await browser.evaluate(`(() => {
      const input = ${input};
      const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...${JSON.stringify(init)} });
      let submitted = false;
      input.form.requestSubmit = () => { submitted = true; };
      try { input.dispatchEvent(event); } finally { delete input.form.requestSubmit; }
      return [event.defaultPrevented, submitted];
    })()`);
    assert.deepEqual(result, [prevented, submitted], JSON.stringify(init));
  }

  await browser.evaluate(`${input}.value += 'second';`);
  await browser.key("Enter");
  const after = await waitFor(browser, "the sent multiline draft", state => state.messages.length === 2);
  assert.equal(after.messages[0], "first\nsecond");

  // Change the primary input without reloading or resizing the page.
  await browser.emulateTouch();
  assert.equal(await browser.evaluate(touchFirst), true);
  const draftCleared = () => until(() => browser.evaluate(`${input}.value === ''`));
  await draftCleared();
  await browser.evaluate(`
    window.submitEvents = 0;
    ${input}.form.addEventListener('submit', () => { window.submitEvents++; });
    ${input}.value = 'touch first';
    ${input}.focus();
  `);
  await browser.key("Enter");
  assert.deepEqual(await browser.evaluate(`[${input}.value, window.submitEvents]`), ["touch first\n", 0]);
  await browser.evaluate(`${input}.value += 'touch second'; document.getElementById('send').click()`);
  const clicked = await waitFor(browser, "the multiline draft sent by the button", state => state.messages.length === 4);
  assert.equal(clicked.messages[2], "touch first\ntouch second");

  let count = 4;
  for (const [modifier, name] of [[2, "Ctrl"], [4, "Cmd"]] as const) { // DevTools bits for Ctrl and Meta.
    await draftCleared();
    await browser.evaluate(`${input}.value = '${name} shortcut'; ${input}.focus()`);
    await browser.key("Enter", modifier);
    count += 2;
    const sent = await waitFor(browser, `the draft sent by ${name}+Enter`, state => state.messages.length === count);
    assert.equal(sent.messages[count - 2], `${name} shortcut`);
  }
  assert.deepEqual(browser.errors, []);
});

test("Send by the name localhost admits once, preserves a new draft, and shows a failed run", { skip: !chrome, timeout: 60_000 }, async t => {
  const host = await openHost(realConfig(await fixture(t)));
  await host.setModel({ provider: "openai", modelId: "gpt-6.1-sol" }); // available model, no login in this fixture
  const gate = Promise.withResolvers<void>();
  const requestIds: (string | undefined)[] = [];
  const api = await startApi({ ...host, async submit(branch, draft, context) {
    requestIds.push(draft.requestId);
    await gate.promise;
    return host.submit(branch, draft, context);
  } }, health, 0);
  t.after(async () => { gate.resolve(); await api.close(); await host.harness.close(ctx); });
  const browser = await openBrowser(t);
  await browser.navigate(`http://localhost:${api.port}/`);
  await waitFor(browser, "the main branch", state => state.current === "Main");
  await browser.evaluate(`
    document.querySelector('#input').value = 'first';
    document.querySelector('#composer').requestSubmit();
    document.querySelector('#composer').requestSubmit();
    document.querySelector('#input').value = 'new draft';
    document.querySelector('#input').dispatchEvent(new Event('input'));
  `);
  await until(() => requestIds.length > 0);
  assert.equal(await browser.evaluate("document.querySelector('#send').disabled"), true);
  gate.resolve();
  await until(() => browser.evaluate("!document.querySelector('#send').disabled && !document.querySelector('#run-failure').hidden"));
  assert.match(await browser.evaluate<string>("document.querySelector('#run-failure').textContent"), /model_error: Provider is not configured: openai/);
  assert.equal(requestIds.length, 1);
  assert.ok(requestIds[0]);
  assert.equal(await browser.evaluate("document.querySelector('#input').value"), "new draft");
  assert.deepEqual(browser.errors, []);
});

test("an older page is requested once and cannot overwrite a different branch", { skip: !chrome, timeout: 60_000 }, async t => {
  const host = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.harness.close(ctx); });
  const root = (await host.conversation("root"))!;
  const side = await host.fork(root, { title: "Side" });
  await say(host, String(side.id), "only on side");
  await root.commit(async tx => {
    for (let i = 0; i < 51; i++) await tx.appendEntry(root.id, {
      kind: "test", model: [{ role: "user", content: `main ${i}`, timestamp: i }],
    });
  }, ctx);
  const browser = await openBrowser(t);
  await browser.navigate(`http://127.0.0.1:${api.port}/`);
  await waitFor(browser, "50 newest entries", state => state.messages.length === 50);
  // Hold the already-read HTTP page until after the other branch's WebSocket snapshot arrives.
  await browser.evaluate(`
    window.olderRequests = 0;
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      if (!String(args[0]).includes('?before=')) return originalFetch(...args);
      window.olderRequests++;
      const page = await (await originalFetch(...args)).json();
      await new Promise(resolve => { window.releasePage = resolve; });
      return { ok: true, json: async () => page };
    };
    document.querySelector('#older').click(); document.querySelector('#older').click();
  `);
  await until(() => browser.evaluate("typeof window.releasePage === 'function'"));
  assert.equal(await browser.evaluate("window.olderRequests"), 1);
  await browser.evaluate(`document.querySelector('li[data-branch="${side.id}"]').click()`);
  await waitFor(browser, "the side branch", state => state.current === "Side" && state.messages.length === 2);
  await browser.evaluate("window.releasePage(); new Promise(resolve => setTimeout(resolve, 0))");
  const state = await browser.evaluate<Shown>(shown);
  assert.deepEqual(state.messages, ["only on side", "Faux reply: only on side"]);
  assert.equal(await browser.evaluate("document.querySelector('#older').hidden"), true);
  assert.deepEqual(browser.errors, []);
});

test("a click on another branch lands while the current branch is streaming", { skip: chrome ? false : "no Chrome found; set CHROME_PATH", timeout: 60_000 }, async t => {
  const host = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.harness.close(ctx); });
  const root = (await host.conversation("root"))!;
  await say(host, "root", "on main");
  const side = await host.fork(root, { title: "Side" });
  await say(host, String(side.id), "only on side");

  const browser = await openBrowser(t);
  await browser.navigate(`http://127.0.0.1:${api.port}/`);
  await waitFor(browser, "the main branch", value => value.messages.length === 2);

  // A long answer streams for a few seconds, a frame at a time.
  await host.submit(root, { type: "input", content: "x".repeat(1500) });
  const streamed = () => browser.evaluate<number>(`document.querySelector("#live .entry")?.textContent.length ?? 0`);
  await until(streamed, length => length > 0);

  // Press on the other branch, let stream frames arrive, then release: a person's click spans several frames.
  const point = await browser.evaluate<{ x: number; y: number }>(`(() => {
    window.kept = document.querySelector("#entries .entry");
    const box = [...document.querySelectorAll("#branch-list li")]
      .find(li => li.querySelector("div").textContent === "Side").getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  await browser.mouse("mousePressed", point.x, point.y);
  const pressedAt = await streamed();
  await until(streamed, length => length > pressedAt + 30);
  assert.equal(await browser.evaluate("window.kept.isConnected"), true, "a stream frame does not rebuild the transcript");
  await browser.mouse("mouseReleased", point.x, point.y);
  const onSide = await waitFor(browser, "the side branch after a click during streaming", value => value.title === "Side");
  assert.equal(onSide.current, "Side");
  assert.deepEqual(browser.errors, []);
  await host.abort(root);
});

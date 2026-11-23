import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Tx } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { startApi } from "../src/api.ts";
import { openHost, type AgentHost } from "../src/host.ts";
import { upgradeEntryKind } from "../src/protocol.ts";
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
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
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
  return {
    errors,
    evaluate,
    navigate: (url: string) => send("Page.navigate", { url }),
    viewport: (width: number, height: number) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }),
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
  } catch {
    assert.fail(`The page never showed ${what}. It showed ${JSON.stringify(last)}; script errors: ${JSON.stringify(browser.errors)}`);
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

test("Enter sends a draft and Shift+Enter inserts a newline in the composer", { skip: !chrome, timeout: 60_000 }, async t => {
  const host = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });
  const browser = await openBrowser(t);
  await browser.navigate(`http://127.0.0.1:${api.port}/`);
  await waitFor(browser, "the main branch", state => state.current === "Main");

  const input = `document.getElementById('input')`;
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

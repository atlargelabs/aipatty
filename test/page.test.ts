import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type JsonObject } from "@earendil-works/pi-ai";
import { LiveDoc, type Tx } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { startApi } from "../src/api.ts";
import { openHost, type AgentHost } from "../src/host.ts";
import { pagePath, pagesLibraryApi, pagesPath, publishPageTool } from "../src/pages/shared.ts";
import { piRunApiPath, upgradeEntryKind, type PiRunSnapshot } from "../src/protocol.ts";
import { fixtureApp } from "./fixtures/app.ts";
import { fauxPages, pagesBrowserFixture } from "./fixtures/pages.ts";
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
  const requested: string[] = [];
  const loaded = new Set<string>();
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    } else if (message.method === "Network.requestWillBeSent") {
      requested.push(message.params.request.url);
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
    async watchRequests() { await send("Network.enable"); return requested; },
    async onNewDocument(source: string) {
      const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source }) as { identifier: string };
      return () => send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    },
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
  messages: [...document.querySelectorAll("#entries .card-body")].map(body => body.innerText),
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

test("toolbar New starts blank, Fork here keeps history, and Archive works while busy", { skip: !chrome, timeout: 60_000 }, async t => {
  const faux = fauxProvider();
  const gate = Promise.withResolvers<void>();
  faux.setResponses([fauxAssistantMessage("original answer"), async () => {
    await gate.promise;
    return fauxAssistantMessage("finished while archived");
  }]);
  const models = createModels();
  models.setProvider(faux.provider);
  const host = await openHost(fauxConfig(await fixture(t)), { models });
  const api = await startApi(host, health, 0);
  t.after(async () => { gate.resolve(); await api.close(); await host.close(); });
  const base = `http://127.0.0.1:${api.port}`;
  const root = (await host.conversation("root"))!;
  await host.rename(root, "Home");
  await say(host, "root", "original message");

  const browser = await openBrowser(t);
  await browser.navigate(base);
  const home = await waitFor(browser, "the renamed root", state => state.title === "Home" && state.messages.length === 2);
  assert.equal(await browser.evaluate(`document.querySelector('#archive').hidden`), true);
  assert.ok(!(await browser.evaluate<string[]>(`[...document.querySelectorAll('#controls button')].map(b => b.textContent)`)).includes("Fork"));
  assert.equal(await browser.evaluate(`document.querySelector('#new').textContent`), "New");
  const forkHere = `document.querySelector('#entries .assistant button[data-action=fork]')`;
  assert.equal(await browser.evaluate(`${forkHere}.textContent`), "Fork here");
  await browser.evaluate(`window.prompt = () => 'Main'; ${forkHere}.click()`);
  const side = await waitFor(browser, "the fork with inherited messages", state => state.current === "Main" && state.messages.length === 2);
  assert.deepEqual(side.messages, home.messages);
  const id = side.hash.slice(1);
  const branch = (await host.conversation(id))!;
  const active = await host.submit(branch, { type: "input", content: "keep working" });
  await until(() => browser.evaluate(`!document.querySelector('#abort').disabled`));

  await browser.evaluate(`window.prompt = () => 'Fresh'; document.querySelector('#new').click()`);
  const fresh = await waitFor(browser, "a blank branch", state => state.current === "Fresh" && state.messages.length === 0);
  const item = `document.querySelector('li[data-branch="${id}"]')`;
  await browser.evaluate(`${item}.click()`);
  await until(() => browser.evaluate(`!document.querySelector('#abort').disabled && location.hash === '#${id}'`));
  assert.equal(await browser.evaluate(`document.querySelector('#archive').matches(':not([hidden]):enabled')`), true);
  const confirmation = await browser.evaluate<string>(`
    window.confirm = text => { window.confirmation = text; return true; };
    document.querySelector('#archive').click(); window.confirmation;
  `);
  assert.ok(confirmation.includes(`“Main” (#${id})`));
  assert.match(confirmation, /removed from the sidebar.*history and forks will be kept/);
  await waitFor(browser, "back on Main", state => state.current === "Home" && state.hash === home.hash && state.messages.length === 2);
  await until(() => browser.evaluate(`!${item}`));
  gate.resolve();
  assert.equal((await active.wait(ctx)).status, "done");

  await browser.navigate("about:blank");
  await browser.navigate(`${base}/${side.hash}`);
  await waitFor(browser, "Main after opening an archived branch URL", state => state.current === "Home" && state.hash === home.hash);
  const freshId = fresh.hash.slice(1);
  await browser.evaluate(`document.querySelector('li[data-branch="${freshId}"]').click()`);
  await waitFor(browser, "Fresh selected again", state => state.hash === fresh.hash);
  await browser.evaluate(`document.querySelector('#input').value = 'unsent draft'`);
  // Archiving in another client also falls back after the page's existing sidebar refresh.
  assert.equal((await fetch(`${base}/api/conversations/${freshId}/archive`, { method: "POST" })).status, 200);
  await until(() => browser.evaluate(`location.hash === '${home.hash}'`), Boolean, 15_000);
  assert.equal(await browser.evaluate(`document.querySelector('#input').value`), "unsent draft");
  assert.match(await browser.evaluate<string>(`document.querySelector('#notice:not([hidden])').textContent`), /draft was kept.*root branch/);
  assert.deepEqual(browser.errors, []);
});

test("Model and Thinking share a toolbar row on phones with a long model ID", { skip: !chrome, timeout: 60_000 }, async t => {
  const host = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });

  const browser = await openBrowser(t);
  await browser.navigate(`http://127.0.0.1:${api.port}`);
  await waitFor(browser, "the main branch", state => state.title === "Main");
  // The short Faux option would fit even with the desktop cap.
  await browser.evaluate(`document.querySelector('#model').add(new Option(
    'an-especially-long-model-identifier-2026-11-26 (faux)', 'faux/long', false, true))`);

  for (const width of [320, 375, 390]) {
    await browser.viewport(width, 600);
    const layouts = await browser.evaluate<[string, boolean][]>(`(() => {
      const model = document.querySelector('#model');
      const thinking = document.querySelector('#thinking');
      model.value = 'faux/long';
      return [...thinking.options].map(({ value }) => {
        thinking.value = value;
        const modelBox = model.getBoundingClientRect();
        const thinkingBox = thinking.getBoundingClientRect();
        const sameRow = modelBox.right < thinkingBox.left && modelBox.top < thinkingBox.bottom && thinkingBox.top < modelBox.bottom;
        return [value, sameRow];
      });
    })()`);
    assert.deepEqual(layouts.map(([level]) => level), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const [level, sameRow] of layouts) assert.ok(sameRow, `Thinking (${level}) should fit beside Model at ${width}px`);
  }

  await browser.viewport(1000, 600);
  const modelWidthInRem = await browser.evaluate<number>(`document.querySelector('#model').getBoundingClientRect().width /
    parseFloat(getComputedStyle(document.documentElement).fontSize)`);
  assert.equal(modelWidthInRem, 14);
});

test("saved prose renders Markdown on narrow screens and survives live updates", { skip: !chrome, timeout: 60_000 }, async t => {
  const host = await openHost(fauxConfig(await fixture(t)));
  const serve = "https://operator.example.invalid";
  const api = await startApi(host, health, 0, { tailscaleOrigin: serve });
  t.after(async () => { await api.close(); await host.close(); });
  const base = `http://127.0.0.1:${api.port}`;
  const code = "const value = " + "x".repeat(200);
  const longCell = "x".repeat(80);
  const raw = '<img src="/markdown-image-probe" onerror="window.bad = true">';
  const source = [
    "## Heading", "", "A **strong** and *emphasized* `word`.", "Next line.", "",
    "> quoted", "", "- one", "- two", "", "1. first", "2. second", "", "```js", code, "```", "",
    '[site](https://example.org/path "&quot; onclick=&quot;literal") <http://example.com/>', "",
    raw, "", "![remote](https://example.org/image.png) ![local](/markdown-image-probe)", "",
    "[script](java&#x73;cript&colon;alert%281%29) [data](data:text/html,hello)",
    "[empty]() [relative](/api/shutdown) [fragment](#1) [protocol relative](//example.org)",
    `[internal](${base}/api/shutdown) [alias](http://localhost:${api.port}/api/shutdown) [serve](${serve}/api/shutdown)`,
    "[credentials](https://someone@example.org/)", "",
    "| Default | Left | Middle | Right |",
    "| --- | :--- | :---: | ---: |",
    `| ${longCell} | **Name** | ready | 42 |`,
  ].join("\n");
  const root = (await host.conversation("root"))!;
  const assistant = fauxAssistantMessage([
    { type: "text", text: source + "\n\n~~~txt\nAn open fence" },
    fauxToolCall("bash", { command: "echo **literal**" }, { id: "shell" }),
    { type: "text", text: "**After the call**" },
  ], { stopReason: "toolUse" });
  await root.commit(tx => tx.appendEntry(root.id, { kind: "test", model: [
    { role: "user", content: source, timestamp: 0 },
    assistant,
    { role: "toolResult", toolName: "bash", toolCallId: "shell", content: [{ type: "text", text: "**literal result**" }],
      timestamp: 0, isError: false },
  ] }), ctx);

  const browser = await openBrowser(t);
  await browser.viewport(390, 600);
  await browser.navigate(base);
  await waitFor(browser, "the saved cards", state => state.messages.length === 5);
  for (const role of ["user", "assistant"]) {
    const rendered = await browser.evaluate(`(() => {
      const body = document.querySelector('#entries .${role}.prose .card-body');
      const pre = body.querySelector('pre');
      const table = body.querySelector('table');
      const transcript = document.querySelector('#transcript');
      pre.scrollLeft = 80;
      table.parentElement.scrollLeft = 80;
      return {
        heading: body.querySelector('h2').textContent,
        paragraph: body.querySelector('p').innerText,
        inline: ['strong', 'em', 'p code', 'blockquote'].map(tag => body.querySelector(tag).textContent.trim()),
        items: [...body.querySelectorAll('li')].map(li => li.textContent),
        code: pre.querySelector('code').textContent,
        scrolls: pre.scrollLeft > 0 && table.parentElement.scrollLeft > 0 && transcript.scrollWidth === transcript.clientWidth,
        table: [...table.rows].map(row => [...row.cells].map(cell =>
          [cell.tagName, cell.textContent, getComputedStyle(cell).textAlign])),
        links: [...body.querySelectorAll('a[href]')].map(a => [a.textContent, a.getAttribute('href'), a.target, a.rel]),
        unsafe: !!body.querySelector('img, script, [onerror], [onclick], [style]'),
        raw: body.textContent.includes(${JSON.stringify(raw)}),
        imagePlaceholder: body.textContent.includes('[image]'),
      };
    })()`);
    assert.deepEqual(rendered, {
      heading: "Heading", paragraph: "A strong and emphasized word.\nNext line.",
      inline: ["strong", "emphasized", "word", "quoted"], items: ["one", "two", "first", "second"],
      code: code + "\n", scrolls: true,
      table: [
        [["TH", "Default", "left"], ["TH", "Left", "left"], ["TH", "Middle", "center"], ["TH", "Right", "right"]],
        [["TD", longCell, "left"], ["TD", "Name", "left"], ["TD", "ready", "center"], ["TD", "42", "right"]],
      ],
      links: [["site", "https://example.org/path", "_blank", "noopener noreferrer"],
        ["http://example.com/", "http://example.com/", "_blank", "noopener noreferrer"]],
      unsafe: false, raw: true, imagePlaceholder: true,
    });
  }
  assert.deepEqual(await browser.evaluate(`(() => {
    const tool = document.querySelector('#entries .toolCall .card-body');
    const result = document.querySelector('#entries .toolResult .card-body');
    const after = tool.parentElement.nextElementSibling;
    window.savedLink = document.querySelector('#entries .user .card-body a[href]');
    return [tool.textContent, tool.childElementCount, after.querySelector('strong').textContent,
      result.textContent, result.childElementCount];
  })()`), ['→ bash {"command":"echo **literal**"}', 0, "After the call", "**literal result**", 0]);

  // Stream unfinished Markdown and a partial call: both stay literal, and the saved link keeps its identity.
  await root.commit(async tx => {
    (await tx.doc(LiveDoc, root.id)).generation = { attempt: 1, message: JSON.parse(JSON.stringify(fauxAssistantMessage([
      { type: "text", text: "**Writing" }, fauxToolCall("bash", { command: "partial" }),
    ]))) };
  }, ctx);
  await until(() => browser.evaluate(`!!document.querySelector('#live .liveText')`));
  assert.deepEqual(await browser.evaluate(`(() => {
    const live = document.querySelector('#live .liveText .card-body');
    return [live.textContent, live.childElementCount, window.savedLink.isConnected];
  })()`), ['**Writing\n→ bash {"command":"partial"}', 0, true]);
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
  assert.equal(html.headers.get("content-security-policy"), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'self'");
  await browser.navigate(base);
  // The newest 50 entries: two of them are assistant messages that each made two calls, a card apiece.
  await waitFor(browser, "the cards of the 50 newest entries", state => state.messages.length === 52);
  const runButtons = `[...document.querySelectorAll('.toolResult button[data-action="openPane"]')]`;
  const click = async (label: string) => browser.evaluate(`${runButtons}.find(button => button.textContent.includes(${JSON.stringify(label)})).click()`);
  const paneText = () => browser.evaluate<string>(`document.querySelector('#pi-run').textContent`);
  const shows = async (text: string) => {
    try { return await until(paneText, value => value.includes(text)); }
    catch { assert.fail(`Expected ${text} in the pane; found ${await paneText()}; errors: ${browser.errors.join(", ")}`); }
  };
  // A result has its own control even though its call isn't on this page yet. A refused request has none.
  const labels = () => browser.evaluate<string[]>(`${runButtons}.map(button => button.textContent)`);
  assert.deepEqual(await labels(), ["Open Pi run", "Open Pi run · Missing archive", "Open Pi run"]);
  await browser.evaluate(`${runButtons}[0].click()`);
  await shows("First archive");
  await browser.evaluate(`document.querySelector('#pi-run-close').click(); window.kept = document.querySelector('#entries .entry'); document.querySelector('#older').click()`);
  await until(() => browser.evaluate(`document.querySelector('#older').hidden`));
  // The older page brings the first result's call, so its card gains the task's first line and stays in place.
  // A call's ID used twice in one message names neither task. Results can arrive in another order than the calls.
  assert.equal(await browser.evaluate("window.kept.isConnected"), true);
  assert.deepEqual(await labels(), [
    "Open Pi run · Second task", "Open Pi run · First task", "Open Pi run · Missing archive", "Open Pi run",
  ]);
  assert.equal(await browser.evaluate(`document.querySelectorAll('.entry:not(.toolResult) button[data-action="openPane"]').length`), 0);
  // An assistant message is a card for its text and one for each call, in the order it wrote them.
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('#entries .entry')].slice(0, 5).map(card => [card.className, card.lastChild.innerText])`), [
    ["entry prose user", `→ pi {"runId":"${second}"}`],
    ["entry prose assistant", "Pasted → pi {} stays plain"],
    ["entry toolCall assistant", '→ pi {"task":"First task\\nDo not show the rest of the task"}'],
    ["entry toolCall assistant", '→ pi {"task":"Second task"}'],
    ["entry toolCall assistant", '→ bash {"command":"echo fixture"}'],
  ]);

  // This desktop width wraps the controls when the side pane narrows the transcript.
  await browser.viewport(905, 850);
  const chatOffset = `document.querySelector('#entries .entry').getBoundingClientRect().top - document.querySelector('#transcript').getBoundingClientRect().top`;
  await browser.evaluate(`
    document.querySelector('#transcript').scrollTop = 0;
    window.entryOffset = ${chatOffset};
    window.openerButton = ${runButtons}.find(button => button.textContent.includes("First task"));
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
  // An aborted message's call has no result and so no control; the result of an ambiguous call opens its own run.
  assert.equal(await browser.evaluate(`document.querySelector('#entries').textContent.includes('Unfinished task')`), true);
  await browser.evaluate(`[...document.querySelectorAll('.toolResult')].find(entry => entry.textContent.includes('duplicate result')).querySelector('button[data-action="openPane"]').click()`);
  await shows("Duplicate-ID archive");

  // A branch change closes the pane. A reload of the fork reads the original exchange, not the later reused ID.
  await browser.evaluate(`document.querySelector('[data-branch="${side.id}"]').click()`);
  await waitFor(browser, "the fork", state => state.current === "Forked history" && state.messages.length === 8);
  assert.equal(await browser.evaluate(`document.querySelector('#pi-run').hidden`), true);
  await browser.navigate("about:blank");
  await browser.navigate(base + "/#" + side.id);
  await waitFor(browser, "reloaded fork", state => state.current === "Forked history" && state.messages.length === 8);
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
  const banner = () => browser.evaluate<string>(`document.querySelector('#pi-run > .run-status').textContent`);
  const atLatest = (text: string) => until(pane, value => value.text.includes(text) && value.top > 0 && value.bottom && !value.jump);
  const click = (selector: string) => browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const pause = async () => {
    await browser.evaluate(`document.querySelector('#pi-run-view').scrollTop = 95`);
    return until(pane, value => value.top === 95 && value.jump);
  };

  // A call that has not finished has a card of its own after the transcript, which opens the run as it happens.
  const liveRun = '#live .liveTool button[data-action="openPane"]', oldRun = '.toolResult button[data-action="openPane"]';
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(liveRun)}).textContent`), "Open Pi run · Current task");
  await browser.evaluate(`window.liveButton = document.querySelector(${JSON.stringify(liveRun)})`);
  await click(liveRun);
  assert.match(await banner(), /Waiting for this call/);
  assert.deepEqual(await requests(), []);
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('#pi-run button')].some(button => button.textContent === 'Refresh')`), false);
  await root.commit(async tx => {
    (await tx.doc(LiveDoc, root.id)).tools = [{ name: "pi", callId: "current", status: "running", details: { runId: first } }];
  }, ctx);
  await next();
  assert.equal(await browser.evaluate("window.liveButton.isConnected"), true, "a change of the live state keeps the card's button");
  const initialSnapshot = snapshot(["first output"]);
  await reply({ ...initialSnapshot, durationMs: 1000 });
  const initial = await atLatest("first output 39");
  await browser.viewport(1100, 470);
  assert.ok((await atLatest("first output 39")).top > initial.top);
  await browser.evaluate(`window.logBeforeTick = document.querySelector('#pi-run-data pre');
    window.statusBeforeTick = document.querySelector('#pi-run-message').firstChild`);
  await next();
  await reply({ ...initialSnapshot, durationMs: 2500 });
  await until(banner, text => text.includes("running · 0m 2s"));
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
  assert.match(await banner(), /Retrying/);
  assert.deepEqual(await pane(), reading);
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
  await until(banner, text => text.includes("completed"));
  await sleep(1800);
  assert.equal((await requests()).length, count);
  assert.deepEqual(await pane(), beforeCompletion);
  await browser.evaluate(`document.querySelector('#pi-run-jump').focus()`);
  await browser.key("Enter");
  await atLatest("final tail 39");
  assert.equal(await browser.evaluate(`document.activeElement.id`), "pi-run-view");

  const stale = count;
  await click(liveRun);
  await next();
  await click(oldRun);
  await next(second);
  assert.equal(await browser.evaluate(`window.runRequests[${stale}].signal.aborted`), true);
  await reply(snapshot(["other run"], { runId: second, status: "completed" }));
  const other = await atLatest("other run 39");
  await reply(snapshot(["stale response"]), 200, stale);
  await sleep(1800);
  assert.deepEqual(await pane(), other);
  assert.equal((await requests()).length, count);

  await click(liveRun);
  await next();
  await reply(snapshot(["reopened"]));
  await atLatest("reopened 39");
  // When the result is saved, its card takes the place of the live one, and the open pane stays on the run.
  await root.commit(async tx => {
    await tx.appendEntry(root.id, { kind: "test", model: [{
      role: "toolResult", toolName: "pi", toolCallId: "current", content: [{ type: "text", text: "Current result" }],
      timestamp: 0, isError: false, details: { runId: first },
    }] });
    (await tx.doc(LiveDoc, root.id)).tools = [{ name: "pi", callId: "current", status: "done" }];
  }, ctx);
  await waitFor(browser, "the result's card", state => state.messages.length === 3);
  assert.equal(await browser.evaluate(`document.querySelectorAll('#live .entry').length`), 0);
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll(${JSON.stringify(oldRun)})].map(button => button.textContent)`),
    ["Open Pi run", "Open Pi run · Current task"]);
  assert.equal(await browser.evaluate(`document.querySelector('#pi-run').hidden`), false);
  await next();
  await reply(snapshot(["finished"], { status: "completed" }));
  await atLatest("finished 39");
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
  await until(() => browser.evaluate("!document.querySelector('#send').disabled && !!document.querySelector('#live .runFailure')"));
  assert.match(await browser.evaluate<string>("document.querySelector('#live .runFailure').textContent"), /model_error: Provider is not configured: openai/);
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

const click = (selector: string) => `document.querySelector(${JSON.stringify(selector)}).click()`;

async function compose(browser: Awaited<ReturnType<typeof openBrowser>>, content: string) {
  await until(() => browser.evaluate<boolean>("!document.querySelector('#send').disabled"));
  await browser.evaluate(`document.querySelector('#input').value = ${JSON.stringify(content)}; document.querySelector('#composer').requestSubmit()`);
}

test("Pages previews and direct views are sandboxed; the library moves and deletes links without running them", { skip: !chrome, timeout: 60_000 }, async t => {
  const dir = await fixture(t);
  const web = join(dir, "formatter.ts");
  await writeFile(web, `export const steps = [{ name: 'format', card: () => ({ format: 'page-preview', style: 'format-probe' }) }];`);
  const faux = fauxPages();
  const host = await openHost(fauxConfig(dir), { models: faux.models, apps: [fixtureApp("formatter", { web: pathToFileURL(web) })] });
  let api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });
  const base = `http://127.0.0.1:${api.port}`;
  const root = (await host.conversation("root"))!;
  await host.harness.commit(async tx => {
    // Force an older page that a reconnect's initial transcript window will drop.
    for (let i = 0; i < 55; i++) {
      await tx.appendEntry(root.id, { kind: "test", model: [fauxAssistantMessage(`Earlier Pages history ${i}`)] });
    }
  }, ctx);
  const safeBranch = await host.newBranch("Empty sandbox probe");
  const fixtureSite = await pagesBrowserFixture(t, safeBranch.id);
  const title = "Static <em>as text</em>";
  const { page: staticPage } = await faux.publish(host, "root", { title, html: fixtureSite.html("static") });
  const { page: jsPage } = await faux.publish(host, "root", { title: "Interactive", html: fixtureSite.html("interactive"), interactive: true });
  const htmlPath = pagePath(staticPage.id);
  const jsPath = pagePath(jsPage.id);
  await host.appCommand(root, { connect: true, args: ["formatter"] });
  await host.harness.commit(async tx => {
    const result = (toolName: string, details: JsonObject, text: string, isError = false) => ({
      role: "toolResult" as const, toolName, details, toolCallId: text, isError, timestamp: 0,
      content: [{ type: "text" as const, text }],
    });
    await tx.appendEntry(root.id, { kind: "test", model: [
      fauxAssistantMessage(`<iframe src="${jsPath}"></iframe> ${JSON.stringify(jsPage)}`),
      result("formatter_probe", { ...jsPage, mode: "static" }, "Other tool has valid-looking page details"),
      result(publishPageTool, jsPage, "Failed publish with valid-looking details", true),
      result(publishPageTool, { title, src: jsPath }, "Publish with invalid details"),
    ] });
  }, ctx);

  const browser = await openBrowser(t);
  const requested = await browser.watchRequests();
  const wait = (expression: string) => until(() => browser.evaluate<boolean>(expression));
  const tap = (selector: string) => browser.evaluate(click(selector));
  const preview = '[data-format="page-preview"]';
  const staticFrame = `${preview} iframe[src="${htmlPath}"]`;
  const jsFrame = `${preview} iframe[src="${jsPath}"]`;
  const noScripts = () => assert.ok(!fixtureSite.requests.some(path => path.endsWith("-script.svg")));
  const intact = async () => assert.ok((await host.branches()).branches.some(branch => branch.id === safeBranch.id));
  const checkReport = (embedded: boolean, index: number) => assert.deepEqual(fixtureSite.reports[index], {
    origin: "null", embedded, parentBlocked: embedded ? true : null, cookiesBlocked: true, workerBlocked: true,
    apiBlocked: true, noCorsReadBlocked: true, wsBlocked: true, external: "Fixture data",
  });

  const stopSeeding = await browser.onNewDocument(`window.originalFetch = fetch;
    window.fetch = (url, ...args) => url !== '${pagesLibraryApi}' ? originalFetch(url, ...args)
      : new Promise(resolve => { window.releaseMetadata = () => resolve(originalFetch(url, ...args)); });`);
  const atBottom = `(() => { const box = document.querySelector('#transcript');
    return box.scrollHeight - box.scrollTop - box.clientHeight < 40; })()`;
  await browser.navigate(base);
  await stopSeeding();
  await wait(`typeof window.releaseMetadata === 'function'`);
  assert.equal(await browser.evaluate(atBottom), true);
  await browser.evaluate(`window.fetch = originalFetch; window.releaseMetadata(); undefined`);
  await wait(`document.querySelector('${staticFrame}') !== null && document.querySelector('${preview} button') !== null
    && document.querySelector('.format-probe') !== null`);
  assert.equal(await browser.evaluate(atBottom), true, "expanding a preview preserves the bottom of the transcript");
  await browser.evaluate(`document.querySelector('${staticFrame}').scrollIntoView()`);
  await until(() => fixtureSite.requests.includes("/static-render.svg"));
  assert.deepEqual(await browser.evaluate(`[
    document.querySelector('${staticFrame}').getAttribute('sandbox'),
    document.querySelector('${staticFrame}').contentDocument === null,
    document.querySelector('header a[href="/pages"]').textContent,
    ...[...document.querySelectorAll('${preview} a')].map(a => [a.textContent, a.getAttribute('href')]),
  ]`), ["", true, "Pages", ["Open full page", htmlPath], ["Open full page", jsPath]]);
  assert.equal(await browser.evaluate(`document.querySelectorAll('iframe').length`), 1);
  assert.equal(await browser.evaluate(`document.querySelectorAll('${preview}').length`), 2);
  assert.equal(await browser.evaluate(`document.querySelector('.format-probe .card-body').textContent`), "Other tool has valid-looking page details");
  assert.ok(!requested.includes(base + jsPath), "the interactive document is not requested before consent");
  assert.ok(!fixtureSite.requests.includes("/interactive-render.svg"));
  noScripts();

  await tap(`${preview} button`);
  await until(() => fixtureSite.reports.length === 1).catch(error => {
    throw new Error(`No inline probe report: ${JSON.stringify({ fixture: fixtureSite.requests, requested, errors: browser.errors })}`, { cause: error });
  });
  checkReport(true, 0);
  await intact();
  assert.equal(await browser.evaluate(`document.querySelector('${jsFrame}').getAttribute('sandbox')`), "allow-scripts");
  await browser.evaluate(`window.keptPage = document.querySelector('${jsFrame}')`);
  await faux.turn(host, "root");
  await wait(`document.querySelector('#entries .entry:last-child .card-body')?.textContent.trim() === 'Faux Pages turn finished.'`);
  assert.equal(await browser.evaluate(`window.keptPage === document.querySelector('${jsFrame}')`), true);
  await browser.evaluate(`window.originalFetch = fetch;
    window.fetch = (url, ...args) => url === '${pagesLibraryApi}' ? Promise.resolve(new Response(null, { status: 503 })) : originalFetch(url, ...args);
    window.dispatchEvent(new Event('focus'))`);
  await wait(`document.querySelector('#entries').textContent.includes('Could not check page availability.')`);
  assert.equal(await browser.evaluate(`window.keptPage === document.querySelector('${jsFrame}')`), true);
  await browser.evaluate(`window.fetch = originalFetch; window.dispatchEvent(new Event('focus'))`);
  await wait(`!document.querySelector('#entries').textContent.includes('Could not check page availability.')`);

  const earlier = `document.querySelector('#entries').textContent.includes('Earlier Pages history 0')`;
  assert.equal(await browser.evaluate(earlier), false);
  await tap("#older");
  await wait(earlier);
  await browser.evaluate("window.keptBrowsingContext = window.keptPage.contentWindow");
  const port = api.port;
  await api.close();
  api = await startApi(host, health, port);
  await wait(`!(${earlier})`);
  assert.equal(await browser.evaluate(`window.keptBrowsingContext === document.querySelector('${jsFrame}').contentWindow`), true,
    "trimming older history preserves the running browsing context, not just the iframe node");

  // These are top-level navigations: there is no iframe attribute supplying the isolation.
  await browser.navigate(base + htmlPath);
  assert.deepEqual(await browser.evaluate(`[self.origin, document.querySelector('h1').textContent,
    document.querySelector('#api-image').naturalWidth]`), ["null", "Published static fixture", 0]);
  await tap("#probe-form");
  assert.ok(!fixtureSite.requests.includes("/static-script.svg"));
  await browser.navigate(base + jsPath);
  await until(() => fixtureSite.reports.length === 2);
  checkReport(false, 1);
  await intact();

  const beforeLibrary = requested.filter(url => url === base + jsPath || url === base + htmlPath).length;
  await browser.navigate(base + pagesPath);
  await wait("document.querySelectorAll('#sections li').length === 2");
  assert.deepEqual(await browser.evaluate(`[
    document.querySelector('#sections h2').textContent, document.querySelector('#sections a').textContent,
    document.querySelectorAll('#sections em, iframe').length,
  ]`), ["Unsorted", title, 0]);
  await browser.evaluate(`window.originalFetch = fetch;
    window.fetch = (...args) => new Promise(resolve => { window.saveLibrary = () => resolve(originalFetch(...args)); });
    document.querySelector('#new-section input').value = 'Reports <b>as text</b>';
    document.querySelector('#new-section').requestSubmit()`);
  assert.deepEqual(await browser.evaluate(`[document.querySelector('#new-section').inert, document.querySelector('#sections').inert,
    document.querySelector('#status').textContent]`), [true, true, "Saving…"]);
  await browser.evaluate("window.fetch = originalFetch; window.saveLibrary(); undefined");
  await wait("document.querySelectorAll('#sections section').length === 2 && !document.querySelector('#sections').inert");
  assert.equal(await browser.evaluate("document.querySelector('#sections section:last-child h2').textContent"), "Reports <b>as text</b>");
  for (const [index, path] of [htmlPath, jsPath].entries()) {
    await browser.evaluate(`{
      const select = document.querySelector('a[href="${path}"]').closest('li').querySelector('select');
      select.selectedIndex = 1; select.dispatchEvent(new Event('change'));
    }`);
    await wait(`document.querySelectorAll('#sections section:last-child li').length === ${index + 1}`);
  }
  await tap('button[aria-label="Move Interactive up"]');
  await wait(`document.querySelector('#sections section:last-child a').getAttribute('href') === '${jsPath}'`);
  await browser.evaluate(`window.confirm = message => { window.confirmation = message; return true; };`);
  await tap('button[aria-label="Delete Interactive"]');
  await wait(`!document.querySelector('#sections a[href="${jsPath}"]')`);
  assert.match(await browser.evaluate<string>("window.confirmation"), /Delete “Interactive”.*history will be kept/i);
  assert.equal(requested.filter(url => url === base + jsPath || url === base + htmlPath).length, beforeLibrary, "the trusted library requests no published HTML");

  await browser.navigate(base);
  await wait(`document.querySelector('#entries').textContent.includes('Page no longer available.')`);
  assert.equal(await browser.evaluate(`document.querySelector('${jsFrame}') === null && !document.querySelector('${preview} button')`), true);
  assert.equal(fixtureSite.reports.length, 2);
  await intact();
});

test("app load and step failures fall back without leaking async results to another branch", { skip: !chrome, timeout: 60_000 }, async t => {
  const dir = await fixture(t);
  const web = join(dir, "late.ts");
  await writeFile(web, `
    // A gate for this test only. Switch branches while import is still pending.
    await new Promise<void>(resolve => { globalThis.releaseFixture = resolve; });
    export const steps = [
      { name: "header", surround({ branch }: { branch: number }) { return { style: "must-not-apply", header: [{ label: "Fixture " + branch }] }; } },
      { name: "broken", surround() { throw new Error("test step crashed"); } },
    ];
  `);
  const host = await openHost(fauxConfig(dir), { apps: [fixtureApp("late", { web: pathToFileURL(web) }),
    fixtureApp("missing", { web: pathToFileURL(join(dir, "missing.ts")) })] });
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });
  const root = (await host.conversation("root"))!;
  const side = await host.fork(root, { title: "App side" });
  const base = `http://127.0.0.1:${api.port}`;
  const browser = await openBrowser(t);
  await browser.navigate(`${base}/#${side.id}`);
  await waitFor(browser, "the side branch", value => value.title === "App side");
  await compose(browser, "/connect missing");
  await compose(browser, "/connect late");
  await until(() => browser.evaluate<boolean>("typeof globalThis.releaseFixture === 'function'"));
  await browser.evaluate(click(`[data-branch='${root.id}']`));
  await waitFor(browser, "the root", value => value.title === "Main");
  await browser.evaluate("globalThis.releaseFixture()");
  await say(host, "root", "**Normal chat after the import**");
  await waitFor(browser, "the ordinary response", value => value.messages.some(text => text.includes("Faux reply")));
  assert.deepEqual(await browser.evaluate("[document.querySelector('#card-header').hidden, document.querySelector('#card-notice').hidden, document.body.className]"), [true, true, ""]);
  await browser.evaluate(click(`[data-branch='${side.id}']`));
  const diagnostic = () => browser.evaluate<string>("document.querySelector('#card-notice').textContent");
  const problems = await until(diagnostic, text => text.includes("late/broken") && text.includes("missing"));
  assert.match(problems, /Could not load cards for app missing/);
  assert.match(problems, /test step crashed/);
  assert.deepEqual(await browser.evaluate("[document.querySelector('#card-header').textContent, document.body.className]"), [`Fixture ${side.id}`, ""]);
  await compose(browser, "/disconnect missing");
  await compose(browser, "/disconnect late");
  await until(() => browser.evaluate<boolean>("document.querySelector('#card-header').hidden && document.querySelector('#card-notice').hidden"));
  assert.deepEqual(browser.errors, []);
});

test("Gym phone logging and a Faux coaching turn share the same actual workouts", { skip: !chrome, timeout: 60_000 }, async t => {
  const dir = await fixture(t);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const host = await openHost(fauxConfig(dir), { models });
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });
  const root = (await host.conversation("root"))!;
  const side = await host.fork(root, { title: "Training" });
  const base = `http://127.0.0.1:${api.port}`;
  const gym = `/apps/gym/?branch=${side.id}`;
  const browser = await openBrowser(t, ["--window-size=390,800"]);
  await browser.viewport(390, 780);
  await browser.emulateTouch();
  const wait = (expression: string) => until(() => browser.evaluate<boolean>(expression));
  const tap = (selector: string) => browser.evaluate(click(selector));
  const backToCoach = async () => {
    await tap("#chat-link");
    // Clicking Back navigates to a different document; wait for its markup before reading the chat view.
    await wait("document.getElementById('title') !== null");
    await waitFor(browser, "back in Training", value => value.title === "Training");
  };
  const set = (values: Record<string, string>) => browser.evaluate(`for (const [id, value] of Object.entries(${JSON.stringify(values)})) {
    const field = document.getElementById(id);
    field.value = value;
    field.dispatchEvent(new Event(id === 'exercise' ? 'change' : 'input', { bubbles: true }));
  }`);
  const values = (...ids: string[]) => browser.evaluate<string[]>(`${JSON.stringify(ids)}.map(id => document.getElementById(id).value)`);
  const names = () => browser.evaluate<string[]>("[...document.querySelectorAll('#exercise option')].map(option => option.textContent)");
  const newExercise = async (name: string) => {
    await set({ exercise: "add-new" });
    await set({ "new-exercise-name": name });
    await tap("#confirm-exercise");
    await wait("!document.querySelector('#new-exercise').open");
  };
  const status = (text: string) => wait(`document.querySelector('#status').textContent.includes(${JSON.stringify(text)})`);
  const matching = (selector: string, property = "textContent") => browser.evaluate<string[]>(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map(el => el[${JSON.stringify(property)}])`);
  const draftLines = () => matching("#draft-sets > li span");
  const checkSetList = async (selector: string, expectedGaps: number[]) => {
    const { markerless, gaps, trailing } = await browser.evaluate<{ markerless: boolean; gaps: number[]; trailing: number }>(`(() => {
      const list = document.querySelector(${JSON.stringify(selector)});
      const rows = [...list.children];
      const bounds = list.getBoundingClientRect();
      const boxes = rows.map(row => row.getBoundingClientRect());
      return {
        markerless: list.getAttribute('role') === 'list' && rows.every(row => {
          const style = getComputedStyle(row);
          return row.tagName === 'LI' && style.display === 'list-item' && style.listStyleType === 'none';
        }),
        gaps: rows.map((row, i) => (boxes[i].top - (i ? boxes[i - 1].bottom : bounds.top)) / parseFloat(getComputedStyle(row).lineHeight)),
        trailing: bounds.bottom - boxes.at(-1).bottom,
      };
    })()`);
    assert.ok(markerless, `${selector} retains list semantics without markers`);
    assert.equal(gaps[0], 0, `${selector} starts flush`);
    assert.equal(trailing, 0, `${selector} ends flush`);
    assert.equal(gaps.length, expectedGaps.length + 1);
    for (const [i, gap] of expectedGaps.entries()) {
      assert.ok(Math.abs(gaps[i + 1] - gap) < 0.02, `${selector} gap after row ${i + 1}: expected ${gap} lines, got ${gaps[i + 1]}`);
    }
  };
  const checkInlineActions = async (row: string, textSelector: string, minTarget = 32) => {
    assert.equal(await browser.evaluate(`(() => {
      const row = document.querySelector(${JSON.stringify(row)});
      const text = row.querySelector(${JSON.stringify(textSelector)}).getBoundingClientRect();
      const buttons = [...row.querySelectorAll('button')].map(button => button.getBoundingClientRect());
      return buttons.every((box, i) => box.left >= (i ? buttons[i - 1].right : text.right)
        && box.top === buttons[0].top && text.top < box.bottom && text.bottom > box.top
        && box.width >= ${minTarget} && box.height >= ${minTarget});
    })()`), true, `${row} keeps all controls beside its text with room to tap`);
  };
  const assertNoHorizontalScroll = async (message: string) => {
    // Unlike innerWidth, clientWidth excludes any space used by a vertical scrollbar.
    const [contentWidth, viewportWidth] = await browser.evaluate<[number, number]>(
      "[document.documentElement.scrollWidth, document.documentElement.clientWidth]");
    assert.equal(contentWidth, viewportWidth, message);
  };
  const overview = async () => (await fetch(`${base}/apps/gym/api/overview`)).json() as Promise<{
    workouts: { id: string; date: string; sets: { exercise: string; duration: number; durationUnit: string; load: number | null; loadUnit: string | null }[] }[];
    suggestion: { note: string } | null;
  }>;

  const heading = async (text: string) => assert.deepEqual(await matching("#workout-heading"), [text]);
  assert.match(await (await fetch(base + gym)).text(), /<h2 id="workout-heading">Workouts<\/h2>/);
  await browser.navigate(`${base}/#${side.id}`);
  await waitFor(browser, "Training", value => value.title === "Training");
  await compose(browser, "/connect gym");
  await wait(`document.querySelector('#card-header a')?.getAttribute('href') === '${gym}'`);
  assert.match((await waitFor(browser, "connect notice", value => value.messages.some(text => text.includes("Connected this branch")))).messages.join(), /Connected this branch to Gym/);
  await tap("#card-header a");
  await wait("document.querySelector('#workout-editor')?.disabled === false");
  await heading("Workouts");
  assert.equal(await browser.evaluate("document.querySelector('#chat-link').getAttribute('href')"), `/#${side.id}`);
  assert.equal(await browser.evaluate(`document.querySelector('#workout-date').value === new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)`), true);
  await assertNoHorizontalScroll("phone does not scroll horizontally");
  assert.deepEqual(await names(), ["Choose an exercise", "Add new"]);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#duration-unit option')].map(option => option.value)"), ["reps", "m", "sec", "min"]);
  await set({ exercise: "add-new" });
  await set({ "new-exercise-name": "   " });
  await tap("#confirm-exercise");
  assert.equal(await browser.evaluate("document.querySelector('#new-exercise').open"), true, "blank names are rejected");
  await set({ "new-exercise-name": "Cancelled" });
  await tap("#cancel-exercise");
  assert.deepEqual(await names(), ["Choose an exercise", "Add new"]);
  assert.equal(await browser.evaluate("localStorage.getItem('gym-draft')"), null);

  await newExercise("  Squat  ");
  await tap("#clear-set");
  assert.ok((await names()).includes("Squat"), "a confirmed name stays selectable before any set is logged");
  await set({ exercise: "name:Squat", duration: "5.5", load: "60" });
  assert.deepEqual(await values("duration-unit", "load-unit"), ["reps", "kg"]);
  await tap("#add-set");
  assert.equal(await browser.evaluate("document.querySelectorAll('#draft-sets li').length"), 0);
  await set({ duration: "5" });
  await tap("#add-set");
  await set({ duration: "4", load: "62.5" });
  await tap("#add-set");
  const plank = "Plank" + "x".repeat(75); // A long unbroken name must wrap without moving the buttons below it.
  const plankLine = plank + " · 15.5 sec · 60 kg";
  await newExercise(plank);
  await set({ "duration-unit": "sec", duration: "15.5", load: "60" });
  assert.equal((await overview()).workouts.length, 0, "draft changes don't write the log");
  await browser.navigate(`${base}/#${side.id}`);
  await browser.navigate(base + gym);
  await wait("document.querySelector('#workout-editor')?.disabled === false");
  await heading("Workouts");
  assert.equal(await browser.evaluate("document.querySelectorAll('#draft-sets li').length"), 2);
  assert.deepEqual(await values("exercise", "duration", "duration-unit", "load", "load-unit"), ["name:" + plank, "15.5", "sec", "60", "kg"]);
  await tap("#add-set");
  const newestFirst = [plankLine, "Squat · 4 reps · 62.5 kg", "Squat · 5 reps · 60 kg"];
  assert.deepEqual(await draftLines(), newestFirst);
  assert.deepEqual(await matching("#draft-sets button", "ariaLabel"),
    newestFirst.flatMap((line, i) => ["Edit", "Remove"].map(action => `${action} set ${3 - i}: ${line}`)));
  await tap('#draft-sets li:last-child [data-action="edit-set"]');
  assert.deepEqual(await values("exercise", "duration", "load"), ["name:Squat", "5", "60"]);
  await set({ duration: "6" });
  await tap("#add-set");
  const entryLines = ["Squat · 6 reps · 60 kg", "Squat · 4 reps · 62.5 kg", plankLine];
  assert.deepEqual(await draftLines(), [entryLines[2], entryLines[1], entryLines[0]], "editing does not move a set");
  assert.deepEqual(await browser.evaluate("JSON.parse(localStorage.getItem('gym-draft')).sets.map(set => set.duration)"), [6, 4, 15.5]);
  await browser.viewport(320, 780);
  await checkSetList("#draft-sets", [0.5, 0]);
  await checkInlineActions("#draft-sets > li:first-child", "span");
  assert.equal(await browser.evaluate(`(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#draft-sets li:first-child span'));
    return range.getClientRects().length > 1;
  })()`), true, "long set text wraps");
  await assertNoHorizontalScroll("long sets fit on narrow phones");

  await tap("#save-workout");
  await status("Workout saved");
  const [first] = (await overview()).workouts;
  assert.deepEqual(first.sets.map(set => [set.exercise, set.duration, set.durationUnit, set.load, set.loadUnit]),
    [["Squat", 6, "reps", 60, "kg"], ["Squat", 4, "reps", 62.5, "kg"], [plank, 15.5, "sec", 60, "kg"]]);
  assert.equal(await browser.evaluate("localStorage.getItem('gym-draft')"), null);
  const firstCard = `[data-workout-id='${first.id}']`;
  await wait(`!!document.querySelector(${JSON.stringify(firstCard)})`);
  await checkSetList(`${firstCard} ol`, [0, 0.5]);
  assert.deepEqual(await matching(`${firstCard} ol > li`), entryLines);
  assert.deepEqual(await matching(`${firstCard} h3`), [first.date]);
  const workoutActions = ["Edit", "Copy", "Delete"].map(action => `${action} workout on ${first.date}`);
  assert.deepEqual(await matching(`${firstCard} button`, "ariaLabel"), workoutActions);
  assert.deepEqual(await matching(`${firstCard} > :has(> h3) button`, "ariaLabel"), workoutActions);
  await checkInlineActions(firstCard, "h3", 44);
  await assertNoHorizontalScroll("recent sets also fit on narrow phones");
  await browser.viewport(390, 780);

  assert.deepEqual(await names(), ["Choose an exercise", plank, "Squat", "Add new"]);
  await newExercise("sQuAt");
  await wait("document.querySelectorAll('#last-session li').length === 2");
  await checkSetList("#last-session ol", [0]);
  assert.deepEqual(await matching("#last-session ol > li"), entryLines.slice(0, 2));
  assert.deepEqual(await values("exercise", "duration", "duration-unit", "load", "load-unit"), ["name:Squat", "6", "reps", "60", "kg"]);
  assert.deepEqual(await names(), ["Choose an exercise", plank, "Squat", "Add new"]);
  await set({ exercise: "name:" + plank });
  await wait("document.querySelectorAll('#last-session li').length === 1");
  assert.deepEqual(await values("duration", "duration-unit", "load", "load-unit"), ["15.5", "sec", "60", "kg"]);
  await set({ exercise: "add-new" });
  await set({ "new-exercise-name": "Never added" });
  await tap("#cancel-exercise");
  assert.deepEqual(await values("exercise", "duration", "load"), ["name:" + plank, "15.5", "60"]);
  await browser.evaluate("window.confirm = () => true");
  await tap("#reset-workout");
  assert.equal(await browser.evaluate("localStorage.getItem('gym-draft')"), null);

  // An old browser draft can still be edited, including a timed set's additional reps and original name casing.
  const fromHistory = "window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))";
  const legacySet = { exercise: "SQUAT", reps: 3, amount: 1.25, unit: "min" };
  const legacyDraft = { id: "old-draft", date: "2025-01-01", sets: [legacySet],
    fields: { ...legacySet, reps: "3", amount: "1.5", position: 0, setDirty: true, valuesDirty: true } };
  await browser.evaluate(`localStorage.setItem('gym-draft', JSON.stringify(${JSON.stringify(legacyDraft)})); ${fromHistory}`);
  assert.deepEqual(await values("exercise", "duration", "duration-unit", "load", "extra-reps"), ["name:SQUAT", "1.5", "min", "", "3"]);
  assert.deepEqual(await names(), ["Choose an exercise", plank, "SQUAT", "Add new"]);
  await set({ "extra-reps": "" });
  await browser.evaluate(fromHistory);
  assert.equal(await browser.evaluate("document.querySelector('#historical-reps').hidden"), false, "an empty extra rep field stays editable");
  await set({ "extra-reps": "4" });
  await tap("#add-set");
  assert.match(await browser.evaluate<string>("document.querySelector('#draft-sets li').textContent"), /SQUAT · 1\.5 min · 4 reps/);

  // A previous visit restored by history must not offer a stale copy if a newer visit saved or discarded it.
  await browser.evaluate(`localStorage.removeItem('gym-draft'); ${fromHistory}`);
  await wait("!document.querySelector('#workout-editor').disabled");
  assert.equal(await browser.evaluate("document.querySelector('#exercise').value"), "");
  const malformed = JSON.stringify({ ...legacyDraft, fields: { exercise: 123 } });
  for (const raw of ["{corrupt", malformed]) {
    await browser.evaluate(`localStorage.setItem('gym-draft', ${JSON.stringify(raw)}); ${fromHistory}`);
    await wait("!document.querySelector('#workout-editor').disabled && !document.querySelector('#draft-warning').hidden");
    assert.equal(await browser.evaluate("localStorage.getItem('gym-draft')"), raw);
    await tap("#reset-workout");
    assert.equal(await browser.evaluate("localStorage.getItem('gym-draft')"), null);
  }

  // Foreground refresh is bounded and doesn't lock local logging. A failed autosave isn't masked by Set added.
  const foreground = "document.dispatchEvent(new Event('visibilitychange'))";
  await browser.evaluate(`
    window.realGymFetch = fetch;
    window.fetch = (url, init) => url === '/apps/gym/api/overview' ? new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      window.releaseOverview = () => resolve(window.realGymFetch(url, init));
    }) : window.realGymFetch(url, init);
    window.saveDraftItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException('storage quota', 'QuotaExceededError'); };
    ${foreground}
  `);
  await wait("typeof window.releaseOverview === 'function'");
  await newExercise("Deadlift");
  await set({ duration: "3", load: "90", "load-unit": "lb" });
  await tap("#add-set");
  await status("Set added");
  await newExercise("Calf raise");
  assert.deepEqual(await values("duration", "duration-unit", "load", "load-unit"), ["", "reps", "", "lb"], "changing exercises keeps the weight unit");
  assert.match(await browser.evaluate<string>("document.querySelector('#draft-warning').innerText"), /could not autosave/);
  await browser.evaluate("Storage.prototype.setItem = window.saveDraftItem; window.fetch = window.realGymFetch; window.releaseOverview()");
  await tap("#reset-workout");

  // Opening the phone the next day updates the default, not a date the operator picked.
  await browser.evaluate(`window.RealDate = Date; window.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2027-01-02T12:00:00'])); }
  }; ${foreground}`);
  await wait("!document.querySelector('#workout-editor').disabled");
  assert.equal(await browser.evaluate("document.querySelector('#workout-date').value"), "2027-01-02");
  await set({ "workout-date": "2026-12-31" });
  await browser.evaluate(`window.Date = RealDate; ${foreground}`);
  await wait("!document.querySelector('#workout-editor').disabled");
  assert.equal(await browser.evaluate("document.querySelector('#workout-date').value"), "2026-12-31");
  await tap("#reset-workout");
  await backToCoach();

  const sql = "SELECT exercise, duration, duration_unit, load, load_unit FROM sets WHERE exercise = 'squat' ORDER BY position";
  const suggested = [{ exercise: "Squat", duration: 5, durationUnit: "reps", load: 65, loadUnit: "kg" },
    { exercise: "sQuAt", duration: 4, durationUnit: "reps", load: 60, loadUnit: "kg" },
    { exercise: "Farmer carry", duration: 20, durationUnit: "m", load: 60, loadUnit: "kg" },
    { exercise: "Squat", duration: 3, durationUnit: "reps", load: 55, loadUnit: "kg" }];
  faux.setResponses([request => {
    assert.deepEqual(getCurrentTools(request.messages).map(tool => tool.name).filter(name => name.startsWith("gym_")), ["gym_query", "gym_suggest_workout"]);
    return fauxAssistantMessage(fauxToolCall("gym_query", { sql }, { id: "gym-read" }), { stopReason: "toolUse" });
  }, fauxAssistantMessage([
    fauxToolCall("gym_suggest_workout", { note: "Start light, then carry.", sets: suggested }, { id: "gym-suggestion" }),
    fauxToolCall("gym_suggest_workout", { note: "invalid", sets: [{ ...suggested[2], loadUnit: null }] }, { id: "gym-error" }),
  ], { stopReason: "toolUse" }), fauxAssistantMessage("**Next workout** is on your phone.")]);
  await compose(browser, "Show my squats and suggest the next workout.");
  await wait("document.querySelector('#entries .prose strong')?.textContent === 'Next workout'");
  await wait("document.querySelectorAll('.toolResult table').length === 2");
  assert.equal(await browser.evaluate("document.querySelectorAll('.toolCall[hidden]').length"), 0);
  assert.equal(await browser.evaluate("document.querySelectorAll('.toolResult a[href^=\"/apps/gym/\"]').length"), 2);
  assert.ok(await browser.evaluate<boolean>(`[...document.querySelectorAll('.toolCall .card-body')].some(el => el.textContent.includes(${JSON.stringify(JSON.stringify(sql))}))`));
  assert.ok(await browser.evaluate<boolean>(`[...document.querySelectorAll('.toolResult .card-body[data-format=text]')].some(el => el.textContent.includes('provide both load and its kg or lb unit'))`));
  const queryRows = await browser.evaluate<string[]>("[...document.querySelectorAll('.toolResult table:first-of-type td')].map(el => el.textContent)");
  assert.ok(queryRows.includes("62.5"));
  assert.equal((await overview()).workouts.length, 1, "even the successful suggestion did not log a workout");

  await tap("#card-header a");
  await wait("document.querySelector('#start-suggestion')?.hidden === false && !document.querySelector('#workout-editor').disabled");
  assert.equal(await browser.evaluate("document.querySelector('#suggestion-note').textContent"), "Start light, then carry.");
  assert.ok((await names()).includes("Farmer carry"));
  const suggestedLines = ["Squat · 5 reps · 65 kg", "sQuAt · 4 reps · 60 kg", "Farmer carry · 20 m · 60 kg", "Squat · 3 reps · 55 kg"];
  assert.deepEqual(await matching("#suggestion-sets > li"), suggestedLines);
  await checkSetList("#suggestion-sets", [0, 0.5, 0.5]);
  await tap("#start-suggestion");
  assert.deepEqual(await draftLines(), suggestedLines.toReversed());
  await checkSetList("#draft-sets", [0.5, 0.5, 0]);
  assert.equal((await overview()).workouts.length, 1);
  await tap('#draft-sets li:last-child [data-action="edit-set"]');
  await set({ load: "145", "load-unit": "lb" });
  await tap("#add-set");
  await tap('#draft-sets li:nth-child(2) [data-action="edit-set"]');
  assert.deepEqual(await values("exercise", "duration", "duration-unit", "load", "load-unit"), ["name:Farmer carry", "20", "m", "60", "kg"]);
  await set({ duration: "20.25" });
  await tap("#add-set");
  await tap("#add-set"); // Repeat without re-entering either measurement.
  await set({ "workout-date": "2000-01-01" }); // A later save with an earlier date is still shown second.
  await tap("#save-workout");
  await status("Workout saved");
  const next = (await overview()).workouts.find(workout => workout.id !== first.id)!;
  assert.deepEqual(next.sets.map(set => [set.duration, set.durationUnit, set.load, set.loadUnit]),
    [[5, "reps", 145, "lb"], [4, "reps", 60, "kg"], [20.25, "m", 60, "kg"], [3, "reps", 55, "kg"], [20.25, "m", 60, "kg"]]);

  await wait("document.querySelectorAll('#recent-workouts article').length === 2");
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#recent-workouts article')].map(card => card.dataset.workoutId)"),
    [first.id, next.id]);
  await tap(`${firstCard} [data-action='edit-workout']`);
  const editingReady = "document.querySelector('#workout-heading').textContent === 'Edit workout' && !document.querySelector('#workout-editor').disabled";
  await wait(editingReady);
  await browser.navigate("about:blank");
  await browser.navigate(base + gym);
  await wait("!document.querySelector('#workout-editor').disabled");
  await heading("Edit workout");
  await browser.evaluate("window.confirm = () => true");
  await tap("#reset-workout");
  await heading("Workouts");
  await wait(`!!document.querySelector(${JSON.stringify(firstCard)})`);
  await tap(`${firstCard} [data-action='edit-workout']`);
  await wait(editingReady);
  await tap('#draft-sets li:last-child [data-action="remove-set"]');
  await checkSetList("#draft-sets", [0.5]);
  assert.deepEqual(await draftLines(), [entryLines[2], entryLines[1]]);
  await tap("#save-workout");
  await status("Workout saved");
  await heading("Workouts");
  assert.deepEqual((await overview()).workouts.find(workout => workout.id === first.id)?.sets.map(set => set.duration), [4, 15.5]);
  await browser.evaluate("window.confirm = () => true");
  await tap(`${firstCard} [data-action='delete-workout']`);
  await status("Workout deleted");
  assert.deepEqual((await overview()).workouts.map(workout => workout.id), [next.id]);
  assert.equal((await fetch(`${base}/apps/gym/api/workouts/${first.id}`)).status, 404);

  await backToCoach();
  await wait("!document.querySelector('#card-header').hidden");
  const check = "SELECT duration, duration_unit, load, load_unit FROM sets ORDER BY position";
  faux.setResponses([fauxAssistantMessage(fauxToolCall("gym_query", { sql: check }), { stopReason: "toolUse" }), fauxAssistantMessage("Actual workout checked.")]);
  await compose(browser, "Read the saved workout.");
  await wait("[...document.querySelectorAll('.toolResult td')].some(el => el.textContent === '145')");
  await tap(`[data-branch='${root.id}']`);
  await waitFor(browser, "Main", value => value.title === "Main");
  assert.deepEqual(await browser.evaluate("[document.querySelector('#card-header').hidden, document.querySelectorAll('.toolResult table').length, document.body.className]"), [true, 0, ""]);
  assert.deepEqual(browser.errors, []);
});

test("Gym copies a recent workout as text without touching the draft", { skip: !chrome, timeout: 60_000 }, async t => {
  const host = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });
  const page = `http://127.0.0.1:${api.port}/apps/gym/`;
  const workout = { date: "2025-02-03", sets: [
    { exercise: "Squat", duration: 6, durationUnit: "reps", load: 62.5, loadUnit: "kg", extraReps: null },
    { exercise: "Plank", duration: 15.5, durationUnit: "sec", load: 0, loadUnit: "kg", extraReps: 3 },
    { exercise: "Farmer\ncarry", duration: 20, durationUnit: "m", load: null, loadUnit: null, extraReps: null },
  ] };
  const seeded = await fetch(page + "api/workouts/scratch", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(workout),
  });
  assert.equal(seeded.status, 200);

  const browser = await openBrowser(t);
  await browser.navigate(page);
  const copyButton = '#recent-workouts [data-action="copy-workout"]';
  await until(() => browser.evaluate(`!!document.querySelector(${JSON.stringify(copyButton)})`));
  await browser.evaluate(`
    const exercise = document.querySelector('#exercise');
    exercise.value = 'name:Squat';
    exercise.dispatchEvent(new Event('change'));
    window.copyPrompts = 0;
    window.confirm = () => { window.copyPrompts++; return false; };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText(text) {
        window.copiedText = text;
        return new Promise((resolve, reject) => { window.finishCopy = resolve; window.denyCopy = reject; });
      }
    } });
  `);
  await until(() => browser.evaluate("document.querySelector('#duration').value === '6'"));
  await browser.evaluate(`
    document.querySelector('#add-set').click();
    for (const [id, value] of [['workout-date', '2025-02-04'], ['duration', '9']]) {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `);
  const draft = () => browser.evaluate(`[
    localStorage.getItem('gym-draft'), document.querySelector('#workout-date').value,
    document.querySelector('#duration').value, document.querySelector('#draft-sets li').textContent
  ]`);
  const before = await draft();
  const status = () => browser.evaluate<string>(`document.querySelector('#recent-workouts [role="status"]').textContent`);
  const copy = () => browser.evaluate(click(copyButton));
  await copy();
  assert.equal(await browser.evaluate("window.copiedText"),
    "2025-02-03\n1. Squat · 6 reps · 62.5 kg\n2. Plank · 15.5 sec · 3 reps · 0 kg (bodyweight)\n3. Farmer carry · 20 m");
  assert.equal(await status(), "", "success must wait for the clipboard write");
  await browser.evaluate("window.finishCopy()");
  await until(status, text => text === "Workout copied to clipboard.");
  await copy();
  await browser.evaluate("window.denyCopy(new DOMException('Clipboard denied', 'NotAllowedError'))");
  await until(status, text => text.startsWith("Could not copy workout."));
  await browser.evaluate("Object.defineProperty(navigator, 'clipboard', { value: undefined })");
  await copy();
  assert.match(await status(), /^Clipboard unavailable\./);
  assert.deepEqual(await draft(), before);
  assert.equal(await browser.evaluate("window.copyPrompts"), 0);
  const overview = await (await fetch(page + "api/overview")).json();
  assert.deepEqual(overview.workouts, [{ id: "scratch", ...workout }]);
  assert.deepEqual(browser.errors, []);
});

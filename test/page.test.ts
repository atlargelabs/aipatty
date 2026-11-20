import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { startApi } from "../src/api.ts";
import { openHost, type AgentHost } from "../src/host.ts";
import { checkout, fauxConfig, fixture, until } from "./helpers.ts";

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
async function openBrowser(t: TestContext) {
  // Chrome's own directory, removed only after Chrome has exited: it writes to its profile until then.
  const profile = await mkdtemp(join(checkout, "node_modules", "aipatty-test-chrome-"));
  const child = spawn(chrome!, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
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
  const port = await until(async () => (await readFile(portFile, "utf8").catch(() => "")).split("\n")[0]);
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

test("clicking a branch in the page's list switches to it, and back", { skip: chrome ? false : "no Chrome found; set CHROME_PATH", timeout: 30_000 }, async t => {
  const dir = await fixture(t);
  const host = await openHost(fauxConfig(dir));
  const api = await startApi(host, health, "127.0.0.1", 0);
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

test("a click on another branch lands while the current branch is streaming", { skip: chrome ? false : "no Chrome found; set CHROME_PATH", timeout: 30_000 }, async t => {
  const host = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(host, health, "127.0.0.1", 0);
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

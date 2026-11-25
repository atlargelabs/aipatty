import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { startApi } from "../src/api.ts";
import { openHost } from "../src/host.ts";
import { operatorNotice, type ConversationPage } from "../src/protocol.ts";
import { upgradeRequest } from "../src/upgrade.ts";
import { backupDb, restoreDb, upgradeFiles, type Pending } from "../src/upgrade-supervisor.ts";
import { checkout, fauxConfig, fixture, until } from "./helpers.ts";

const timeout = 90_000;
const tailscaleOrigin = "https://mini.example.ts.net";

async function assertServeOrigin(port: number): Promise<void> {
  const status = await new Promise<number | undefined>((resolve, reject) => {
    get(`http://127.0.0.1:${port}/health`, {
      headers: { Host: new URL(tailscaleOrigin).host, Origin: tailscaleOrigin },
    }, res => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  assert.equal(status, 200);
}
const short = (sha: string) => sha.slice(0, 7);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  server.close();
  await once(server, "close");
  return port;
}

/**
 * A managed install of this checkout's source on the fake model: a local `origin` whose `main` is the first release,
 * `deploy/<sha>` cloned from it, and `deploy/current`. `npm ci` is replaced by a link to this checkout's dependencies.
 */
async function install(t: TestContext, originOption?: string) {
  // Not under node_modules, where Node will not run TypeScript.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aipatty-upgrade-")));
  const root = join(dir, "root"), origin = join(dir, "origin.git"), work = join(dir, "work"), bin = join(dir, "bin");
  const files = upgradeFiles(root);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), `#!/bin/sh\n[ -e install-fails ] && { echo "no such package" >&2; exit 1; }\nln -s "${checkout}/node_modules" node_modules\n`);
  chmodSync(join(bin, "npm"), 0o755);
  const env = { AIPATTY_FAUX: "1", PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME };

  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(dir, "init", "--quiet", "--initial-branch=main", work);
  git(work, "remote", "add", "origin", origin);
  cpSync(join(checkout, "src"), join(work, "src"), { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) cpSync(join(checkout, file), join(work, file));
  /** Change files of the source and push the result to `main`. */
  const commit = (changes: Record<string, string | ((text: string) => string)> = {}): string => {
    for (const [file, change] of Object.entries(changes)) {
      const path = join(work, file);
      writeFileSync(path, typeof change === "string" ? change : change(readFileSync(path, "utf8")));
    }
    git(work, "add", "--all");
    git(work, "commit", "--quiet", "--allow-empty", "-m", "release");
    git(work, "push", "--quiet", "origin", "HEAD:main");
    return git(work, "rev-parse", "HEAD");
  };
  /** Make `deploy/<sha>` as the runbook does by hand. */
  const stage = (sha: string) => {
    const release = join(files.deploy, sha);
    git(dir, "clone", "--quiet", origin, release);
    git(release, "checkout", "--quiet", "--detach", sha);
    symlinkSync(join(checkout, "node_modules"), join(release, "node_modules"));
  };
  const first = commit();
  mkdirSync(files.deploy, { recursive: true });
  stage(first);
  symlinkSync(first, files.current);

  const started: ChildProcess[] = [];
  /** Start `deploy/current` as the operator does. */
  const start = () => {
    const child = spawn(process.execPath, [
      join(files.current, "src/main.ts"), "--install-dir", root, "--port", String(port),
      ...(originOption ? ["--tailscale-origin", originOption] : []),
    ], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    started.push(child);
    return { child, output: () => output, exit: once(child, "exit").then(([code]) => code as number | null) };
  };
  const health = async (): Promise<{ commit: string; pid: number; problems: string[] } | undefined> => {
    try {
      return await (await fetch(`${base}/health`)).json() as { commit: string; pid: number; problems: string[] };
    } catch {
      return undefined;
    }
  };
  /** Wait for a server of `sha`, started by anyone. */
  const serving = (sha: string) => until(health, value => value?.commit === sha, 60_000) as Promise<{ commit: string; pid: number; problems: string[] }>;
  const send = (content: string) => fetch(`${base}/api/conversations/root/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }),
  });
  /** The root's transcript as `role: text` lines, upgrade entries included; empty while no server answers. */
  const lines = async (): Promise<string[]> => {
    const page = await fetch(`${base}/api/conversations/root`).then(response => response.json(), () => ({ entries: [] })) as ConversationPage;
    return page.entries.flatMap(entry => {
      const upgrade = operatorNotice(entry)?.text;
      const messages = (entry.model ?? []).flatMap(message => {
        const text = typeof message.content === "string" ? message.content
          : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
        return text ? [`${message.role}: ${text}`] : [];
      });
      return upgrade ? [`upgrade: ${upgrade}`, ...messages] : messages;
    });
  };
  /** Send a message and wait for the fake model's answer. */
  const say = async (content: string) => {
    const response = await send(content);
    assert.equal(response.status, 202, await response.text());
    await until(lines, value => value.includes(`assistant: Faux reply: ${content}`));
  };
  /** The upgrade line that starts with `prefix`, once it is in the transcript. */
  const reported = async (prefix: string) =>
    (await until(lines, value => value.some(line => line.startsWith(`upgrade: ${prefix}`)), 60_000))
      .find(line => line.startsWith(`upgrade: ${prefix}`))!;
  /** Stop the server that is listening, whoever started it, and wait until its data directory is free. */
  const stop = async () => {
    const running = await health();
    if (!running) return;
    process.kill(running.pid, "SIGTERM");
    await until(health, value => value === undefined);
    await until(() => {
      try {
        const lock = new DatabaseSync(join(root, "faux/owner.sqlite"), { timeout: 0 });
        try { lock.exec("BEGIN EXCLUSIVE"); return true; } catch { return false; } finally { lock.close(); }
      } catch { return false; }
    });
  };
  t.after(async () => {
    const running = await health();
    if (running) process.kill(running.pid, "SIGKILL");
    for (const child of started) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    root, files, port, first, commit, stage, start, health, serving, send, lines, say, reported, stop,
    current: () => basename(realpathSync(files.current)),
    db: join(root, "faux/aipatty.sqlite"),
  };
}

test("/upgrade moves to the latest main, keeps the conversation and reports in the branch", { timeout }, async t => {
  const f = await install(t, tailscaleOrigin);
  f.start();
  const before = await f.serving(f.first);
  assert.deepEqual(before.problems, []);
  await f.say("before the upgrade");

  // Nothing new on main: the same server keeps running.
  const cli = (...args: string[]) => execFileSync(process.execPath, [join(checkout, "src/cli.ts"), "--port", String(f.port), ...args], { env: {}, encoding: "utf8" });
  assert.match(cli("upgrade"), /^Upgrade started\./);
  assert.equal(await f.reported("Already"), `upgrade: Already up to date: ${short(f.first)} is the latest main.`);
  assert.equal((await f.health())?.pid, before.pid);

  const next = f.commit({ "NOTES.md": "The second release.\n" });
  assert.equal((await f.send(" /upgrade\n")).status, 202);
  const after = await f.serving(next);
  assert.notEqual(after.pid, before.pid);
  await assertServeOrigin(f.port);
  assert.equal(await f.reported("Upgrade complete"), `upgrade: Upgrade complete. Now running ${short(next)}; was ${short(f.first)}.`);
  assert.deepEqual((await f.lines()).slice(0, 2), ["user: before the upgrade", "assistant: Faux reply: before the upgrade"]);
  assert.equal(f.current(), next);
  assert.ok(!existsSync(f.files.pending));
  assert.ok(existsSync(f.files.backup));
  assert.match(cli("log"), new RegExp(`\nupgrade: Upgrade complete\\. Now running ${short(next)}`));
  await f.say("after the upgrade");
});

for (const [what, changes, reason] of [
  ["exits as it starts", { "src/main.ts": (text: string) => `throw new Error("broken release");\n${text}` }, /exited during startup \(1\)[^]*broken release/],
  ["fails its health check", { "src/config.ts": (text: string) => text.replace("dist/bundle/cli.js", "dist/bundle/gone.js") }, /Health check failed: Pi CLI: ENOENT/],
] as const) {
  test(`a new release that ${what} is rolled back to the old release and its database`, { timeout }, async t => {
    const f = await install(t, tailscaleOrigin);
    f.start();
    const before = await f.serving(f.first);
    await f.say("before the upgrade");
    const next = f.commit(changes);
    assert.equal((await f.send("/upgrade")).status, 202);

    const report = await f.reported("Upgrade to");
    assert.ok(report.startsWith(`upgrade: Upgrade to ${short(next)} failed and was rolled back. Running ${short(f.first)} again.`), report);
    assert.match(report, reason);
    const after = await f.serving(f.first);
    assert.notEqual(after.pid, before.pid);
    await assertServeOrigin(f.port);
    assert.equal(f.current(), f.first);
    assert.ok(!existsSync(f.files.pending));
    assert.deepEqual((await f.lines()).slice(0, 2), ["user: before the upgrade", "assistant: Faux reply: before the upgrade"]);
    await f.say("after the rollback");
  });
}

test("a release that cannot be installed leaves the running server alone and lets work resume", { timeout }, async t => {
  const f = await install(t);
  f.start();
  const before = await f.serving(f.first);
  const next = f.commit({ "install-fails": "" });
  assert.equal((await f.send("/upgrade")).status, 202);

  const report = await f.reported("Upgrade failed");
  assert.ok(report.startsWith(`upgrade: Upgrade failed before anything changed. Still running ${short(f.first)}.`), report);
  assert.match(report, /npm ci failed: no such package/);
  assert.equal((await f.health())?.pid, before.pid);
  assert.equal(f.current(), f.first);
  assert.ok(!existsSync(join(f.files.deploy, next)));
  // Messages are refused while the supervisor runs, and admitted again once it has ended.
  await until(async () => (await f.send("back to work")).status === 202);
});

test("a server that starts into an interrupted upgrade rolls it back", { timeout }, async t => {
  const f = await install(t);
  f.start();
  await f.serving(f.first);
  await f.say("before the upgrade");
  const { id: branch } = await (await fetch(`http://127.0.0.1:${f.port}/api/conversations/root`)).json() as { id: number };
  await f.stop();

  // What a supervisor leaves if it dies after the switch: the backup, the pending record and `current` on the new
  // release, whose database has since changed.
  const next = f.commit({ "NOTES.md": "The second release.\n" });
  f.stage(next);
  mkdirSync(f.files.dir);
  await backupDb(f.db, f.files.backup);
  f.start();
  await f.serving(f.first);
  await f.say("written by the new release");
  await f.stop();
  writeFileSync(f.files.pending, JSON.stringify({ old: f.first, new: next, branch, port: f.port } satisfies Pending));
  rmSync(f.files.current);
  symlinkSync(next, f.files.current);

  const started = f.start();
  assert.equal(await started.exit, 1);
  assert.match(started.output(), new RegExp(`An upgrade to ${next} was interrupted[^]*Rolled back to ${f.first}, which is now running`));
  await f.serving(f.first);
  assert.equal(f.current(), f.first);
  assert.ok(!existsSync(f.files.pending));
  const lines = await f.lines();
  assert.deepEqual(lines.slice(0, 2), ["user: before the upgrade", "assistant: Faux reply: before the upgrade"]);
  assert.ok(!lines.some(line => line.includes("written by the new release")), lines.join("\n"));
  assert.match(lines.at(-1)!, new RegExp(`^upgrade: Upgrade to ${short(next)} failed and was rolled back.*\\n.*interrupted`));
});

test("the backup holds what the write-ahead log committed, and a restore discards later writes", async t => {
  const dir = await fixture(t);
  const db = join(dir, "aipatty.sqlite"), copy = join(dir, "backup.sqlite");
  const rows = () => {
    const read = new DatabaseSync(db);
    try { return read.prepare("SELECT value FROM notes ORDER BY value").all().map(row => row.value); } finally { read.close(); }
  };
  const live = new DatabaseSync(db);
  live.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE notes (value TEXT); INSERT INTO notes VALUES ('kept')");
  await backupDb(db, copy);
  live.exec("INSERT INTO notes VALUES ('discarded')");
  assert.ok(existsSync(`${db}-wal`));
  // As after a server that was killed: its log is still beside the database.
  cpSync(`${db}-wal`, `${db}-wal.left`);
  live.close();
  cpSync(`${db}-wal.left`, `${db}-wal`);

  restoreDb(copy, db);
  assert.ok(!existsSync(`${db}-wal`));
  assert.deepEqual(rows(), ["kept"]);
});

test("/upgrade is refused outside a managed install and while any branch is busy", async t => {
  const config = fauxConfig(await fixture(t));
  const host = await openHost(config);
  const api = await startApi(host, { ok: true, commit: "test", startedAt: "now", version: "0" }, 0, {
    onUpgrade: upgradeRequest(host, config, checkout, () => api.port),
  });
  t.after(async () => { await api.close(); await host.harness.close(ctx); });
  const response = await fetch(`http://127.0.0.1:${api.port}/api/conversations/root/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "/upgrade" }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /managed install/);

  const root = (await host.conversation("root"))!;
  const busy = await host.submit(root, { type: "input", content: "hello" });
  await assert.rejects(host.reserveUpgrade(), /Wait for every branch to finish/);
  await busy.wait(ctx);
  await root.waitForIdle(ctx);
  const done = await host.reserveUpgrade();
  await assert.rejects(host.reserveUpgrade(), /already in progress/);
  await assert.rejects(host.submit(root, { type: "input", content: "during" }), /upgrade is in progress/);
  done();
  assert.equal((await (await host.submit(root, { type: "input", content: "after" })).wait(ctx)).status, "done");
});

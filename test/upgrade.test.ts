import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ConversationPage } from "../src/protocol.ts";
import { ownDataDir } from "../src/ownership.ts";
import { backupDb, restoreDb } from "../src/upgrade-db.ts";
import { upgradeEntryKind, UpgradePaths } from "../src/upgrade-state.ts";
import type { UpgradeHealth } from "../src/upgrade-process.ts";
import { checkout, until } from "./helpers.ts";

const exec = promisify(execFile);
const rootRoute = "/api/conversations/root";
const timeout = 60_000;
const legacyMain = `
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startApi } from "./api.ts";
import { readConfig } from "./config.ts";
import { openHost } from "./host.ts";

// The pre-upgrade startup and shutdown protocol. No journal guard, admission gate, or validation support.
const config = readConfig();
const health = { ok: true, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  startedAt: new Date().toISOString(), version: "legacy" };
const stop = Promise.withResolvers();
process.on("SIGTERM", stop.resolve);
process.on("SIGINT", stop.resolve);
const agent = await openHost(config);
const api = await startApi(agent, health, config.port, { onShutdown: stop.resolve });
await stop.promise;
await api.close();
await agent.close();
writeFileSync(join(process.env.UPGRADE_FIXTURE, "legacy-closed"), "closing complete");
while (existsSync(join(process.env.UPGRADE_FIXTURE, "hold-legacy-exit"))) await sleep(25);
`;

const npmFixture = `#!/usr/bin/env node
const { appendFileSync, existsSync, symlinkSync } = require("node:fs");
const { join } = require("node:path");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = process.env.UPGRADE_FIXTURE;
const args = process.argv.slice(2).join(" ");
appendFileSync(join(root, "npm.log"), args + "\\n");
(async () => {
  while (existsSync(join(root, "hold-stage"))) await sleep(25);
  if (args === "ci --ignore-scripts") symlinkSync(process.env.UPGRADE_FIXTURE_DEPS, "node_modules", "dir");
  else if (args === "run check" && existsSync(join(root, "fail-check"))) {
    console.error("fixture check failed");
    process.exitCode = 7;
  } else if (args !== "run check" && args !== "test") process.exitCode = 8;
})();
`;

const piFixture = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
writeFileSync(join(process.env.UPGRADE_FIXTURE, "pi-launched"), String(process.pid));
while (existsSync(join(process.env.UPGRADE_FIXTURE, "hold-pi"))) await sleep(25);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop",
  content: [{ type: "text", text: '<result>\\n{"summary":"Fixture Pi completed","issue":null,"pr":null,"remaining":[]}\\n</result>' }] } }));
console.log(JSON.stringify({ type: "agent_settled", aborted: false }));
`;

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

/** Real Git trees, clone/fetch, release scripts, shutdown/validation and SQLite. Only the origin and install tooling
 * are a fixture: no GitHub, live credentials, or nested npm test recursion. The shim records each required command
 * and links this test run's already installed deps. All process hooks below exist only in these scratch commits.
 */
async function fixture(t: TestContext, legacy = false) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "aipatty-upgrade-")));
  const root = join(scratch, "install root"), repo = join(scratch, "fixture-origin"), bin = join(scratch, "bin");
  const deps = await realpath(join(checkout, "node_modules"));
  const port = await unusedPort(), url = `http://127.0.0.1:${port}`;
  const paths = new UpgradePaths(root, join(root, "faux"));
  const children = new Set<ChildProcess>();
  const commits = new Set<string>();
  t.after(async () => {
    // Wake a fixture process held at a barrier even when a test fails. Don't signal by PID from /health.
    for (const name of ["hold-stage", "hold-pi", "hold-legacy-exit", "hold-probe"]) await rm(join(scratch, name), { force: true });
    for (const child of children) child.kill("SIGTERM");
    // Successful cutover's child belongs to the one-shot helper, not this test. Use the local graceful protocol.
    await until(async () => {
      const health = await healthNow();
      if (health?.validation) return false;
      if (!health) {
        const j = paths.load();
        if (j?.phase === "staging" || j?.phase === "stopping" || j?.phase === "switching") return false;
        try { ownDataDir(paths.data)(); return true; } catch { return false; }
      }
      if (!health.commit || !commits.has(health.commit)) return false;
      await fetch(url + "/api/shutdown", { method: "POST", headers: { "X-Aipatty-Shutdown": "1" }, signal: AbortSignal.timeout(1_000) }).catch(() => {});
      return false;
    }, Boolean, 3_000).catch(() => {});
    for (const child of children) child.kill("SIGKILL");
    await rm(scratch, { recursive: true, force: true });
  });
  for (const dir of [paths.deploy, paths.data, join(root, "pi"), join(root, "work"), join(root, "runs"), repo, bin]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: scratch, AIPATTY_FAUX: "1", UPGRADE_FIXTURE: scratch,
    UPGRADE_FIXTURE_DEPS: deps, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C",
  };
  const git = (...args: string[]) => exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, env });
  await git("init", "--quiet", "--initial-branch=main");
  await cp(join(checkout, "src"), join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" }));
  await writeFile(join(repo, ".gitignore"), "/node_modules\n");
  await writeFile(join(repo, "fixture-pi.mjs"), piFixture);
  await writeFile(join(bin, "npm"), npmFixture, { mode: 0o700 });
  const configPath = join(repo, "src/config.ts");
  const config = (await readFile(configPath, "utf8"))
    .replace('"git@github.com:atlargelabs/aipatty.git"', JSON.stringify(repo))
    .replace('join(release, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")', 'join(release, "fixture-pi.mjs")');
  await writeFile(configPath, config);
  const processPath = join(repo, "src/upgrade-process.ts");
  const processCode = await readFile(processPath, "utf8");
  const probeStart = "  const deadline = Date.now() + startupMs;";
  assert.ok(processCode.includes(probeStart));
  await writeFile(processPath, processCode.replace(probeStart, `
  if (gated && sha === j.target) {
    const { existsSync, writeFileSync } = await import("node:fs");
    const directory = process.env.UPGRADE_FIXTURE!;
    writeFileSync(join(directory, "helper.pid"), String(process.pid));
    while (existsSync(join(directory, "hold-probe"))) await sleep(25);
  }
${probeStart}`));
  const mainPath = join(repo, "src/main.ts");
  const modernMain = await readFile(mainPath, "utf8");
  if (legacy) await writeFile(mainPath, legacyMain);
  async function commit(label: string) {
    await writeFile(join(repo, "label"), label);
    await git("add", "--all");
    await git("commit", "--quiet", "-m", label);
    const sha = (await git("rev-parse", "HEAD")).stdout.trim();
    commits.add(sha);
    return sha;
  }
  const old = await commit("old");
  async function install(sha: string, depsInstalled = false) {
    const path = paths.release(sha);
    await git("clone", "--quiet", "--no-hardlinks", repo, path);
    await git("-C", path, "checkout", "--quiet", "--detach", sha);
    if (depsInstalled) await symlink(deps, join(path, "node_modules"), "dir");
    return path;
  }
  await install(old, true);
  await symlink(old, paths.current, "dir");
  async function next(label: string, transform?: (code: string) => string) {
    await writeFile(mainPath, transform ? transform(modernMain) : modernMain);
    return commit(label);
  }
  const flags = ["--install-dir", root, "--port", String(port)];
  const hostFile = (release: string) => join(release, "src/main.ts");
  function launch(sha = old, ...extra: string[]) {
    const entry = hostFile(legacy && sha === old ? paths.current : paths.release(sha));
    const child = spawn(process.execPath, [entry, ...flags, ...extra], {
      cwd: paths.release(sha), env, stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let output = "";
    child.stdout?.on("data", chunk => { output += chunk; });
    child.stderr?.on("data", chunk => { output += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => { children.delete(child); resolve(code); });
    });
    return { child, exited, output: () => output };
  }
  const supervisor = (sha: string, mode: "bootstrap" | "recover") => {
    const cwd = paths.release(sha);
    return exec(process.execPath, [join(cwd, "src/upgrade-supervisor.ts"), mode, ...flags], { cwd, env, timeout: 35_000 });
  };
  const cli = (...args: string[]) => exec(process.execPath, [join(checkout, "src/cli.ts"), "--port", String(port), ...args], { env, timeout: 10_000 });
  async function healthNow() {
    try {
      const response = await fetch(url + "/health", { signal: AbortSignal.timeout(1_000) });
      return response.ok ? await response.json() as UpgradeHealth : undefined;
    } catch { return undefined; }
  }
  const health = async (sha: string, validating = false) => {
    try { return await until(healthNow, h => h?.commit === sha && !!h.validation === validating, 12_000); }
    catch (error) {
      const j = paths.load();
      const log = j && await readFile(paths.log(j.id), "utf8").catch(() => "");
      throw new Error(`No expected health for ${sha}, validating=${validating}: ${JSON.stringify(j)}\n${log ?? ""}`, { cause: error });
    }
  };
  const request = (route: string, init?: RequestInit) => fetch(url + route, { ...init, signal: AbortSignal.timeout(3_000) });
  const send = (content: string, branch: number | "root" = "root", opt: { marker?: string; requestId?: string; origin?: string } = {}) =>
    request(`/api/conversations/${branch}/messages`, { method: "POST", headers: {
      "Content-Type": "application/json", ...(opt.marker ? { "X-Aipatty-Upgrade": opt.marker } : {}),
      ...(opt.origin ? { Origin: opt.origin } : {}),
    }, body: JSON.stringify({ content, requestId: opt.requestId ?? randomUUID() }) });
  const fork = async () => {
    const response = await request(rootRoute + "/fork", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Upgrade branch" }) });
    assert.equal(response.status, 201);
    return (await response.json() as { id: number }).id;
  };
  async function entries(branch: number | "root" = "root") {
    try {
      const response = await request(`/api/conversations/${branch}`);
      if (response.ok) return ((await response.json()) as ConversationPage).entries;
    } catch { /* server closed between probes */ }
    return [];
  }
  const result = (id: string, branch: number | "root" = "root") => until(async () => (await entries(branch))
    .filter(entry => entry.kind === upgradeEntryKind && JSON.stringify(entry.data).includes(id)
      && JSON.stringify(entry.data).includes('"type":"result"')), values => values.length > 0, 14_000);
  const flag = (name: string) => writeFile(join(scratch, name), "");
  const unflag = (name: string) => rm(join(scratch, name), { force: true });
  const log = (id: string) => readFile(paths.log(id), "utf8");
  return { scratch, paths, repo, port, url, old, git, launch, health, healthNow, next, install,
    supervisor, cli, request, send, fork, entries, result, flag, unflag, log };
}

test("first bootstrap uses legacy shutdown, waits for exit beyond the ACK and preserves the DB without a fabricated branch", { timeout }, async t => {
  const f = await fixture(t, true);
  const legacy = f.launch();
  const oldHealth = await f.health(f.old);
  assert.equal(oldHealth?.upgradeProtocol, undefined);
  await f.cli("send", "before first bootstrap");
  const target = await f.next("first one-shot release");
  await f.install(target);
  await f.flag("hold-legacy-exit");
  const upgrading = f.supervisor(target, "bootstrap");
  void upgrading.catch(() => {});
  await Promise.race([until(() => existsSync(join(f.scratch, "legacy-closed"))), upgrading.then(() => { throw new Error("Helper returned before legacy exit"); })]);
  assert.equal(await f.healthNow(), undefined);
  assert.equal(f.paths.selected(), f.old); // HTTP has closed and the DB owner lock is free, but the legacy process is still alive.
  assert.equal(legacy.child.exitCode, null);
  assert.equal(f.paths.load()?.phase, "stopping");
  await f.unflag("hold-legacy-exit");
  const result = await upgrading;
  assert.equal(await legacy.exited, 0, legacy.output());
  assert.match(result.stdout, new RegExp(`Active SHA: ${target}`));
  await f.health(target);
  assert.match((await f.cli("log")).stdout, /Faux reply: before first bootstrap/);
  assert.equal(f.paths.load()?.branch, undefined);
  assert.equal((await f.entries()).filter(entry => entry.kind === upgradeEntryKind).length, 0);
  const j = f.paths.load()!;
  assert.ok(existsSync(f.paths.backup(j.id)));
  assert.match(await f.log(j.id), /npm ci --ignore-scripts[\s\S]+npm run check[\s\S]+npm test/);
});

test("command is explicit, serialized across branches, survives cutover and delivers once even if the ack is lost", { timeout }, async t => {
  const f = await fixture(t);
  const old = f.launch();
  await f.health(f.old);
  const branch = await f.fork();
  await f.cli("--branch", String(branch), "send", "history stays in this branch");
  await f.cli("send", "mention /upgrade in ordinary conversation");
  const untrusted = await f.send("/upgrade");
  assert.equal(untrusted.status, 403);
  assert.equal((await f.send("/upgrade", branch, { marker: "1", origin: "http://foreign.invalid" })).status, 403);
  assert.equal((await f.send("please upgrade", branch, { marker: "1" })).status, 400);
  assert.equal((await f.request(rootRoute + "/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Aipatty-Upgrade": "1" },
    body: JSON.stringify({ content: "/upgrade", requestId: randomUUID(), target: "unreviewed" }),
  })).status, 400);
  assert.equal(f.paths.load(), undefined);
  const sha = await f.next("new main");
  await f.flag("hold-stage");
  await f.flag("hold-probe");
  const response = await f.cli("--branch", String(branch), "send", "/upgrade");
  const { id, requestKey } = f.paths.load()!;
  assert.match(response.stdout, new RegExp(id));
  assert.equal(f.paths.load()?.branch, branch);
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 409);
  assert.equal((await f.send('call pi {"task":"not admitted","pr":false}')).status, 409);
  assert.equal((await f.healthNow())?.pid, old.child.pid);
  assert.ok((await f.entries(branch)).some(entry => entry.kind === upgradeEntryKind));
  await f.unflag("hold-stage");
  const validation = await f.health(sha, true);
  assert.equal(validation?.validation?.ready, true);
  assert.equal((await f.send("must not run before commit", branch)).status, 503);
  assert.equal((await f.request("/api/shutdown", { method: "POST", headers: { "X-Aipatty-Shutdown": "1" } })).status, 503);
  await f.unflag("hold-probe");
  await f.health(sha);
  assert.equal(await old.exited, 0, old.output());
  const [report] = await f.result(id, branch);
  assert.match(JSON.stringify(report.data), new RegExp(`Active SHA: ${sha}`));
  assert.equal(report.model, undefined);
  assert.equal((await f.entries()).filter(entry => entry.kind === upgradeEntryKind).length, 0);
  const beforeRestart = (await f.cli("--branch", String(branch), "log")).stdout;
  assert.match(beforeRestart, /Faux reply: history stays in this branch/);
  assert.match(beforeRestart, /aipatty: Upgrade complete/);
  await f.cli("shutdown");
  await until(f.healthNow, h => !h);
  const release = await until(() => { try { return ownDataDir(f.paths.data); } catch { return; } });
  release!();
  // The Durable entry/marker transaction succeeded, but simulate a crash before the journal ack was durable.
  f.paths.save({ ...f.paths.load()!, reported: undefined });
  f.launch(sha);
  await f.health(sha);
  assert.equal((await f.cli("--branch", String(branch), "log")).stdout, beforeRestart);
  assert.equal(f.paths.load()?.reported, true);
  const replay = await f.send("/upgrade", branch, { marker: "1", requestId: requestKey });
  assert.deepEqual(await replay.json(), { upgradeId: id });
  assert.equal(f.paths.load()?.id, id);
  assert.equal((await f.result(id, branch)).length, 1);
  assert.equal((await f.cli("--branch", String(branch), "send", "after upgrade")).stdout.trim(), "Faux reply: after upgrade");
});

test("Pi busy is refused; a no-op or failed stage leaves the same process serving and reopens admission", { timeout }, async t => {
  const f = await fixture(t);
  const old = f.launch();
  await f.health(f.old);
  const branch = await f.fork();
  await f.flag("hold-pi");
  assert.equal((await f.send('call pi {"task":"wait","pr":false}', branch)).status, 202);
  await until(() => existsSync(f.paths.piRun) && existsSync(join(f.scratch, "pi-launched")));
  const refused = await f.send("/upgrade", "root", { marker: "1" });
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /Pi run.*active/);
  assert.equal(f.paths.load(), undefined);
  await f.unflag("hold-pi");
  await until(async () => (await f.entries(branch)).some(e => JSON.stringify(e.model ?? []).includes("Fixture Pi completed")) && !existsSync(f.paths.piRun));
  await until(async () => {
    const res = await f.send("/upgrade", "root", { marker: "1" });
    return res.status === 202;
  });
  const first = f.paths.load()!;
  assert.match(JSON.stringify((await f.result(first.id))[0].data), /Upgrade not needed/, await f.log(first.id));
  assert.equal((await f.healthNow())?.pid, old.child.pid);
  assert.equal(existsSync(f.paths.backup(first.id)), false);
  await f.next("stage will fail check");
  await f.flag("fail-check");
  await f.flag("hold-stage");
  const racing = await Promise.all([f.send("/upgrade", "root", { marker: "1" }), f.send("/upgrade", branch, { marker: "1" })]);
  assert.deepEqual(racing.map(response => response.status).sort(), [202, 409]);
  const failed = f.paths.load()!;
  await f.unflag("hold-stage");
  assert.match(JSON.stringify((await f.result(failed.id, failed.branch!))[0].data), /failed before cutover/);
  assert.match(await f.log(failed.id), /fixture check failed/);
  assert.equal((await f.healthNow())?.pid, old.child.pid);
  assert.equal(f.paths.selected(), f.old);
  assert.equal((await f.cli("send", 'call pi {"task":"after failed stage","pr":false}')).stdout.includes("Fixture Pi completed"), true);
});

test("bootstrap rejects Pi records, non-main and dirty/ignored input before touching a legacy host", { timeout }, async t => {
  const f = await fixture(t, true);
  const old = f.launch();
  await f.health(f.old);
  const main = await f.next("real main");
  await f.install(main);
  await writeFile(f.paths.piRun, "keep-me");
  await assert.rejects(f.supervisor(main, "bootstrap"), /Pi run or recovery is present/);
  assert.equal(await readFile(f.paths.piRun, "utf8"), "keep-me");
  await rm(f.paths.piRun);
  await f.git("switch", "--quiet", "-c", "unmerged-work");
  const other = await f.next("unmerged not for deploy");
  await f.install(other);
  await f.git("switch", "--quiet", "main");
  await assert.rejects(f.supervisor(other, "bootstrap"), /Bootstrap must be the fetched main tip/);
  await writeFile(join(f.paths.release(main), "label"), "dirty");
  await assert.rejects(f.supervisor(main, "bootstrap"), /Dirty release/);
  await f.git("-C", f.paths.release(main), "checkout", "--", "label");
  await mkdir(join(f.paths.release(main), "node_modules"));
  await writeFile(join(f.paths.release(main), "node_modules/forged"), "ignored but not in main");
  await assert.rejects(f.supervisor(main, "bootstrap"), /not an exact clean main tree/);
  assert.equal(old.child.exitCode, null);
  assert.ok(await f.health(f.old));
  assert.equal(f.paths.selected(), f.old);
});

test("HTTP 200 without branch readiness is rolled back with the old DB and result in that branch", { timeout }, async t => {
  const f = await fixture(t);
  f.launch();
  await f.health(f.old);
  const branch = await f.fork();
  await f.cli("--branch", String(branch), "send", "keep this history");
  const target = await f.next("candidate unable to run the branch", code => code.replace("      const api = await startApi", `
      if (childId) {
        const { DatabaseSync } = await import("node:sqlite");
        const database = new DatabaseSync(config.dataDir + "/aipatty.sqlite");
        database.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE candidate_only (test TEXT); INSERT INTO candidate_only VALUES ('must not survive')");
        health.validation = { id: childId, ready: false, reason: "fixture requesting branch unavailable" };
      }
      const api = await startApi`));
  await f.flag("hold-probe");
  assert.equal((await f.send("/upgrade", branch, { marker: "1" })).status, 202);
  const id = f.paths.load()!.id;
  const unhealthy = await f.health(target, true);
  assert.equal(unhealthy?.ok, true);
  assert.equal(unhealthy?.modelStatus, "available");
  assert.equal(unhealthy?.validation?.ready, false);
  assert.ok(existsSync(f.paths.db + "-wal"));
  await f.unflag("hold-probe");
  await f.health(f.old);
  const [post] = await f.result(id, branch);
  assert.match(JSON.stringify(post.data), /rolled back.*fixture requesting branch unavailable/);
  assert.equal(f.paths.selected(), f.old);
  assert.equal(f.paths.load()?.result?.active, f.old);
  assert.match((await f.cli("--branch", String(branch), "log")).stdout, /Faux reply: keep this history/);
  using db = new DatabaseSync(f.paths.db, { readOnly: true });
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'candidate_only'").get(), undefined);
  assert.ok(existsSync(f.paths.backup(id)));
});

test("first bootstrap can roll back to a legacy app when the candidate serves the wrong SHA", { timeout }, async t => {
  const f = await fixture(t, true);
  const legacy = f.launch();
  await f.health(f.old);
  await f.cli("send", "legacy rollback keeps this history");
  const target = await f.next("wrong SHA while validating", code => code.replace("      const api = await startApi", `
      if (childId) health.commit = ${JSON.stringify("7".repeat(40))};
      const api = await startApi`));
  await f.install(target);
  await assert.rejects(f.supervisor(target, "bootstrap"), /Upgrade rolled back.*Readiness identity mismatch/s);
  assert.equal(await legacy.exited, 0, legacy.output());
  assert.equal((await f.health(f.old))?.upgradeProtocol, undefined);
  assert.equal(f.paths.selected(), f.old);
  assert.equal(f.paths.load()?.branch, undefined);
  assert.equal(f.paths.load()?.result?.active, f.old);
  assert.match((await f.cli("log")).stdout, /Faux reply: legacy rollback keeps this history/);
  assert.equal((await f.entries()).filter(entry => entry.kind === upgradeEntryKind).length, 0);
  // The staged script, not the restored legacy code, provides the guard on a later manual start.
  await f.cli("shutdown");
  await until(f.healthNow, h => !h);
  assert.match((await f.supervisor(target, "recover")).stdout, /Upgrade rolled back/);
});

test("an interrupted switch closes the gated candidate; startup refuses the uncertain DB until explicit repeatable recovery", { timeout }, async t => {
  const f = await fixture(t);
  f.launch();
  await f.health(f.old);
  const branch = await f.fork();
  await f.cli("--branch", String(branch), "send", "durable before interrupted cutover");
  const pinned = await f.next("pinned before interruption");
  await f.flag("hold-probe");
  assert.equal((await f.send("/upgrade", branch, { marker: "1" })).status, 202);
  await f.health(pinned, true);
  const j = f.paths.load()!;
  assert.equal(j.phase, "switching");
  assert.equal(j.target, pinned);
  const pidPath = join(f.scratch, "helper.pid");
  await until(() => existsSync(pidPath));
  // This PID is written by our injected fixture process while it waits at the test barrier.
  process.kill(Number(await readFile(pidPath, "utf8")), "SIGKILL");
  await until(f.healthNow, h => !h);
  const unguarded = f.launch(pinned);
  assert.equal(await unguarded.exited, 1, unguarded.output());
  assert.match(unguarded.output(), /Unfinished upgrade \(switching\)/);
  const backup = f.paths.backup(j.id), held = backup + ".held";
  await rename(backup, held);
  await assert.rejects(f.supervisor(pinned, "recover"), /Expected an owned regular file/);
  assert.equal(f.paths.load()?.phase, "restoring");
  assert.equal(f.paths.selected(), pinned);
  assert.match(await f.log(j.id), /RECOVERY FAILED/);
  assert.equal(await f.healthNow(), undefined);
  await rename(held, backup);
  const newMain = await f.next("unrelated newer main after interruption");
  const recovered = await f.supervisor(pinned, "recover");
  assert.match(recovered.stdout, new RegExp(`Active SHA: ${f.old}`));
  await f.health(f.old);
  assert.equal(f.paths.load()?.target, pinned);
  assert.notEqual(f.paths.selected(), newMain);
  assert.equal(f.paths.selected(), f.old);
  assert.equal((await f.result(j.id, branch)).length, 1);
  assert.match((await f.cli("--branch", String(branch), "log")).stdout, /Faux reply: durable before interrupted cutover/);
  assert.ok(existsSync(backup));
});

test("SQLite backup includes uncheckpointed committed WAL, and restore discards an abandoned candidate WAL", { timeout }, async t => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "aipatty-upgrade-wal-")));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const paths = new UpgradePaths(scratch, join(scratch, "data"));
  await mkdir(paths.data);
  paths.init();
  const walWrite = async (text: string) => {
    const script = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(paths.db)});
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS notes (text TEXT);");
      db.prepare("INSERT INTO notes VALUES (?)").run(${JSON.stringify(text)}); process.kill(process.pid, "SIGKILL");`;
    await assert.rejects(exec(process.execPath, ["-e", script]), (error: unknown) => (error as { signal?: string }).signal === "SIGKILL");
  };
  await walWrite("old committed WAL record");
  assert.ok(existsSync(paths.db + "-wal"));
  const id = randomUUID();
  let release = ownDataDir(paths.data);
  try { await backupDb(paths, id); } finally { release(); }
  await walWrite("candidate WAL record");
  assert.ok(existsSync(paths.db + "-wal"));
  release = ownDataDir(paths.data);
  try {
    restoreDb(paths, id);
    restoreDb(paths, id); // interrupted rollback can repeat until it records restored
    assert.equal(existsSync(paths.db + "-wal"), false);
    using db = new DatabaseSync(paths.db, { readOnly: true });
    assert.deepEqual(db.prepare("SELECT text FROM notes").all().map(row => row.text), ["old committed WAL record"]);
  } finally { release(); }
});

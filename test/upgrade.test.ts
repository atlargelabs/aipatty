import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { readConfig } from "../src/config.ts";
import type { ConversationPage } from "../src/protocol.ts";
import { ownDataDir } from "../src/ownership.ts";
import { RUN_MARKER } from "../src/processes.ts";
import { backupDb, restoreDb } from "../src/upgrade-db.ts";
import { committedValidation } from "../src/upgrade-host.ts";
import { finish, interruptedCutover, upgradeEntryKind, UpgradePaths, type UpgradeJournal } from "../src/upgrade-state.ts";
import { identify, type UpgradeHealth } from "../src/upgrade-process.ts";
import { checkout, until } from "./helpers.ts";

const exec = promisify(execFile);
const rootRoute = "/api/conversations/root";
const timeout = 60_000;
const legacyMain = `
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { readConfig } from "./config.ts";
import { openHost } from "./host.ts";

// Frozen subset of ea33846's public protocol and paths, independent of the candidate's API and root defaults.
// Open a real Durable database and owner lock; production legacy does not consult the upgrade journal.
const { values } = parseArgs({ options: { "install-dir": { type: "string" }, port: { type: "string" } } });
const root = values["install-dir"];
const port = values.port ?? "8790";
const config = readConfig(["--port", port, "--data-dir", join(root, process.env.AIPATTY_FAUX === "1" ? "faux" : "data"),
  "--pi-dir", join(root, "pi"), "--work-dir", join(root, "work"), "--runs-dir", join(root, "runs")]);
const health = { ok: true, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  startedAt: new Date().toISOString(), version: "legacy" };
const stop = Promise.withResolvers();
process.on("SIGTERM", stop.resolve);
process.on("SIGINT", stop.resolve);
const agent = await openHost(config);
const conversation = await agent.conversation("root");
const api = createServer((req, res) => {
  const json = (status, data) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  void (async () => {
    if (req.method === "GET" && req.url === "/health") return json(200, { ...health, ...await agent.modelStatus() });
    if (req.method === "GET" && req.url === "/api/branches") return json(200, await agent.branches());
    if (req.method === "POST" && req.url === "/api/shutdown") {
      if (req.headers["x-aipatty-shutdown"] !== "1") return json(403, { error: "Expected x-aipatty-shutdown: 1" });
      res.shouldKeepAlive = false;
      res.once("finish", stop.resolve);
      return json(202, { status: "shutdown-requested" });
    }
    if (req.method === "POST" && req.url === "/api/conversations/root/messages") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { content } = JSON.parse(body);
      if (typeof content !== "string" || !content.trim()) return json(400, { error: "Expected non-empty content" });
      const submission = await agent.submit(conversation, { type: "input", content });
      await submission.wait(ctx); // Wait here so the test can seed and settle old work without a stream.
      return json(202, { submissionId: submission.id });
    }
    if (req.method === "GET" && req.url === "/api/conversations/root") {
      const entries = await conversation.entries({}, 50, undefined, ctx);
      return json(200, { id: conversation.id, entries: entries.items.toReversed(), before: null });
    }
    return json(404, { error: "Not found" });
  })().catch(error => json(500, { error: String(error) }));
});
await new Promise(resolve => api.listen(Number(port), "127.0.0.1", resolve));
await stop.promise;
await new Promise(resolve => { api.close(resolve); api.closeAllConnections(); });
await agent.close();
writeFileSync(join(process.env.UPGRADE_FIXTURE, "legacy-closed"), "closing complete");
while (existsSync(join(process.env.UPGRADE_FIXTURE, "hold-legacy-exit"))) await sleep(25);
`;

const npmFixture = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = process.env.UPGRADE_FIXTURE;
const args = process.argv.slice(2).join(" ");
if (process.env.GIT_INDEX_FILE || process.env.GIT_DIR || process.env.GIT_WORK_TREE) {
  throw new Error("A staged npm command inherited the host's Git paths");
}
writeFileSync(join(root, "npm.pid"), String(process.pid));
appendFileSync(join(root, "npm.log"), args + "\\n");
(async () => {
  while (existsSync(join(root, "hold-stage"))) await sleep(25);
  if (args === "ci --ignore-scripts --include=dev") {
    mkdirSync("node_modules");
    for (const name of readdirSync(process.env.UPGRADE_FIXTURE_DEPS)) {
      if (name.startsWith("aipatty-test-")) continue;
      symlinkSync(join(process.env.UPGRADE_FIXTURE_DEPS, name), join("node_modules", name));
    }
  }
  else if (args === "run check" && existsSync(join(root, "fail-check"))) {
    console.error("fixture check failed");
    process.exitCode = 7;
  } else if (args === "test" && existsSync(join(root, "nest-test"))) {
    const child = spawn(process.execPath, ["--test", "--test-name-pattern=nested fixture starts a replacement", join(process.env.UPGRADE_FIXTURE_CHECKOUT, "test/upgrade.test.ts")], {
      env: { ...process.env, UPGRADE_NESTED_TEST: root }, stdio: "inherit",
    });
    process.exitCode = await new Promise(resolve => child.once("exit", code => resolve(code ?? 9)));
  } else if (args === "test" && existsSync(join(root, "hold-stage-child"))) {
    const failedTest = existsSync(join(root, "failed-test"));
    const child = spawn(process.execPath, ["-e", 'const path = process.argv[1]; const fs = require("node:fs"); '
      + 'const timer = setInterval(() => { if (!fs.existsSync(path)) clearInterval(timer); }, 25); '
      + 'setTimeout(() => clearInterval(timer), 30_000).unref();', join(root, "hold-stage-child")],
      { stdio: "ignore", detached: failedTest });
    child.unref();
    writeFileSync(join(root, "stage-child.pid"), String(child.pid));
    if (failedTest) process.exitCode = 7;
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

const barriers = ["quiescent", "selected", "handoff", "ack-retirement", "ack-result", "publication", "backup"] as const;
function pauseAt(name: typeof barriers[number]): string {
  return `{
    const { existsSync, writeFileSync } = await import("node:fs");
    const { setTimeout: delay } = await import("node:timers/promises");
    const hold = process.env.UPGRADE_FIXTURE + "/hold-${name}";
    if (existsSync(hold)) {
      writeFileSync(hold + ".entered", "");
      while (existsSync(hold)) await delay(25);
    }
  }`;
}

/** Real Git trees, clone/fetch, release scripts, shutdown/validation and SQLite. Only the origin and install tooling
 * are a fixture: no GitHub, live credentials, or nested npm test recursion. The shim records each required command
 * and links this test run's already installed deps. All process hooks below exist only in these scratch commits.
 */
async function fixture(t: TestContext, legacy = false, hostHasGitPaths = false) {
  const scratch = await realpath(await mkdtemp(join(process.env.UPGRADE_NESTED_TEST ?? tmpdir(), "aipatty-upgrade-")));
  const root = join(scratch, "install root"), repo = join(scratch, "fixture-origin"), bin = join(scratch, "bin");
  const deps = await realpath(join(checkout, "node_modules"));
  const port = await unusedPort(), url = `http://127.0.0.1:${port}`;
  const paths = new UpgradePaths(root, join(root, "faux"));
  const children = new Set<ChildProcess>();
  const commits = new Set<string>();
  t.after(async () => {
    // Wake a fixture process held at a barrier even when a test fails. Don't signal by PID from /health.
    for (const name of ["hold-stage", "hold-stage-child", "hold-pi", "hold-legacy-exit", "hold-probe", "hold-legacy-probe",
      ...barriers.map(name => `hold-${name}`)]) {
      await rm(join(scratch, name), { force: true });
    }
    await writeFile(join(scratch, "let-nested-finish"), "");
    for (const child of children) child.kill("SIGTERM");
    // Successful cutover's child belongs to the one-shot helper, not this test. Use the local graceful protocol.
    try {
      await until(async () => {
        const health = await healthNow();
        if (health?.validation) return false;
        if (health) {
          if (!health.commit || !commits.has(health.commit)) return false;
          await fetch(url + "/api/shutdown", { method: "POST", headers: { "X-Aipatty-Shutdown": "1" }, signal: AbortSignal.timeout(1_000) }).catch(() => {});
          return false;
        }
        if (children.size) return false;
        // Confirm even the helper-launched processes, which aren't this test's ChildProcess handles, have exited.
        const { stdout } = await exec("ps", ["-A", "-ww", "-o", "stat=,command="], { timeout: 2_000 });
        if (stdout.split("\n").some(line => !line.trimStart().startsWith("Z") && line.includes(scratch)
          && /\/src\/(main|upgrade-supervisor)\.ts |\/bin\/npm |\/hold-stage-child$/.test(line))) return false;
        let unlock: (() => void) | undefined;
        try {
          unlock = paths.lease();
          const j = paths.load();
          if (j?.phase === "staging") paths.stagingLease(j.id)();
          ownDataDir(paths.data)();
          return true;
        } catch { return false; }
        finally { unlock?.(); }
      }, Boolean, 15_000);
    } catch (error) { throw new Error(`Fixture still has a possible writer; preserved ${scratch}`, { cause: error }); }
    await rm(scratch, { recursive: true, force: true });
  });
  for (const dir of [paths.deploy, paths.data, join(root, "pi"), join(root, "work"), join(root, "runs"), repo, bin]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const env = {
    ...(process.env[RUN_MARKER] ? { [RUN_MARKER]: process.env[RUN_MARKER] } : {}),
    PATH: `${bin}:${process.env.PATH}`, HOME: scratch, NODE_ENV: "production", AIPATTY_FAUX: "1", UPGRADE_FIXTURE: scratch,
    UPGRADE_FIXTURE_CHECKOUT: checkout, UPGRADE_FIXTURE_DEPS: deps, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C",
  };
  const git = (...args: string[]) => exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, env });
  await git("init", "--quiet", "--initial-branch=main");
  await cp(join(checkout, "src"), join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" }));
  await writeFile(join(repo, ".gitignore"), "/node_modules\n");
  await writeFile(join(repo, "fixture-pi.mjs"), piFixture);
  await writeFile(join(bin, "npm"), npmFixture, { mode: 0o700 });
  await writeFile(join(bin, "lsof"), `#!/bin/sh
if [ -e "$UPGRADE_FIXTURE/fail-lsof" ]; then
  echo 'fixture lsof diagnostic' >&2
  exit 1
fi
exec /usr/sbin/lsof "$@"
`, { mode: 0o700 });
  const configPath = join(repo, "src/config.ts");
  const config = (await readFile(configPath, "utf8"))
    .replace('"git@github.com:atlargelabs/aipatty.git"', JSON.stringify(repo))
    .replace('join(release, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")', 'join(release, "fixture-pi.mjs")');
  await writeFile(configPath, config);
  const processPath = join(repo, "src/upgrade-process.ts");
  const processCode = await readFile(processPath, "utf8");
  const probeStart = "  const deadline = Date.now() + startupMs;";
  const legacyBranches = '    const branches = await call("/api/branches");';
  assert.ok(processCode.includes(probeStart) && processCode.includes(legacyBranches));
  const tcpFile = 'requiredProcEntry("/proc/net/tcp",';
  assert.ok(processCode.includes(tcpFile));
  await writeFile(processPath, processCode
    .replace("closeSync, constants, openSync", "closeSync, constants, existsSync, openSync, writeFileSync")
    .replace(tcpFile, `requiredProcEntry(existsSync(join(process.env.UPGRADE_FIXTURE!, "fail-proc-net-tcp"))
      ? join(process.env.UPGRADE_FIXTURE!, "missing-proc-net-tcp") : "/proc/net/tcp",`)
    .replace('command("/usr/sbin/lsof",', 'command(join(process.env.UPGRADE_FIXTURE!, "bin", "lsof"),')
    .replace(legacyBranches, `${legacyBranches}
    const directory = process.env.UPGRADE_FIXTURE!;
    if (existsSync(join(directory, "hold-legacy-probe"))) {
      writeFileSync(join(directory, "legacy-probe-started"), "");
      while (existsSync(join(directory, "hold-legacy-probe"))) await sleep(25);
    }`)
    .replace(probeStart, `
  if (gated && sha === j.target) {
    const directory = process.env.UPGRADE_FIXTURE!;
    writeFileSync(join(directory, "helper.pid"), String(process.pid));
    while (existsSync(join(directory, "hold-probe"))) await sleep(25);
  }
${probeStart}`));
  const supervisorPath = join(repo, "src/upgrade-supervisor.ts");
  const supervisorCode = await readFile(supervisorPath, "utf8");
  const afterQuiescent = /const free = await quiescent\(paths, current\.port, [^\n]+\n    try \{/;
  const verifiedSelected = "  await verifyRelease(paths.release(sha), sha);";
  assert.match(supervisorCode, afterQuiescent);
  assert.ok(supervisorCode.includes(verifiedSelected));
  const prepareStart = "  let target: string | undefined, result:";
  const sendCompletion = "  await sendParent({ id, ...result });";
  assert.ok(supervisorCode.includes(prepareStart) && supervisorCode.includes(sendCompletion));
  await writeFile(supervisorPath, supervisorCode
    .replace("realpathSync, rmSync, writeSync", "realpathSync, rmSync, writeSync, writeFileSync, existsSync")
    .replace(prepareStart, `  writeFileSync(join(process.env.UPGRADE_FIXTURE!, "coordinator.pid"), String(process.pid));
  writeFileSync(join(process.env.UPGRADE_FIXTURE!, "worker.pid"), String(child.pid));
${prepareStart}`)
    .replace(sendCompletion, `  if (existsSync(join(process.env.UPGRADE_FIXTURE!, "omit-stage-result"))) return;
${sendCompletion}`)
    .replace(afterQuiescent, match => `${match}\n${pauseAt("quiescent")}`)
    .replace(verifiedSelected, `${verifiedSelected}\n${pauseAt("selected")}`));
  const releasePath = join(repo, "src/upgrade-release.ts");
  const dbPath = join(repo, "src/upgrade-db.ts");
  for (const [path, line, barrier] of [
    [releasePath, "    syncTree(copy);", "publication"], [dbPath, "    syncPath(temp);", "backup"],
  ] as const) {
    const code = await readFile(path, "utf8");
    assert.ok(code.includes(line));
    await writeFile(path, code.replace(line, `${line}\n${pauseAt(barrier)}`));
  }
  const upgradeHostPath = join(repo, "src/upgrade-host.ts");
  const upgradeHostCode = await readFile(upgradeHostPath, "utf8");
  const reportStart = '  if (j.phase !== "done" || j.branch === undefined || j.reported) return j;';
  const saveRequest = "try { paths.save(request); }";
  const startHelper = '      const log = openUpgradeLog(paths, id);\n      try {';
  const retireAck = "    return ack({", resultAck = "  return ack();";
  for (const line of [reportStart, saveRequest, startHelper, retireAck, resultAck]) assert.ok(upgradeHostCode.includes(line));
  await writeFile(upgradeHostPath, upgradeHostCode.replace(reportStart, `${reportStart}
  const { existsSync } = await import("node:fs");
  if (existsSync(join(process.env.UPGRADE_FIXTURE!, "fail-report"))) throw new Error("fixture transcript write failed");
`).replace(saveRequest, `try {
  const { existsSync } = await import("node:fs");
  if (existsSync(join(process.env.UPGRADE_FIXTURE!, "fail-journal-write"))) throw new Error("fixture journal write failed before rename");
  paths.save(request);
}`).replace(retireAck, `${pauseAt("ack-retirement")}\n${retireAck}`)
  .replace(resultAck, `${pauseAt("ack-result")}\n${resultAck}`).replace(startHelper, `
      ${pauseAt("handoff")}
      const { existsSync } = await import("node:fs");
      if (existsSync(join(process.env.UPGRADE_FIXTURE!, "fail-start-helper"))) throw new Error("fixture log failed to open");
${startHelper}`));
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
      cwd: paths.release(sha), env: { ...env, ...(hostHasGitPaths ? {
        GIT_INDEX_FILE: join(scratch, "host-index"), GIT_DIR: join(paths.release(old), ".git"), GIT_WORK_TREE: paths.release(old),
      } : {}) }, stdio: ["ignore", "pipe", "pipe"],
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
  const supervisor = (sha: string, mode: "bootstrap" | "recover", ...options: string[]) => {
    const cwd = paths.release(sha);
    const nodeArgs = existsSync(join(scratch, "loose-stage-umask")) ? ["--import=data:text/javascript,process.umask(0o002)"] : [];
    return exec(process.execPath, [...nodeArgs, join(cwd, "src/upgrade-supervisor.ts"), mode, ...flags, ...options], { cwd, env, timeout: 35_000 });
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
    }, body: JSON.stringify({ ...(opt.marker ? { command: content } : { content }), requestId: opt.requestId ?? randomUUID() }) });
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
  const pause = async (name: typeof barriers[number]) => {
    const hold = `hold-${name}`;
    await flag(hold);
    return {
      entered: () => until(() => existsSync(join(scratch, `${hold}.entered`))),
      resume: async () => { await unflag(hold); await unflag(`${hold}.entered`); },
    };
  };
  return { scratch, paths, repo, port, url, old, git, launch, health, healthNow, next, install,
    supervisor, cli, request, send, fork, entries, result, flag, unflag, log, pause };
}

test("first bootstrap uses legacy shutdown, waits for exit beyond the ACK and preserves the DB without a fabricated branch", { timeout }, async t => {
  const f = await fixture(t, true);
  const legacy = f.launch();
  const oldHealth = await f.health(f.old);
  assert.equal(oldHealth?.upgradeProtocol, undefined);
  assert.equal((await f.send("before first bootstrap")).status, 202);
  await assert.rejects(f.cli("send", "/upgrade"), /does not support \/upgrade/);
  // Even if a legacy server replaced a modern one after the client's health check, the command body is not input.
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 400);
  assert.ok(!(await f.cli("log")).stdout.includes("/upgrade"));
  const target = await f.next("first one-shot release");
  await f.install(target);
  await f.flag("loose-stage-umask"); // The stage worker must protect Git and dependency files despite the inherited umask.
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
  assert.match(await f.log(j.id), /npm ci --ignore-scripts --include=dev[\s\S]+npm run check[\s\S]+npm test/);
});

test("command is explicit, serialized across branches, survives cutover and delivers once even if the ack is lost", { timeout }, async t => {
  const f = await fixture(t, false, true);
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
    body: JSON.stringify({ command: "/upgrade", requestId: randomUUID(), target: "unreviewed" }),
  })).status, 400);
  assert.equal(f.paths.load(), undefined);
  const sha = await f.next("new main");
  await f.flag("hold-stage");
  await f.flag("hold-probe");
  const response = await f.cli("--branch", String(branch), "send", "/upgrade");
  const { id, requestKey } = f.paths.load()!;
  assert.match(response.stdout, new RegExp(id));
  assert.equal(f.paths.load()?.branch, branch);
  const inFlightRetry = await f.send("/upgrade", branch, { marker: "1", requestId: requestKey });
  assert.equal(inFlightRetry.status, 202);
  assert.deepEqual(await inFlightRetry.json(), { upgradeId: id });
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

test("a crash before the command transaction leaves no branch result and retires its unaccepted request key", { timeout }, async t => {
  const f = await fixture(t);
  const old = f.launch();
  await f.health(f.old);
  const branch = await f.fork();
  await f.cli("shutdown");
  assert.equal(await old.exited, 0, old.output());
  const id = randomUUID(), requestKey = randomUUID();
  f.paths.init();
  f.paths.save({ version: 1, id, branch, requestKey, old: f.old, port: f.port, faux: true, legacy: false, phase: "requested" });
  f.launch();
  await f.health(f.old);
  const response = await f.send("/upgrade", branch, { marker: "1", requestId: requestKey });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /did not commit/);
  assert.match(f.paths.load()?.result?.reason ?? "", /no command was accepted/);
  assert.equal((await f.entries(branch)).filter(entry => entry.kind === upgradeEntryKind).length, 0);
  const fresh = await f.send("/upgrade", branch, { marker: "1" });
  assert.equal(fresh.status, 202);
  assert.equal((await f.result(f.paths.load()!.id, branch)).length, 1);
});

test("a journal write failure before the request rename does not close admission", { timeout }, async t => {
  const f = await fixture(t);
  f.launch();
  await f.health(f.old);
  await f.flag("fail-journal-write");
  const response = await f.send("/upgrade", "root", { marker: "1" });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /fixture journal write failed before rename/);
  assert.equal(f.paths.load(), undefined);
  assert.equal((await f.cli("send", "still serving")).stdout.trim(), "Faux reply: still serving");
  await f.unflag("fail-journal-write");
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
  assert.match(JSON.stringify((await f.result(f.paths.load()!.id))[0].data), /Upgrade not needed/);
});

test("a committed request with a failed helper launch returns its upgrade ID and reports once", { timeout }, async t => {
  const f = await fixture(t);
  f.launch();
  await f.health(f.old);
  await f.flag("fail-start-helper");
  const requestId = randomUUID();
  const send = () => f.send("/upgrade", "root", { marker: "1", requestId });
  const accepted = await send();
  assert.equal(accepted.status, 202);
  const id = f.paths.load()!.id;
  assert.equal((await accepted.json() as { upgradeId: string }).upgradeId, id);
  const [result] = await f.result(id);
  assert.match(JSON.stringify(result.data), /Upgrade cancelled.*fixture log failed to open/);
  assert.equal((await (await send()).json() as { upgradeId: string }).upgradeId, id);
  assert.equal((await f.result(id)).length, 1);
});

test("an unmanaged data-dir tolerates unrelated files but not an ambiguous upgrade journal or orphaned stage", { timeout }, async t => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "aipatty-upgrade-unmanaged-")));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const data = join(scratch, "data"), upgrade = join(scratch, "upgrade");
  await mkdir(data);
  await mkdir(upgrade);
  await chmod(upgrade, 0o770);
  const config = readConfig(["--data-dir", data], {});
  assert.equal(UpgradePaths.forStartup(config), undefined);
  const journal = join(upgrade, "journal.json");
  await writeFile(journal, "{}");
  assert.throws(() => UpgradePaths.forStartup(config), /Expected an owned, canonical directory/);
  await rm(journal);
  await chmod(upgrade, 0o700);
  const paths = new UpgradePaths(scratch, data);
  const id = randomUUID();
  await writeFile(join(upgrade, `${id}.stage-owner.sqlite`), "");
  assert.throws(() => UpgradePaths.forStartup(config), /Missing upgrade journal: .*Private staging artifacts exist/);
  await rm(join(upgrade, `${id}.stage-owner.sqlite`));
  await mkdir(paths.stage(id), { recursive: true });
  for (const missing of ["journal", "directory"]) {
    if (missing === "directory") await rm(upgrade, { recursive: true });
    assert.throws(() => UpgradePaths.forStartup(config), /Missing upgrade journal: .*Private staging artifacts exist/, missing);
  }
  await rm(paths.stage(id), { recursive: true });
  assert.equal(UpgradePaths.forStartup(config), undefined);
});

test("a live request cannot replace a lost state directory while a private stage exists", { timeout }, async t => {
  const f = await fixture(t);
  const old = f.launch();
  await f.health(f.old);
  f.paths.init();
  const stage = f.paths.stage(randomUUID());
  await mkdir(stage);
  await rename(f.paths.state, f.paths.state + ".moved");
  const response = await f.send("/upgrade", "root", { marker: "1" });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /Missing upgrade journal: .*Private staging artifacts exist/);
  assert.equal(f.paths.load(), undefined);
  assert.ok(existsSync(stage));
  assert.ok(!(await f.entries()).some(e => e.kind === upgradeEntryKind));
  await f.cli("shutdown");
  assert.equal(await old.exited, 0, old.output());
  await rm(f.paths.state, { recursive: true }); // Test startup with the entire state directory absent.
  const restarted = f.launch();
  assert.equal(await restarted.exited, 1, restarted.output());
  assert.match(restarted.output(), /Missing upgrade journal: .*Private staging artifacts exist/);
  await assert.rejects(f.supervisor(f.old, "bootstrap"), /Missing upgrade journal: .*Private staging artifacts exist/);
  assert.equal(f.paths.load(), undefined);
});

for (const field of ["branch", "requestKey"] as const) {
  test(`failed handoff does not cancel a replacement request with a different ${field}`, { timeout }, async t => {
    const f = await fixture(t);
    const child = f.launch();
    await f.health(f.old);
    const branch = await f.fork();
    await f.flag("fail-start-helper");
    const barrier = await f.pause("handoff");
    const response = f.send("/upgrade", "root", { marker: "1" });
    await barrier.entered();
    const accepted = f.paths.load()!;
    f.paths.save(field === "branch" ? { ...accepted, branch } : { ...accepted, requestKey: randomUUID() });
    const replacement = await readFile(f.paths.journal, "utf8");
    await barrier.resume();
    assert.deepEqual(await (await response).json(), { upgradeId: accepted.id });
    assert.match(child.output(), /Missing or changed upgrade journal/);
    assert.equal(await readFile(f.paths.journal, "utf8"), replacement);
    assert.equal((await f.send("keep admission closed")).status, 409);
    assert.equal((await f.entries(branch)).filter(e => e.kind === upgradeEntryKind).length, 0);
    assert.equal((await f.entries()).filter(e => e.kind === upgradeEntryKind).length, 1); // Only the accepted request.
  });
}

test("delivery cannot acknowledge a replaced terminal record after committing its result", { timeout }, async t => {
  const f = await fixture(t);
  const old = f.launch();
  await f.health(f.old);
  const barrier = await f.pause("ack-result");
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
  await barrier.entered();
  assert.throws(() => f.paths.lease(), /Another upgrade or recovery owns/);
  const original = f.paths.load()!;
  assert.equal(original.reported, undefined);
  assert.equal((await f.result(original.id)).length, 1);
  f.paths.save(finish(original, { ...original.result!, reason: "different terminal result" }));
  const replacement = await readFile(f.paths.journal, "utf8");
  await barrier.resume();
  await until(() => old.output().includes("Could not settle upgrade"));
  assert.match(old.output(), /Could not deliver upgrade .*Upgrade journal changed/);
  assert.equal(await readFile(f.paths.journal, "utf8"), replacement);
  assert.equal((await f.send("must not reopen on drift")).status, 409);
  await f.cli("shutdown");
  assert.equal(await old.exited, 0, old.output());
  f.paths.save(original);
  f.launch();
  await f.health(f.old);
  await until(() => f.paths.load()?.reported);
  assert.equal((await f.result(original.id)).length, 1);
});

test("retiring an uncommitted request cannot acknowledge a missing journal", { timeout }, async t => {
  const f = await fixture(t);
  const seed = f.launch();
  await f.health(f.old);
  const branch = await f.fork();
  await f.cli("shutdown");
  assert.equal(await seed.exited, 0, seed.output());
  const requestKey = randomUUID();
  f.paths.init();
  f.paths.save({ version: 1, id: randomUUID(), old: f.old, port: f.port, faux: true, legacy: false,
    phase: "requested", branch, requestKey });
  const barrier = await f.pause("ack-retirement");
  const start = f.launch();
  await barrier.entered();
  assert.throws(() => ownDataDir(f.paths.data), /owns data directory/);
  const original = f.paths.load()!;
  assert.equal(original.phase, "done");
  await rm(f.paths.journal);
  await barrier.resume();
  assert.equal(await start.exited, 1, start.output());
  assert.match(start.output(), /Could not deliver upgrade .*Missing upgrade journal/);
  assert.equal(f.paths.load(), undefined);
  f.paths.save(original);
  f.launch();
  await f.health(f.old);
  await until(() => f.paths.load()?.reported);
  const response = await f.send("/upgrade", branch, { marker: "1", requestId: requestKey });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /did not commit/);
  assert.equal((await f.entries(branch)).filter(e => e.kind === upgradeEntryKind).length, 0);
});

test("gated activation accepts only the exact validated phase-to-terminal transition", { timeout }, async t => {
  const f = await fixture(t);
  const target = await f.next("candidate identity");
  const source = await f.install(target);
  f.paths.init();
  f.paths.select(target);
  const before: UpgradeJournal = { version: 1, id: randomUUID(), old: f.old, target, port: f.port, faux: true, legacy: false,
    branch: 1, requestKey: randomUUID(), phase: "switching" };
  const terminal = finish(before, { kind: "upgraded", active: target });
  for (const patch of [
    { port: f.port === 65535 ? 1 : f.port + 1 }, { faux: false }, { branch: 2 }, { requestKey: randomUUID() },
    { legacy: true, branch: undefined, requestKey: undefined }, { old: "a".repeat(40) }, { reported: true as const },
    { old: target, target: f.old, result: { kind: "rolled-back" as const, active: target } },
  ]) {
    f.paths.save({ ...terminal, ...patch });
    assert.ok(f.paths.load(), "replacement is syntactically valid");
    assert.equal(committedValidation({ paths: f.paths, journal: before }, source, target), undefined, JSON.stringify(patch));
  }
  f.paths.save(terminal);
  assert.deepEqual(committedValidation({ paths: f.paths, journal: before }, source, target)?.journal, terminal);
  assert.throws(() => committedValidation({ paths: f.paths, journal: before }, f.paths.release(f.old), target), /Start the selected immutable/);
  f.paths.select(f.old);
  assert.throws(() => committedValidation({ paths: f.paths, journal: before }, source, target), /Start the selected immutable/);
  const restored = { ...before, phase: "restored" as const };
  const rollback = finish(restored, { kind: "rolled-back", active: f.old, reason: interruptedCutover });
  f.paths.save(rollback);
  assert.deepEqual(committedValidation({ paths: f.paths, journal: restored }, f.paths.release(f.old), f.old)?.journal, rollback);
});

test("a non-legacy journal without a branch or request key cannot authorize recovery", { timeout }, async t => {
  const f = await fixture(t);
  const target = await f.next("invalid durable request identity");
  f.paths.init();
  f.paths.save({ version: 1, id: randomUUID(), old: f.old, target, port: f.port,
    faux: true, legacy: false, phase: "switching" });
  const pending = await readFile(f.paths.journal, "utf8");
  try {
    await assert.rejects(f.supervisor(f.old, "recover"), /Invalid upgrade journal/);
    assert.equal(await readFile(f.paths.journal, "utf8"), pending);
  } finally { await rm(f.paths.journal, { force: true }); }
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixturePid = async (f: Fixture, name: string) => Number(await readFile(join(f.scratch, `${name}.pid`), "utf8"));

async function assertInterrupted(f: Fixture, id: string, target: string) {
  const journal = f.paths.load();
  assert.equal(journal?.id, id);
  assert.equal(journal?.phase, "staging");
  assert.equal(journal?.target, target);
  assert.equal(journal?.result, undefined);
  assert.equal(f.paths.selected(), f.old);
  assert.equal(existsSync(f.paths.release(target)), false);
  assert.equal(existsSync(f.paths.backup(id)), false);
  assert.ok(existsSync(f.paths.stage(id)));
  await assert.rejects(f.supervisor(f.old, "recover"), /Interrupted staging.*ack-interrupted-stage/);
}

test("a crashed coordinator leaves the old app up and retains the interrupted stage without signalling npm", { timeout }, async t => {
  const f = await fixture(t);
  const old = f.launch();
  await f.health(f.old);
  const target = await f.next("stage interrupted before deps");
  await f.flag("hold-stage");
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
  await until(() => existsSync(join(f.scratch, "npm.log")));
  const { id } = f.paths.load()!;
  // The PIDs are the fixture's own workers, recorded at its test-only spawn hook and held at barriers.
  process.kill(await fixturePid(f, "coordinator"), "SIGKILL");
  await until(() => old.output().includes("Interrupted staging"));
  const worker = await fixturePid(f, "worker");
  await until(() => identify(worker), value => !value);
  await assertInterrupted(f, id, target);
  assert.ok(await identify(await fixturePid(f, "npm")));
  assert.equal((await f.healthNow())?.pid, old.child.pid);
  assert.equal((await f.send("new work")).status, 409);
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 409);
});

test("a request key changed during staging prevents cutover and preserves the pending journal", { timeout }, async t => {
  const f = await fixture(t);
  const old = f.launch();
  await f.health(f.old);
  const target = await f.next("candidate with a changed journal during staging");
  await f.flag("hold-stage");
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
  await until(() => existsSync(join(f.scratch, "npm.log")));
  const helper = await fixturePid(f, "coordinator");
  const j = f.paths.load()!;
  const changed = { ...j, requestKey: randomUUID() };
  f.paths.save(changed);
  await f.unflag("hold-stage");
  await until(() => identify(helper), value => !value);
  assert.match(await f.log(j.id), /Upgrade journal changed/);
  assert.deepEqual(f.paths.load(), changed);
  assert.equal(f.paths.selected(), f.old);
  assert.equal((await f.healthNow())?.pid, old.child.pid);
  assert.equal(existsSync(f.paths.backup(j.id)), false);
  assert.equal(existsSync(f.paths.release(target)), false);
  assert.ok(existsSync(f.paths.stage(j.id)));
});

if (process.env.UPGRADE_NESTED_TEST) {
  // Run only as a real subprocess of the outer fixture's `npm test` command.
  test("nested fixture starts a replacement whose coordinator exits", { timeout }, async t => {
    const inner = await fixture(t);
    inner.launch();
    await inner.health(inner.old);
    const target = await inner.next("nested replacement");
    assert.equal((await inner.send("/upgrade", "root", { marker: "1" })).status, 202);
    const server = await inner.health(target);
    const ownHelper = Number(await readFile(join(inner.scratch, "coordinator.pid"), "utf8"));
    await until(() => identify(ownHelper), value => !value);
    // The listener has detached into a different group and no longer has a coordinator parent to find it by.
    await writeFile(join(process.env.UPGRADE_NESTED_TEST!, "nested-server.json"), JSON.stringify({ pid: server!.pid }));
    await until(() => existsSync(join(process.env.UPGRADE_NESTED_TEST!, "let-nested-finish")), Boolean, 30_000);
  });
}

test("a killed worker leaves detached checks alone; only maintenance acknowledgement can reopen admission", { timeout }, async t => {
  const f = await fixture(t);
  const old = f.launch();
  await f.health(f.old);
  const target = await f.next("target running the nested process fixture as npm test");
  await f.flag("nest-test");
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
  const nested = await until(async () => {
    try { return JSON.parse(await readFile(join(f.scratch, "nested-server.json"), "utf8")) as { pid: number }; }
    catch { return undefined; }
  }, Boolean, 15_000);
  const { id } = f.paths.load()!;
  process.kill(await fixturePid(f, "worker"), "SIGKILL");
  await until(() => old.output().includes("Interrupted staging"));
  assert.match(await f.log(id), /Stage worker exited \(SIGKILL\)/);
  await assertInterrupted(f, id, target);
  assert.ok(await identify(nested!.pid), "neither recovery nor the coordinator signals a detached test process");
  const npm = await fixturePid(f, "npm");
  assert.ok(await identify(npm));
  await assert.rejects(f.supervisor(f.old, "recover", "--ack-interrupted-stage", randomUUID()), /pending staging request ID/);
  assert.equal((await f.send("new work")).status, 409);
  await f.flag("let-nested-finish");
  await until(() => identify(npm), value => !value); // The test's owner waited for nested teardown.
  await until(() => identify(nested!.pid), value => !value);
  await assertInterrupted(f, id, target); // Even proven quiet by the test, plain retry cannot clear staging.
  const unlock = f.paths.stagingLease(id);
  try {
    await assert.rejects(f.supervisor(f.old, "recover", "--ack-interrupted-stage", id), /still holds its lease/);
  } finally { unlock(); }
  assert.match((await f.supervisor(f.old, "recover", "--ack-interrupted-stage", id)).stdout, /Operator acknowledged interrupted staging/);
  assert.equal((await f.result(id)).length, 1);
  assert.equal((await f.health(f.old))?.pid, old.child.pid);
  assert.ok(existsSync(f.paths.stage(id)));
  assert.equal((await f.cli("send", "after verified cleanup")).stdout.trim(), "Faux reply: after verified cleanup");
  await f.unflag("nest-test");
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
  assert.notEqual(f.paths.load()?.id, id);
  await f.health(target);
  assert.ok(existsSync(f.paths.stage(id)), "new upgrade does not reuse or clean an acknowledged stage");
});

for (const interruption of ["omit-stage-result", "hold-stage-child"] as const) {
  test(`clean exit alone cannot commit staging (${interruption})`, { timeout }, async t => {
    const f = await fixture(t);
    const old = f.launch();
    await f.health(f.old);
    const target = await f.next(interruption);
    await f.flag(interruption);
    assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
    const { id } = f.paths.load()!;
    await until(() => old.output().includes("Interrupted staging"));
    assert.match(await f.log(id), interruption === "omit-stage-result" ? /without a completion response/ : /group still has members/);
    await assertInterrupted(f, id, target);
    assert.equal(await readFile(join(f.paths.stage(id), "label"), "utf8"), interruption);
    if (interruption === "hold-stage-child") assert.ok(await identify(await fixturePid(f, "stage-child")));
  });
}

test("npm test can exit normally with a failure while a detached test process still runs", { timeout }, async t => {
  const f = await fixture(t);
  const old = f.launch();
  await f.health(f.old);
  const target = await f.next("test runner failed with an orphaned fixture");
  await f.flag("hold-stage-child");
  await f.flag("failed-test");
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
  const { id } = f.paths.load()!;
  await until(() => old.output().includes("Interrupted staging"));
  assert.match(await f.log(id), /Test command did not confirm successful teardown: npm test exited 7/);
  await assertInterrupted(f, id, target);
  assert.ok(await identify(await fixturePid(f, "stage-child")));
  assert.equal((await f.send("new work")).status, 409);
});

test("a delivery error is discoverable with recover and restart retries the same result without staging", { timeout }, async t => {
  const f = await fixture(t);
  const old = f.launch();
  await f.health(f.old);
  await f.flag("fail-report");
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
  const journal = await until(() => f.paths.load(), j => j?.phase === "done");
  await until(() => old.output().includes("fixture transcript write failed"));
  assert.equal(journal?.result?.kind, "noop");
  assert.equal(journal?.reported, undefined);
  assert.match((await f.supervisor(f.old, "recover")).stdout, /still marked pending/);
  assert.match(await f.log(journal!.id), /restart the selected app to retry delivery/);
  assert.equal((await f.entries()).filter(entry => entry.kind === upgradeEntryKind).length, 1);
  await f.cli("shutdown");
  assert.equal(await old.exited, 0, old.output());
  await f.unflag("fail-report");
  f.launch();
  await f.health(f.old);
  assert.equal((await f.result(journal!.id)).length, 1);
  assert.equal(f.paths.load()?.reported, true);
  assert.equal(f.paths.selected(), f.old);
});

test("losing the requesting host during staging requires maintenance acknowledgement before startup", { timeout }, async t => {
  const f = await fixture(t);
  const old = f.launch();
  await f.health(f.old);
  const target = await f.next("requesting host lost before stop");
  await f.flag("hold-stage");
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
  await until(() => existsSync(join(f.scratch, "npm.log")));
  const { id } = f.paths.load()!;
  old.child.kill("SIGKILL");
  await old.exited;
  const worker = await fixturePid(f, "worker"), helper = await fixturePid(f, "coordinator"), npm = await fixturePid(f, "npm");
  await until(() => identify(helper), value => !value);
  await until(() => identify(worker), value => !value);
  const refused = f.launch();
  assert.equal(await refused.exited, 1, refused.output());
  assert.match(refused.output(), /Interrupted staging.*ack-interrupted-stage/);
  await assertInterrupted(f, id, target);
  assert.ok(await identify(npm));
  await f.unflag("hold-stage");
  await until(() => identify(npm), value => !value);
  await f.supervisor(f.old, "recover", "--ack-interrupted-stage", id);
  f.launch();
  await f.health(f.old);
  const [result] = await f.result(id);
  assert.match(JSON.stringify(result.data), /cancelled before cutover.*Operator acknowledged interrupted staging/);
  assert.ok(existsSync(f.paths.stage(id)));
});

test("interrupted legacy bootstrap leaves the old app running and requires acknowledgement before another bootstrap", { timeout }, async t => {
  const f = await fixture(t, true);
  const old = f.launch();
  await f.health(f.old);
  const target = await f.next("interrupted bootstrap");
  await f.install(target);
  await f.flag("hold-stage");
  const failed = assert.rejects(f.supervisor(target, "bootstrap"), /Interrupted staging.*Stage worker exited \(SIGKILL\)/s);
  await until(() => existsSync(join(f.scratch, "npm.log")));
  const { id } = f.paths.load()!;
  process.kill(await fixturePid(f, "worker"), "SIGKILL");
  await failed;
  assert.equal(f.paths.load()?.phase, "staging");
  assert.equal(f.paths.selected(), f.old);
  assert.equal(existsSync(join(f.paths.release(target), "node_modules")), false);
  assert.equal(existsSync(f.paths.backup(id)), false);
  assert.equal(old.child.exitCode, null);
  assert.equal(existsSync(join(f.scratch, "legacy-closed")), false);
  await assert.rejects(f.supervisor(target, "bootstrap"), /upgrade is unfinished/);
  await assert.rejects(f.supervisor(target, "recover"), /Interrupted staging/);
  const npm = await fixturePid(f, "npm");
  assert.ok(await identify(npm));
  await f.unflag("hold-stage");
  await until(() => identify(npm), value => !value);
  const inspectionFailure = process.platform === "linux" ? "fail-proc-net-tcp" : "fail-lsof";
  await f.flag(inspectionFailure);
  await assert.rejects(f.supervisor(target, "recover", "--ack-interrupted-stage", id), /during legacy ownership check/);
  assert.equal(f.paths.load()?.phase, "staging");
  await f.unflag(inspectionFailure);
  await writeFile(join(f.scratch, "bin", "ps"), `#!/bin/sh
case "$*" in
  *stat=,lstart=) kind=identity ;;
  *command=) kind=command ;;
esac
if [ -e "$UPGRADE_FIXTURE/fail-ps-$kind" ]; then
  echo "fixture ps $kind diagnostic" >&2
  exit 2
fi
if [ -e "$UPGRADE_FIXTURE/empty-ps-$kind" ]; then exit 1; fi
exec /bin/ps "$@"
`, { mode: 0o700 });
  const pending = f.paths.load();
  const psFailures: [string, RegExp][] = [["fail-ps-identity", /with ps: .*fixture ps identity diagnostic/],
    ["empty-ps-identity", /Cannot identify process/]];
  if (process.platform === "darwin") psFailures.push(["fail-ps-command", /with ps: .*fixture ps command diagnostic/],
    ["empty-ps-command", /Cannot inspect command line for process/]);
  for (const [flag, diagnostic] of psFailures) {
    await f.flag(flag);
    await assert.rejects(f.supervisor(target, "recover", "--ack-interrupted-stage", id), diagnostic);
    assert.match(await f.log(id), diagnostic);
    assert.deepEqual(f.paths.load(), pending);
    assert.equal(f.paths.selected(), f.old);
    assert.ok(existsSync(f.paths.stage(id)));
    await f.unflag(flag);
  }
  const ownerFile = join(f.paths.data, "owner.sqlite");
  await chmod(ownerFile, 0o660);
  try {
    await assert.rejects(f.supervisor(target, "recover", "--ack-interrupted-stage", id), /owner\.sqlite during legacy ownership check/);
    assert.equal(f.paths.load()?.phase, "staging");
  } finally { await chmod(ownerFile, 0o600); }
  assert.match((await f.supervisor(target, "recover", "--ack-interrupted-stage", id)).stdout, /Operator acknowledged interrupted staging/);
  assert.ok(existsSync(f.paths.stage(id)));
  assert.ok(await f.health(f.old));
});

test("legacy staging acknowledgement permits a stopped listener without reporting it active", { timeout }, async t => {
  const f = await fixture(t, true);
  const old = f.launch();
  await f.health(f.old);
  await f.cli("shutdown");
  assert.equal(await old.exited, 0, old.output());
  const id = randomUUID();
  f.paths.init();
  await mkdir(f.paths.stage(id));
  f.paths.save({ version: 1, id, old: f.old, port: f.port, faux: true, legacy: true, phase: "staging" });
  const result = await f.supervisor(f.old, "recover", "--ack-interrupted-stage", id);
  assert.match(result.stdout, /No active server was verified/);
  assert.equal(f.paths.load()?.phase, "done");
  assert.equal(f.paths.selected(), f.old);
  assert.ok(existsSync(f.paths.stage(id)));
});

test("legacy ownership surfaces lsof diagnostics instead of reporting no matching listener", { timeout, skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, true);
  const old = f.launch();
  await f.health(f.old);
  const target = await f.next("legacy ownership diagnostics");
  await f.install(target);
  await f.flag("fail-lsof");
  await assert.rejects(f.supervisor(target, "bootstrap"), /lsof failed during legacy ownership check.*fixture lsof diagnostic/);
  assert.equal(f.paths.load(), undefined);
  assert.equal(old.child.exitCode, null);
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

test("candidate readiness rolls back if the durable upgrade request cannot be read", { timeout }, async t => {
  const f = await fixture(t);
  f.launch();
  await f.health(f.old);
  await f.cli("send", "history before upgrade");
  // Simulate an incompatible candidate that cannot read the accepted RequestDoc. The original release can.
  const host = join(f.repo, "src/upgrade-host.ts");
  const code = await readFile(host, "utf8");
  assert.ok(code.includes('kind: "aipatty.upgrade.request"'));
  await writeFile(host, code.replace('kind: "aipatty.upgrade.request"', 'kind: "fixture.incompatible.upgrade.request"'));
  const target = await f.next("candidate cannot see accepted request");
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
  const { id } = f.paths.load()!;
  assert.match(JSON.stringify((await f.result(id))[0].data), /Upgrade rolled back.*durable request is missing/);
  assert.equal(f.paths.load()?.target, target);
  assert.equal(f.paths.selected(), f.old);
  assert.match((await f.cli("log")).stdout, /Faux reply: history before upgrade/);
});

test("a candidate's invalid HTTP health response is kept in the rollback result", { timeout }, async t => {
  const f = await fixture(t);
  f.launch();
  await f.health(f.old);
  const api = join(f.repo, "src/api.ts"), code = await readFile(api, "utf8");
  const health = "sendJson(res, 200, { ...health, ...await agent.modelStatus() });";
  assert.ok(code.includes(health));
  await writeFile(api, code.replace(health, 'sendJson(res, 500, { error: "fixture health error" });'));
  await f.next("candidate HTTP health error");
  assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
  assert.match(JSON.stringify((await f.result(f.paths.load()!.id))[0].data), /Upgrade rolled back.*Invalid health response \(HTTP 500\)/);
  assert.equal(f.paths.selected(), f.old);
});

for (const mismatch of [false, true]) {
  const kind = mismatch ? "latest mismatched HTTP 200" : "final HTTP 500";
  test(`post-commit activation reports the ${kind} without rolling back`, { timeout }, async t => {
    const f = await fixture(t, true);
    const old = f.launch();
    await f.health(f.old);
    const api = join(f.repo, "src/api.ts"), code = await readFile(api, "utf8");
    const health = "sendJson(res, 200, { ...health, ...await agent.modelStatus() });";
    assert.ok(code.includes(health));
    await writeFile(api, code.replace(health, `
    if (serving() && (await import("node:fs")).existsSync(process.env.UPGRADE_FIXTURE + "/fail-activation-health")) {
      // In the mismatch case the HTTP 500 must be superseded by the next observed state.
      if (!${mismatch} || activationProbeCount++ === 0) sendJson(res, 500, { error: "fixture activation health error" });
      else sendJson(res, 200, { ...health, pid: 1, validation: { id: "fixture", ready: true } });
    } else ${health}`) + "\nlet activationProbeCount = 0;\n");
    const target = await f.next(`health fails only after activation (${kind})`);
    await f.install(target);
    await f.flag("fail-activation-health");
    const diagnostic = mismatch
      ? /was committed, but did not confirm activation.*Last \/health probe: HTTP 200 but expected PID \d+, received 1, validation is still present.*do not restore/s
      : /was committed, but did not confirm activation.*Last \/health probe: Invalid health response \(HTTP 500\).*do not restore/s;
    try {
      await assert.rejects(f.supervisor(target, "bootstrap"), diagnostic);
      const journal = f.paths.load()!;
      assert.equal(journal.phase, "done");
      assert.deepEqual(journal.result, { kind: "upgraded", active: target });
      assert.equal(f.paths.selected(), target);
      assert.match(await f.log(journal.id), diagnostic);
    } finally { await f.unflag("fail-activation-health"); }
    await f.health(target);
    assert.equal(await old.exited, 0, old.output());
  });
}

test("post-commit activation reports the replacement's actual exit without rolling back", { timeout }, async t => {
  const f = await fixture(t, true);
  const old = f.launch();
  await f.health(f.old);
  const deleteValidation = "        delete health.validation;";
  const target = await f.next("candidate exits during activation", code => {
    assert.ok(code.includes(deleteValidation));
    return code.replace(deleteValidation, `        if (childId) process.exit(23);\n${deleteValidation}`);
  });
  await f.install(target);
  const diagnostic = /was committed, but did not confirm activation.*Server exited \(23\).*do not restore/s;
  await assert.rejects(f.supervisor(target, "bootstrap"), diagnostic);
  const journal = f.paths.load()!;
  assert.equal(journal.phase, "done");
  assert.deepEqual(journal.result, { kind: "upgraded", active: target });
  assert.equal(f.paths.selected(), target);
  assert.match(await f.log(journal.id), diagnostic);
  assert.equal(await old.exited, 0, old.output());
});

test("first bootstrap rolls back and identifies a wrong candidate PID even when its SHA matches", { timeout }, async t => {
  const f = await fixture(t, true);
  const legacy = f.launch();
  await f.health(f.old);
  assert.equal((await f.send("legacy rollback keeps this history")).status, 202);
  const target = await f.next("wrong PID while validating", code => code.replace("      const api = await startApi", `
      if (childId) health.pid = 1;
      const api = await startApi`));
  await f.install(target);
  await assert.rejects(f.supervisor(target, "bootstrap"), /Upgrade rolled back.*Readiness identity mismatch: expected PID \d+, received 1/s);
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

for (const [fault, ready] of [["corrupt", false], ["missing", false], ["missing", true], ["changed branch", true],
  ["changed request key", true], ["replacement terminal port", true], ["selection", true]] as const) {
  test(`a cutover journal fault (${fault}) disconnects the ${ready ? "ready" : "unready"} candidate without restoring`, { timeout }, async t => {
    const f = await fixture(t);
    f.launch();
    await f.health(f.old);
    const target = await f.next(`candidate validation ready=${ready}`, ready ? undefined : code => code.replace("      const api = await startApi", `
      if (childId) health.validation = { id: childId, ready: false, reason: "fixture validation failure" };
      const api = await startApi`));
    await f.flag("hold-probe");
    assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
    const candidate = await f.health(target, true);
    assert.equal(candidate?.validation?.ready, ready);
    const j = f.paths.load()!;
    const helper = Number(await readFile(join(f.scratch, "helper.pid"), "utf8"));
    const backup = await readFile(f.paths.backup(j.id));
    const corrupted = "not valid JSON";
    try {
      if (fault === "corrupt") await writeFile(f.paths.journal, corrupted);
      else if (fault === "missing") await rm(f.paths.journal);
      else if (fault === "changed branch") f.paths.save({ ...j, branch: j.branch! + 1 });
      else if (fault === "changed request key") f.paths.save({ ...j, requestKey: randomUUID() });
      else if (fault === "replacement terminal port") {
        f.paths.save(finish({ ...j, port: j.port === 65535 ? 1 : j.port + 1 }, { kind: "upgraded", active: target }));
      } else f.paths.select(f.old);
      const replacement = fault === "missing" ? undefined : await readFile(f.paths.journal, "utf8");
      await f.unflag("hold-probe");
      await until(() => identify(helper), value => !value);
      await until(() => identify(candidate!.pid!), value => !value);
      assert.equal(await f.healthNow(), undefined);
      assert.equal(f.paths.selected(), fault === "selection" ? f.old : target);
      assert.deepEqual(await readFile(f.paths.backup(j.id)), backup);
      const diagnostic = fault === "corrupt" ? /not valid JSON|Unexpected token/
        : fault === "missing" ? /Missing upgrade journal/
          : fault === "selection" ? /Upgrade selection changed/ : /Upgrade journal changed/;
      assert.match(await f.log(j.id), diagnostic);
      if (replacement !== undefined) assert.equal(await readFile(f.paths.journal, "utf8"), replacement);
      else {
        assert.equal(f.paths.load(), undefined);
        const restart = f.launch(target);
        assert.equal(await restart.exited, 1, restart.output());
        assert.match(restart.output(), /Missing upgrade journal: .*Cutover backup exists/);
      }
    } finally {
      // Put back the known-good phase in this private fixture, then use the actual recovery path.
      f.paths.save(j);
    }
    await f.supervisor(target, "recover");
    await f.health(f.old);
    assert.equal((await f.result(j.id)).length, 1);
  });
}

for (const boundary of ["publication", "backup"] as const) {
  test(`selection drift during ${boundary} cannot promote the prepared files`, { timeout }, async t => {
    const f = await fixture(t);
    const host = f.launch();
    await f.health(f.old);
    const other = await f.next("third release for selection drift");
    await f.install(other);
    const target = await f.next("intended target");
    const barrier = await f.pause(boundary);
    assert.equal((await f.send("/upgrade", "root", { marker: "1" })).status, 202);
    await barrier.entered();
    assert.throws(() => f.paths.lease(), /Another upgrade or recovery owns/);
    const pending = f.paths.load()!;
    assert.equal(pending.phase, boundary === "publication" ? "staging" : "stopping");
    f.paths.select(other);
    await barrier.resume();
    await until(async () => (await f.log(pending.id)).includes("Selection and backup left intact"));
    assert.deepEqual(f.paths.load(), pending);
    assert.equal(f.paths.selected(), other);
    assert.ok(!existsSync(f.paths.backup(pending.id)));
    if (boundary === "publication") {
      assert.ok(!existsSync(f.paths.release(target)));
      assert.ok(existsSync(f.paths.stage(pending.id)));
      assert.equal((await f.healthNow())?.pid, host.child.pid);
    } else {
      assert.equal(await host.exited, 0, host.output());
      assert.equal(await f.healthNow(), undefined);
    }
  });
}

test("recovery rechecks the terminal record and selection after verifying the release", { timeout }, async t => {
  const f = await fixture(t);
  const other = await f.next("other managed selection");
  await f.install(other);
  f.paths.init();
  const done: UpgradeJournal = { version: 1, id: randomUUID(), old: f.old, port: f.port, faux: true, legacy: true,
    phase: "done", result: { kind: "noop", active: f.old } };
  for (const fault of ["result", "selection"] as const) {
    f.paths.save(done);
    f.paths.select(f.old);
    const barrier = await f.pause("selected");
    const rejected = assert.rejects(f.supervisor(f.old, "recover"),
      fault === "result" ? /Upgrade journal changed/ : /Upgrade selection changed/);
    await barrier.entered();
    assert.throws(() => f.paths.lease(), /Another upgrade or recovery owns/);
    if (fault === "result") f.paths.save(finish(done, { ...done.result!, reason: "replacement" }));
    else f.paths.select(other);
    const replacement = await readFile(f.paths.journal, "utf8");
    await barrier.resume();
    await rejected;
    assert.equal(await readFile(f.paths.journal, "utf8"), replacement);
    assert.equal(f.paths.selected(), fault === "selection" ? other : f.old);
  }
});

test("restored legacy recovery rechecks the journal under the data lock before launching", { timeout }, async t => {
  const f = await fixture(t, true);
  const legacy = f.launch();
  await f.health(f.old);
  await f.cli("shutdown");
  assert.equal(await legacy.exited, 0, legacy.output());
  f.paths.init();
  const target = await f.next("stopped legacy rollback");
  await f.install(target);
  const j: UpgradeJournal = { version: 1, id: randomUUID(), old: f.old, target, port: f.port, faux: true, legacy: true,
    phase: "restored", reason: "test recovery" };
  const release = ownDataDir(f.paths.data);
  try { await backupDb(f.paths, j.id); } finally { release(); }
  const backup = await readFile(f.paths.backup(j.id));
  f.paths.save(j);
  const barrier = await f.pause("quiescent");
  const rejected = assert.rejects(f.supervisor(target, "recover"), /Upgrade journal changed/);
  await barrier.entered();
  assert.throws(() => f.paths.lease(), /Another upgrade or recovery owns/);
  assert.throws(() => ownDataDir(f.paths.data), /owns data directory/);
  const replacement = { ...j, reason: "replacement journal" };
  f.paths.save(replacement);
  await barrier.resume();
  await rejected;
  assert.equal(await f.healthNow(), undefined);
  assert.deepEqual(f.paths.load(), replacement);
  assert.equal(f.paths.selected(), f.old);
  assert.deepEqual(await readFile(f.paths.backup(j.id)), backup);
  f.paths.save(j);
  assert.match((await f.supervisor(target, "recover")).stdout, /Upgrade rolled back/);
  await f.health(f.old);
});

test("recovery of an already listening legacy rollback refuses a corrupt or missing journal after probing", { timeout }, async t => {
  const f = await fixture(t, true);
  const original = f.launch();
  await f.health(f.old);
  await f.cli("shutdown");
  assert.equal(await original.exited, 0, original.output());
  const id = randomUUID();
  const target = await f.next("interrupted legacy rollback");
  await f.install(target);
  f.paths.init();
  const release = ownDataDir(f.paths.data);
  try { await backupDb(f.paths, id); } finally { release(); }
  const backup = await readFile(f.paths.backup(id));
  const journal = { version: 1, id, old: f.old, target, port: f.port, faux: true, legacy: true, phase: "restored" } as const;
  f.paths.save(journal);
  const running = f.launch();
  await f.health(f.old);
  const corrupt = "not valid JSON";
  for (const fault of ["corrupt", "missing"] as const) {
    await f.flag("hold-legacy-probe");
    const diagnostic = fault === "corrupt" ? /not valid JSON|Unexpected token/ : /Missing upgrade journal/;
    const rejected = assert.rejects(f.supervisor(f.old, "recover"), diagnostic);
    try {
      try {
        await until(() => existsSync(join(f.scratch, "legacy-probe-started")));
        if (fault === "corrupt") await writeFile(f.paths.journal, corrupt);
        else await rm(f.paths.journal);
      } finally { await f.unflag("hold-legacy-probe"); }
      await rejected;
      if (fault === "corrupt") assert.equal(await readFile(f.paths.journal, "utf8"), corrupt);
      else {
        await assert.rejects(f.supervisor(target, "bootstrap"), /Missing upgrade journal: .*Cutover backup exists/);
        assert.equal(f.paths.load(), undefined);
      }
      assert.equal(f.paths.selected(), f.old);
      assert.deepEqual(await readFile(f.paths.backup(id)), backup);
      assert.ok(await identify(running.child.pid!));
    } finally {
      f.paths.save(journal);
      await f.unflag("legacy-probe-started");
    }
  }
  assert.match((await f.supervisor(f.old, "recover")).stdout, /Upgrade rolled back/);
  assert.deepEqual(f.paths.load()?.result, { kind: "rolled-back", active: f.old,
    reason: "Interrupted cutover; the pinned candidate was not retried." });
  assert.ok(await identify(running.child.pid!));
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

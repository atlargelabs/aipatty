import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { Agent, request } from "node:http";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LOOPBACK, DEFAULT_PORT, shutdownHeader } from "./config.ts";
import { ownDataDir, OwnerBusy } from "./ownership.ts";
import { listProcesses, newOwned, processEntryUnavailable, runProcesses, stopRun } from "./processes.ts";
import { command } from "./upgrade-release.ts";
import { ownedFile, upgradeChildEnv, upgradeProtocol, type ProcessIdentity, type UpgradeJournal, type UpgradePaths } from "./upgrade-state.ts";

const stopMs = 20_000;
const startupMs = 30_000;
const probeMs = 1_500;
const psEnv = { ...process.env, LC_ALL: "C" };

export interface UpgradeHealth {
  ok?: boolean;
  commit?: string;
  modelStatus?: string;
  pid?: number;
  upgradeProtocol?: number;
  validation?: { id: string; ready: boolean; reason?: string };
}

export function openUpgradeLog(paths: UpgradePaths, id: string): number {
  const path = paths.log(id);
  ownedFile(path, false);
  return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
}

function localJson(port: number, path: string, method: string, agent: Agent | false, useSocket?: (socket: Socket) => boolean) {
  return new Promise<{ code: number; value: unknown }>((resolve, reject) => {
    const req = request({ host: LOOPBACK, port, path, method, agent,
      headers: method === "POST" ? { [shutdownHeader]: "1" } : undefined, signal: AbortSignal.timeout(probeMs) }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        body += chunk;
        if (body.length > 4_000_000) req.destroy(new Error("Unexpectedly large local HTTP response"));
      });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ code: res.statusCode ?? 0, value: JSON.parse(body) }); } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.on("socket", next => {
      if (useSocket && !useSocket(next)) req.destroy(new Error("Legacy server connection changed"));
      else req.end();
    });
  });
}

export async function getHealth(port: number): Promise<UpgradeHealth> {
  const { code, value } = await localJson(port, "/health", "GET", false);
  if (code !== 200 || !value || typeof value !== "object") throw new Error(`Invalid health response (HTTP ${code})`);
  return value as UpgradeHealth;
}

export async function identify(pid: number): Promise<ProcessIdentity | undefined> {
  const row = (await command("ps", ["-p", String(pid), "-o", "stat=,lstart="], { env: psEnv, ms: probeMs, exitCodes: [0, 1] })).trim();
  const match = /^(\S+)\s+(.+)$/.exec(row);
  if (match) return match[1].startsWith("Z") ? undefined : { pid, start: match[2] };
  // If ps did not find the process, distinguish absence from failure to inspect a still-live PID.
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
  throw new Error(`Cannot identify process ${pid}`);
}

const stagePrefix = /^PATTY_STAGE_[0-9a-f]{32}$/;
export const stageMarker = (id: string) => `PATTY_STAGE_${id.replaceAll("-", "")}`;

/** Preserve only the stage identities when a test builds a deliberately filtered child environment. Independent
 * variables let nested stages and their detached apps keep both scopes, without exporting any credentials.
 */
export function stageEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => stagePrefix.test(name) && value === "1"));
}

/** Under the upgrade lease. Keep observed detached groups across attempts, but never trust a group alone. */
export async function reapStage(paths: UpgradePaths, j: UpgradeJournal): Promise<void> {
  const worker = j.stageProcess;
  if (!worker) return; // Not authorized to spawn commands before its identity is persisted.
  const marker = stageMarker(j.id);
  let recorded = new Set(paths.stageGroups(j.id));
  const owned = newOwned([], [worker.pid, ...recorded]);
  const record = async () => {
    const groups = [...owned.groups].filter(pgid => pgid !== worker.pid);
    if (groups.length === recorded.size && groups.every(pgid => recorded.has(pgid))) return;
    paths.saveStageGroups(j.id, groups);
    recorded = new Set(groups);
  };
  const rootIsOurs = (await runProcesses(owned, "1", marker, record)).some(p => p.pid === worker.pid && p.start === worker.start);
  if (rootIsOurs) owned.procs.set(worker.pid, worker.start);
  else if ((await identify(worker.pid))?.start === worker.start) {
    throw new Error(`Cannot verify the staging marker on PID ${worker.pid}; inspect before recovering`);
  }
  const left = await stopRun(owned, "1", worker.pid, 250, undefined, record, marker);
  if (left.length) throw new Error(`Cannot prove staging processes exited (${left.map(p => p.pid).join(", ")}); leave the private stage in place and investigate`);
}

/** The stage worker itself is still the live group leader when it publishes or removes its private checkout. */
export async function assertStageIdle(id: string): Promise<void> {
  const hasGroupMember = async () => (await listProcesses()).some(p => p.pid !== process.pid && p.pgid === process.pid);
  if (await hasGroupMember() || (await runProcesses(newOwned(), "1", stageMarker(id))).length || await hasGroupMember()) {
    throw new Error("Staging still has subprocesses");
  }
}

function assertOwnerFiles(paths: UpgradePaths): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) ownedFile(join(paths.data, "owner.sqlite") + suffix, suffix === "");
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", error => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    socket.listen(port, LOOPBACK, () => socket.close(error => error ? reject(error) : resolve(true)));
  });
}

/** The caller holds the upgrade lease. Return with the conversation owner lock held. Never signal a listener. */
export async function quiescent(paths: UpgradePaths, port: number, old?: ProcessIdentity): Promise<() => void> {
  assertOwnerFiles(paths);
  const deadline = Date.now() + stopMs;
  do {
    if ((!old || (await identify(old.pid))?.start !== old.start) && await portFree(port)) {
      try { return ownDataDir(paths.data); } catch (error) { if (!(error instanceof OwnerBusy)) throw error; }
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for process/port ${port} and data ownership to be free; no writer was stopped by force`);
}

function linuxListeningInodes(port: number): Set<string> {
  const address = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  return new Set(readFileSync("/proc/net/tcp", "utf8").trim().split("\n").slice(1)
    .map(line => line.trim().split(/\s+/)).filter(row => row[1] === address && row[3] === "0A").map(row => row[9]));
}

export class LegacyInspectionError extends Error {}

function procEntry<T>(path: string, read: (path: string) => T): T | undefined {
  try { return read(path); }
  catch (error) {
    if (processEntryUnavailable(error)) return undefined;
    throw new LegacyInspectionError(`Could not inspect ${path} during legacy ownership check`, { cause: error });
  }
}

async function legacyOwner(paths: UpgradePaths, j: UpgradeJournal): Promise<ProcessIdentity> {
  assertOwnerFiles(paths);
  const lock = join(paths.data, "owner.sqlite");
  let pids: number[];
  if (process.platform === "linux") {
    const sockets = linuxListeningInodes(j.port);
    pids = readdirSync("/proc").filter(value => /^\d+$/.test(value)).map(Number).filter(pid => {
      const dir = `/proc/${pid}/fd`;
      const fds = procEntry(dir, path => readdirSync(path));
      if (!fds) return false;
      const links = fds.map(fd => procEntry(`${dir}/${fd}`, path => readlinkSync(path)) ?? "");
      return links.includes(lock) && links.some(link => sockets.has(/^socket:\[(\d+)\]$/.exec(link)?.[1] ?? ""));
    });
  } else {
    const lsof = (args: string[]) => command("/usr/sbin/lsof", ["-nP", "-Fp", ...args], { ms: 3_000, exitCodes: [0, 1] });
    const listening = [...new Set((await lsof([`-iTCP@${LOOPBACK}:${j.port}`, "-sTCP:LISTEN"])).split("\n")
      .filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
    pids = [];
    for (const pid of listening) {
      // lsof takes the intersection with -a. A process merely on this port is not proof of ownership.
      if ((await lsof(["-a", "-p", String(pid), "--", lock])).split("\n").includes(`p${pid}`)) pids.push(pid);
    }
  }
  if (pids.length !== 1) throw new Error("Could not match one legacy listener to this installation's owner.sqlite");
  const [pid] = pids;
  const identity = await identify(pid);
  const argv = [["--install-dir", paths.root, "--port", String(j.port)], ["--port", String(j.port), "--install-dir", paths.root]];
  if (j.port === DEFAULT_PORT) argv.push(["--install-dir", paths.root]);
  const scripts = [join(paths.current, "src/main.ts"), join(paths.release(j.old), "src/main.ts")];
  let matches: boolean;
  if (process.platform === "linux") {
    const [node, script, ...rest] = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1);
    matches = /(?:^|\/)node$/.test(node) && scripts.includes(script) && argv.some(args => JSON.stringify(args) === JSON.stringify(rest));
  } else {
    const line = (await command("ps", ["-ww", "-p", String(pid), "-o", "command="], { ms: probeMs })).trim();
    // ps prints the arguments joined with spaces. Compare only the documented launch forms, not a shell parse.
    const node = /^(\S*\/node|node) /.exec(line)?.[0];
    matches = !!node && scripts.some(script => argv.some(args => line.slice(node.length) === [script, ...args].join(" ")));
  }
  if (!identity || !matches || (await identify(pid))?.start !== identity.start) {
    throw new Error("Legacy upgrade requires the documented absolute main.ts launch, --install-dir, and no other overrides");
  }
  try {
    ownDataDir(paths.data)();
  } catch (error) {
    if (error instanceof OwnerBusy) return identity;
    throw error;
  }
  throw new Error("Legacy listener is not holding the exclusive conversation owner lock");
}

/** Verify and shut down on the very same HTTP connection (never reconnect to a replaced listener). */
export async function legacyConnection(paths: UpgradePaths, j: UpgradeJournal) {
  const identity = await legacyOwner(paths, j);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let socket: Socket | undefined;
  const call = (path: string, method = "GET") => localJson(j.port, path, method, agent, next => (socket ??= next) === next);
  try {
    const health = await call("/health");
    const value = health.value as UpgradeHealth | null;
    if (health.code !== 200 || value?.ok !== true || value.commit !== j.old || value.upgradeProtocol !== undefined
      || value.modelStatus !== "available") throw new Error("Legacy /health did not verify the expected SHA and available root model");
    const branches = await call("/api/branches");
    const list = (branches.value as { branches?: { busy?: boolean }[] } | null)?.branches;
    if (branches.code !== 200 || !Array.isArray(list) || !list.length || list.some(branch => branch?.busy !== false)) {
      throw new Error("Legacy server has active work or could not verify idle branches");
    }
    const again = await legacyOwner(paths, j);
    if (again.pid !== identity.pid || again.start !== identity.start) throw new Error("Legacy listener changed");
    return {
      identity,
      close: () => agent.destroy(),
      async shutdown() {
        const { code, value } = await call("/api/shutdown", "POST");
        if (code !== 202 || (value as { status?: string } | null)?.status !== "shutdown-requested") {
          throw new Error(`Legacy shutdown was not acknowledged (HTTP ${code})`);
        }
      },
    };
  } catch (error) {
    agent.destroy();
    throw error;
  }
}

export function sendParent(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) { reject(new Error("Host handoff connection closed")); return; }
    process.send(message, error => error ? reject(error) : resolve());
  });
}

export interface ServerChild { child: ChildProcess; exited: Promise<void>; error?: Error }

export function launchServer(paths: UpgradePaths, j: UpgradeJournal, sha: string, gated: boolean): ServerChild {
  const log = openUpgradeLog(paths, j.id);
  try {
    const env = { ...process.env };
    // Legacy still calls Git directly to identify its release. Retain service-wide Git configuration and SSH.
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_IMPLICIT_WORK_TREE", "GIT_NAMESPACE"]) delete env[name];
    delete env[upgradeChildEnv];
    if (gated) env[upgradeChildEnv] = j.id;
    const child = spawn(process.execPath, [join(paths.release(sha), "src/main.ts"), "--install-dir", paths.root, "--port", String(j.port)], {
      cwd: paths.release(sha), env, detached: true, stdio: gated ? ["ignore", log, log, "ipc"] : ["ignore", log, log],
    });
    const state: ServerChild = { child, exited: new Promise(resolve => {
      child.once("error", error => { state.error = error; resolve(); });
      child.once("exit", (code, signal) => { state.error = new Error(`Server exited (${code ?? signal})`); resolve(); });
    }) };
    return state;
  } finally { closeSync(log); }
}

export async function probeServer(server: ServerChild, j: UpgradeJournal, sha: string, gated: boolean): Promise<void> {
  const deadline = Date.now() + startupMs;
  let lastError: unknown;
  do {
    if (server.error) throw server.error;
    let health: UpgradeHealth | undefined;
    try { health = await getHealth(j.port); } catch (error) { lastError = error; }
    if (health) {
      if (health.ok !== true || health.commit !== sha || (gated && (health.pid !== server.child.pid
        || health.upgradeProtocol !== upgradeProtocol || health.validation?.id !== j.id))) {
        throw new Error(`Readiness identity mismatch: expected ${sha}, received ${health.commit ?? "unknown"}`);
      }
      if (health.modelStatus !== "available" || (gated && health.validation?.ready !== true)) {
        throw new Error(health.validation?.reason ?? "Server is listening but its saved model is unavailable");
      }
      if (server.error) throw server.error;
      return;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for candidate readiness", { cause: lastError });
}

/** This is after commit: failure can require a manual start, never a destructive rollback. */
export async function confirmActivation(server: ServerChild, j: UpgradeJournal, sha: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    if (server.error) break;
    const health = await getHealth(j.port).catch(() => undefined);
    if (health?.ok === true && health.commit === sha && health.pid === server.child.pid && !health.validation) return;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`${sha} was committed, but did not confirm activation. Check the log and start the selected release if stopped; do not restore over it.`);
}

export async function stopCandidate(server: ServerChild): Promise<void> {
  if (server.child.connected) server.child.disconnect(); // An uncommitted gated instance closes on parent loss.
  await Promise.race([server.exited, sleep(stopMs, undefined, { ref: false }).then(() => {
    server.child.unref();
    throw new Error("Uncommitted candidate did not exit; stop it manually before attempting recovery");
  })]);
}

export function detachServer(server: ServerChild): void {
  // The child decides from the synced journal whether disconnect means serve or close. Release the IPC and
  // process handles even if the coordinator cannot read the journal or prove the child stopped.
  try { if (server.child.connected) server.child.disconnect(); }
  finally {
    server.child.channel?.unref();
    server.child.unref();
  }
}
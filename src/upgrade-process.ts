import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { Agent, request } from "node:http";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LOOPBACK, DEFAULT_PORT, shutdownHeader } from "./config.ts";
import { ownDataDir, OwnerBusy } from "./ownership.ts";
import { command } from "./upgrade-release.ts";
import { errorText, ownedFile, shaPattern, upgradeChildEnv, upgradeProtocol, type ProcessIdentity, type UpgradeJournal, type UpgradePaths } from "./upgrade-state.ts";

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

export class UnverifiedListener extends Error {}
class InvalidLocalResponse extends UnverifiedListener {}

function localJson(port: number, path: string, method: string, agent: Agent | false, useSocket?: (socket: Socket) => boolean) {
  return new Promise<{ code: number; value: unknown }>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => {
      // An absent or unreachable HTTP listener is not proof of identity; local inspection failures must propagate.
      const code = error.code ?? "";
      reject(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ABORT_ERR"].includes(code) || code.startsWith("HPE_")
        ? new UnverifiedListener(error.message, { cause: error }) : error);
    };
    const req = request({ host: LOOPBACK, port, path, method, agent,
      headers: method === "POST" ? { [shutdownHeader]: "1" } : undefined, signal: AbortSignal.timeout(probeMs) }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        body += chunk;
        if (body.length > 4_000_000) req.destroy(new UnverifiedListener("Unexpectedly large local HTTP response"));
      });
      res.on("error", failed);
      res.on("end", () => {
        const code = res.statusCode ?? 0;
        try { resolve({ code, value: JSON.parse(body) }); }
        catch (error) {
          reject(error instanceof SyntaxError ? new InvalidLocalResponse(`Invalid JSON from ${path} (HTTP ${code})`, { cause: error }) : error);
        }
      });
    });
    req.on("error", failed);
    req.on("socket", next => {
      if (useSocket && !useSocket(next)) req.destroy(new UnverifiedListener("Legacy server connection changed"));
      else req.end();
    });
  });
}

export async function getHealth(port: number): Promise<UpgradeHealth> {
  const { code, value } = await localJson(port, "/health", "GET", false);
  if (code !== 200 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidLocalResponse(`Invalid health response (HTTP ${code})`);
  }
  return value as UpgradeHealth;
}

async function inspectPs(pid: number, format: string, wide = false): Promise<string> {
  try {
    return (await command("ps", [...(wide ? ["-ww"] : []), "-p", String(pid), "-o", format],
      { env: psEnv, ms: probeMs, exitCodes: [0, 1], rejectStderr: true })).trim();
  } catch (error) {
    throw new Error(`Could not inspect process ${pid} with ps: ${errorText(error)}`, { cause: error });
  }
}

export async function identify(pid: number): Promise<ProcessIdentity | undefined> {
  const row = await inspectPs(pid, "stat=,lstart=");
  const match = /^(\S+)\s+(.+)$/.exec(row);
  if (match) return match[1].startsWith("Z") ? undefined : { pid, start: match[2] };
  // If ps did not find the process, distinguish absence from failure to inspect a still-live PID.
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
  throw new Error(`Cannot identify process ${pid}`);
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
  return new Set(requiredProcEntry("/proc/net/tcp", path => readFileSync(path, "utf8")).trim().split("\n").slice(1)
    .map(line => line.trim().split(/\s+/)).filter(row => row[1] === address && row[3] === "0A").map(row => row[9]));
}

function requiredProcEntry<T>(path: string, read: (path: string) => T): T {
  try { return read(path); }
  catch (error) { throw new Error(`Could not inspect ${path} during legacy ownership check: ${errorText(error)}`, { cause: error }); }
}

function procEntry<T>(path: string, read: (path: string) => T, skipInaccessible = false): T | undefined {
  try { return read(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH" || (skipInaccessible && (code === "EACCES" || code === "EPERM"))) return undefined;
    throw new Error(`Could not inspect ${path} during legacy ownership check: ${errorText(error)}`, { cause: error });
  }
}

async function legacyOwner(paths: UpgradePaths, j: UpgradeJournal): Promise<ProcessIdentity> {
  const lock = join(paths.data, "owner.sqlite");
  try { assertOwnerFiles(paths); }
  catch (error) { throw new Error(`Could not inspect ${lock} during legacy ownership check: ${errorText(error)}`, { cause: error }); }
  let pids: number[];
  if (process.platform === "linux") {
    const sockets = linuxListeningInodes(j.port);
    pids = requiredProcEntry("/proc", path => readdirSync(path)).filter(value => /^\d+$/.test(value)).map(Number).filter(pid => {
      const dir = `/proc/${pid}/fd`;
      // Unrelated processes may be inaccessible. Once a PID matches, do not ignore permission failures.
      const fds = procEntry(dir, path => readdirSync(path), true);
      if (!fds) return false;
      const links = fds.map(fd => procEntry(`${dir}/${fd}`, path => readlinkSync(path), true) ?? "");
      return links.includes(lock) && links.some(link => sockets.has(/^socket:\[(\d+)\]$/.exec(link)?.[1] ?? ""));
    });
  } else {
    const lsof = async (args: string[]) => {
      try { return await command("/usr/sbin/lsof", ["-nP", "-Fp", ...args], { ms: 3_000, exitCodes: [0, 1], rejectStderr: true }); }
      catch (error) { throw new Error(`lsof failed during legacy ownership check: ${errorText(error)}`, { cause: error }); }
    };
    const listening = [...new Set((await lsof([`-iTCP@${LOOPBACK}:${j.port}`, "-sTCP:LISTEN"])).split("\n")
      .filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
    pids = [];
    for (const pid of listening) {
      // lsof takes the intersection with -a. A process merely on this port is not proof of ownership.
      if ((await lsof(["-a", "-p", String(pid), "--", lock])).split("\n").includes(`p${pid}`)) pids.push(pid);
    }
  }
  if (pids.length !== 1) throw new UnverifiedListener("Could not match one legacy listener to this installation's owner.sqlite");
  const [pid] = pids;
  const identity = await identify(pid);
  if (!identity) throw new UnverifiedListener(`Legacy listener ${pid} exited during verification`);
  const argv = [["--install-dir", paths.root, "--port", String(j.port)], ["--port", String(j.port), "--install-dir", paths.root]];
  if (j.port === DEFAULT_PORT) argv.push(["--install-dir", paths.root]);
  const scripts = [join(paths.current, "src/main.ts"), join(paths.release(j.old), "src/main.ts")];
  let matches: boolean;
  if (process.platform === "linux") {
    const cmd = procEntry(`/proc/${pid}/cmdline`, path => readFileSync(path, "utf8"));
    const [node, script, ...rest] = (cmd ?? "").split("\0").slice(0, -1);
    matches = /(?:^|\/)node$/.test(node) && scripts.includes(script) && argv.some(args => JSON.stringify(args) === JSON.stringify(rest));
  } else {
    const line = await inspectPs(pid, "command=", true);
    if (!line) {
      if (!(await identify(pid))) throw new UnverifiedListener(`Legacy listener ${pid} exited during verification`);
      throw new Error(`Cannot inspect command line for process ${pid}`);
    }
    // ps prints the arguments joined with spaces. Compare only the documented launch forms, not a shell parse.
    const node = /^(\S*\/node|node) /.exec(line)?.[0];
    matches = !!node && scripts.some(script => argv.some(args => line.slice(node.length) === [script, ...args].join(" ")));
  }
  if (!matches || (await identify(pid))?.start !== identity.start) {
    throw new UnverifiedListener("Legacy upgrade requires the documented absolute main.ts launch, --install-dir, and no other overrides");
  }
  try {
    ownDataDir(paths.data)();
  } catch (error) {
    if (error instanceof OwnerBusy) return identity;
    throw new Error(`Could not check the exclusive lock on ${lock}: ${errorText(error)}`, { cause: error });
  }
  throw new UnverifiedListener("Legacy listener is not holding the exclusive conversation owner lock");
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
      || value.modelStatus !== "available") throw new UnverifiedListener("Legacy /health did not verify the expected SHA and available root model");
    const branches = await call("/api/branches");
    const list = (branches.value as { branches?: { busy?: boolean }[] } | null)?.branches;
    if (branches.code !== 200 || !Array.isArray(list) || !list.length || list.some(branch => branch?.busy !== false)) {
      throw new UnverifiedListener("Legacy server has active work or could not verify idle branches");
    }
    const again = await legacyOwner(paths, j);
    if (again.pid !== identity.pid || again.start !== identity.start) throw new UnverifiedListener("Legacy listener changed");
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

export function sendParent(message: Parameters<NonNullable<typeof process.send>>[0]): Promise<void> {
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
    try { health = await getHealth(j.port); }
    catch (error) {
      if (error instanceof InvalidLocalResponse) throw error;
      lastError = error;
    }
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
  throw new Error(`Timed out waiting for candidate readiness${lastError instanceof Error ? `: ${lastError.message}` : ""}`, { cause: lastError });
}

/** This is after commit: failure can require a manual start, never a destructive rollback. */
export async function confirmActivation(server: ServerChild, j: UpgradeJournal, sha: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastProbeError: unknown;
  do {
    if (server.error) break;
    try {
      const health = await getHealth(j.port);
      const mismatch: string[] = [];
      if (health.ok !== true) mismatch.push("ok is not true");
      if (health.commit !== sha) {
        const actual = typeof health.commit === "string" && shaPattern.test(health.commit) ? health.commit : "unknown";
        mismatch.push(`expected SHA ${sha}, received ${actual}`);
      }
      if (health.pid !== server.child.pid) {
        const actual = Number.isSafeInteger(health.pid) ? health.pid : "unknown";
        mismatch.push(`expected PID ${server.child.pid}, received ${actual}`);
      }
      if (health.validation) mismatch.push("validation is still present");
      if (!mismatch.length && !server.error) return;
      lastProbeError = mismatch.length ? new Error(`HTTP 200 but ${mismatch.join(", ")}`) : undefined;
    } catch (error) { lastProbeError = error; }
    if (server.error) break;
    await sleep(100);
  } while (Date.now() < deadline);
  const detail = [
    lastProbeError !== undefined && `Last /health probe: ${errorText(lastProbeError)}`,
    server.error && errorText(server.error),
  ].filter(Boolean).join("; ");
  throw new Error(`${sha} was committed, but did not confirm activation${detail ? ` (${detail})` : ""}. `
    + "Check the log and start the selected release if stopped; do not restore over it.", { cause: server.error ?? lastProbeError });
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
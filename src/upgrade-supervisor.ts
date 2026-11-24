#!/usr/bin/env node
/**
 * The upgrade supervisor: a one-shot script the server starts for `/upgrade`, from the release that is running.
 *
 * 1. Stage: fetch `main` into `deploy/<sha>` and install it. The old server keeps running, and a failure ends here.
 * 2. Switch: stop the old server, back up the database, record the upgrade in `pending.json`, point `deploy/current`
 *    at the new release and start it.
 * 3. Verify: the new server checks itself as it starts. If it is healthy it reports in the requesting branch and
 *    removes `pending.json`, which commits the upgrade. If not, it exits.
 * 4. Fall back, on any failure after the old server stopped: stop the new server, restore the database, point
 *    `current` back and start the old release.
 *
 * `pending.json` exists exactly while the database may hold changes made by a release that has not passed its health
 * check. A server that finds it at startup with no supervisor running runs `recover`, which is step 4 again.
 *
 * Later releases read the files an earlier release's supervisor wrote, so `Pending` and `Result` keep their shape.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { LOOPBACK, readConfig } from "./config.ts";
import { ownDataDir, ownLock } from "./ownership.ts";

/** An upgrade between stopping the old server and the new one passing its health check. */
export interface Pending { old: string; new: string; branch: number; port: number; tailscaleOrigin?: string }

/** An outcome the next server to start, or the one still running, posts in the requesting branch. */
export interface Result { branch: number; text: string }

const stopMs = 30_000;
const startMs = 60_000;
const installMs = 10 * 60_000;

/** Where an install root keeps its releases and the state of an upgrade. */
export function upgradeFiles(root: string) {
  const dir = join(root, "upgrade");
  const deploy = join(root, "deploy");
  return {
    dir, deploy, current: join(deploy, "current"),
    pending: join(dir, "pending.json"), result: join(dir, "result.json"), lock: join(dir, "lock.sqlite"),
    /** The database as the old release left it; kept until the next upgrade replaces it. */
    backup: join(dir, "backup.sqlite"),
    /** The supervisor's output, and the output of the servers it starts. */
    log: join(dir, "upgrade.log"), serverLog: join(dir, "server.log"),
  };
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Signal a process that may already be gone. */
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // It has exited.
  }
}
const short = (sha: string) => sha.slice(0, 7);
const log = (text: string) => console.log(`${new Date().toISOString()} ${text}`);

async function run(file: string, args: string[], cwd?: string, timeout = 120_000): Promise<string> {
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    return (await promisify(execFile)(file, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().slice(-600);
    throw new Error(`${file} ${args[0]} failed: ${stderr || message(error)}`);
  }
}

/** Make `deploy/<sha>` for the tip of `main`, the way the install runbook does by hand, and return the SHA. */
async function stage(root: string, old: string): Promise<string> {
  const { deploy } = upgradeFiles(root);
  const origin = await run("git", ["remote", "get-url", "origin"], join(deploy, old));
  const [sha] = (await run("git", ["ls-remote", origin, "refs/heads/main"])).split(/\s/);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Cannot resolve main at ${origin}`);
  // A release directory is renamed into place only when it is complete, so one left by an earlier attempt is usable.
  if (sha === old || existsSync(join(deploy, sha))) return sha;
  const staging = join(deploy, ".staging");
  rmSync(staging, { recursive: true, force: true });
  log(`Staging ${sha} from ${origin}`);
  await run("git", ["clone", "--quiet", origin, staging]);
  await run("git", ["checkout", "--quiet", "--detach", sha], staging);
  await run("npm", ["ci", "--ignore-scripts"], staging, installMs);
  renameSync(staging, join(deploy, sha));
  return sha;
}

/**
 * Wait until no server owns the data directory, and own it. A server releases it last, after its listener and its
 * database have closed, and the operating system releases it for a process that died.
 */
async function ownData(dataDir: string, ms: number): Promise<() => void> {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    try {
      return ownDataDir(dataDir);
    } catch (error) {
      if (Date.now() > end) throw error;
    }
  }
}

/** Copy the database, with everything committed to its write-ahead log, to one standalone file. */
export async function backupDb(db: string, to: string): Promise<void> {
  rmSync(`${to}.tmp`, { force: true });
  const source = new DatabaseSync(db);
  try {
    await backup(source, `${to}.tmp`);
  } finally {
    source.close();
  }
  renameSync(`${to}.tmp`, to);
}

/** Put the backup in place of the database, without the write-ahead log a failed release left beside it. */
export function restoreDb(from: string, db: string): void {
  copyFileSync(from, `${db}.restore`);
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(db + suffix, { force: true });
  renameSync(`${db}.restore`, db);
}

/** Repoint `deploy/current` in one step. */
function point(root: string, sha: string): void {
  const { current } = upgradeFiles(root);
  rmSync(`${current}.tmp`, { force: true });
  symlinkSync(sha, `${current}.tmp`);
  renameSync(`${current}.tmp`, current);
  log(`deploy/current -> ${sha}`);
}

async function healthy(port: number, commit: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${LOOPBACK}:${port}/health`, { signal: AbortSignal.timeout(2_000) });
    const health = await response.json() as { ok?: boolean; commit?: string };
    return response.ok && health.ok === true && health.commit === commit;
  } catch {
    return false;
  }
}

async function stopChild(child: ChildProcess, ended: Promise<unknown>): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    child.kill(signal);
    if (await Promise.race([ended.then(() => true), sleep(stopMs / 2, false, { ref: false })])) return;
  }
}

/**
 * Start `deploy/current` the way the runbook does and wait until it serves `commit` and `ready()` holds. The server
 * outlives this script. If it does not get there it is stopped, and the error carries the end of its output.
 */
async function serve(
  root: string, port: number, commit: string, tailscaleOrigin?: string, ready: () => boolean = () => true,
): Promise<void> {
  const { current, serverLog } = upgradeFiles(root);
  const before = statSync(serverLog, { throwIfNoEntry: false })?.size ?? 0;
  const out = openSync(serverLog, "a");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [
      join(current, "src/main.ts"), "--install-dir", root, "--port", String(port),
      ...(tailscaleOrigin ? ["--tailscale-origin", tailscaleOrigin] : []),
    ], { cwd: root, detached: true, stdio: ["ignore", out, out] });
  } finally {
    closeSync(out);
  }
  let end: string | undefined;
  const ended = new Promise<void>(resolve => {
    child.once("error", error => { end = `could not start: ${error.message}`; resolve(); });
    child.once("exit", (code, signal) => { end = `exited during startup (${signal ?? code})`; resolve(); });
  });
  log(`Starting ${commit} (pid ${child.pid})`);
  let up = false;
  for (const deadline = Date.now() + startMs; !up && !end && Date.now() < deadline;) {
    await sleep(200);
    up = ready() && await healthy(port, commit);
  }
  if (up && !end) {
    child.unref();
    return;
  }
  await stopChild(child, ended);
  const output = readFileSync(serverLog).subarray(before).toString("utf8").trim().split("\n").slice(-6).join("\n").slice(-800);
  throw new Error(`${short(commit)} ${end ?? "did not become healthy in time"}${output ? `:\n${output}` : ""}`);
}

/** Step 4. Safe to run again after an interruption: the pending record goes only once the old state is back. */
async function rollback(root: string, pending: Pending, reason: string, restore = true): Promise<void> {
  const files = upgradeFiles(root);
  const { dataDir } = readConfig(["--install-dir", root]);
  log(`Falling back to ${pending.old}: ${reason}`);
  const release = await ownData(dataDir, stopMs);
  try {
    if (restore) restoreDb(files.backup, join(dataDir, "aipatty.sqlite"));
    point(root, pending.old);
    writeJson(files.result, {
      branch: pending.branch,
      text: `Upgrade to ${short(pending.new)} failed and was rolled back. Running ${short(pending.old)} again.\n${reason}`,
    } satisfies Result);
    rmSync(files.pending, { force: true });
  } finally {
    release();
  }
  await serve(root, pending.port, pending.old, pending.tailscaleOrigin);
  log(`Rolled back to ${pending.old}`);
}

async function upgrade(root: string, port: number, branch: number, tailscaleOrigin?: string): Promise<void> {
  // The server that asked is this script's parent, for as long as it lives.
  const server = process.ppid;
  const files = upgradeFiles(root);
  const { dataDir } = readConfig(["--install-dir", root]);
  const old = basename(realpathSync(files.current));
  const report = (text: string) => { log(text); writeJson(files.result, { branch, text } satisfies Result); };
  let sha: string;
  try {
    sha = await stage(root, old);
  } catch (error) {
    report(`Upgrade failed before anything changed. Still running ${short(old)}.\n${message(error)}`);
    return;
  }
  if (sha === old) {
    report(`Already up to date: ${short(old)} is the latest main.`);
    return;
  }

  const pending: Pending = { old, new: sha, branch, port, tailscaleOrigin };
  let switched = false;
  try {
    // A parent that changed means the server has already gone, and its successor is not ours to signal.
    const stop = (name: NodeJS.Signals) => { if (process.ppid === server) signal(server, name); };
    log(`Stopping ${old} (pid ${server})`);
    stop("SIGTERM");
    const release = await ownData(dataDir, stopMs).catch(() => {
      stop("SIGKILL");
      return ownData(dataDir, 5_000);
    });
    try {
      await backupDb(join(dataDir, "aipatty.sqlite"), files.backup);
      writeJson(files.pending, pending);
      switched = true;
      point(root, sha);
    } finally {
      release();
    }
    await serve(root, port, sha, tailscaleOrigin, () => !existsSync(files.pending));
    log(`Upgraded to ${sha}`);
  } catch (error) {
    await rollback(root, pending, message(error), switched);
  }
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        "install-dir": { type: "string" }, port: { type: "string" }, branch: { type: "string" },
        "tailscale-origin": { type: "string" },
      },
    });
    const [mode] = positionals;
    const root = values["install-dir"];
    const start = mode === "start" && values.port !== undefined && values.branch !== undefined;
    if (!root || positionals.length !== 1 || !(start || mode === "recover")) {
      throw new Error("Usage: upgrade-supervisor.ts start --install-dir <root> --port <n> --branch <id>\n"
        + "       upgrade-supervisor.ts recover --install-dir <root>");
    }
    const files = upgradeFiles(root);
    mkdirSync(files.dir, { recursive: true });
    const unlock = ownLock(files.lock, "Another upgrade is running in this installation");
    try {
      if (start) {
        await upgrade(root, Number(values.port), Number(values.branch), values["tailscale-origin"]);
      } else {
        const pending = readJson<Pending>(files.pending);
        if (pending) await rollback(root, pending, "The upgrade was interrupted before the new release passed its health check.");
        else log("No interrupted upgrade to recover.");
      }
    } finally {
      unlock();
    }
  } catch (error) {
    log(`Upgrade supervisor failed: ${message(error)}`);
    process.exitCode = 1;
  }
}

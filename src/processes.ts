import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** One row of the process table. `start` tells a process from a later one that reuses its ID. */
export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  start: string;
}

/** The environment variable that marks every process a run starts, as far as the processes pass it on. */
export const RUN_MARKER = "PATTY_RUN_ID";

/** A run's remembered process IDs with start times, and group IDs. Group IDs alone are not proof of ownership. */
export interface Owned {
  procs: Map<number, string>;
  groups: Set<number>;
}

export function newOwned(procs: Iterable<[number, string]> = [], groups: Iterable<number> = []): Owned {
  return { procs: new Map(procs), groups: new Set(groups) };
}

async function ps(args: string[]): Promise<string> {
  // The C locale fixes the format of the start time.
  return (await exec("ps", args, { maxBuffer: 64 * 1024 * 1024, timeout: 5_000, env: { ...process.env, LC_ALL: "C" } })).stdout;
}

/** This process's own group, once the process table has been read: never a run's. */
let hostGroup: number | undefined;

export async function listProcesses(): Promise<Proc[]> {
  const procs: Proc[] = [];
  for (const line of (await ps(["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="])).split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    // A zombie has exited and cannot keep an owner lock or do work. Some PID 1s take time to reap it.
    if (row && !row[4].startsWith("Z")) procs.push({ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), start: row[5] });
  }
  hostGroup = procs.find(proc => proc.pid === process.pid)?.pgid ?? hostGroup;
  return procs;
}

function commands(output: string): Map<number, string> {
  const rows = new Map<number, string>();
  for (const line of output.split("\n")) {
    const row = /^\s*(\d+)\s(.*)$/.exec(line);
    if (row) rows.set(Number(row[1]), row[2]);
  }
  return rows;
}

/**
 * The IDs of the processes whose environment has `RUN_MARKER=<runId>`. Best effort: macOS hides the environment of
 * its own binaries, such as `/bin/bash`, and both systems hide other users' processes.
 */
async function markedPids(runId: string, procs: readonly Proc[], variable: string): Promise<Set<number>> {
  const needle = `${variable}=${runId}`;
  const marked = new Set<number>();
  if (process.platform === "linux") {
    // Bound descriptors and never interpret a resource/I/O failure as proof of no marker.
    for (let offset = 0; offset < procs.length; offset += 16) {
      await Promise.all(procs.slice(offset, offset + 16).map(async proc => {
        try {
          if ((await readFile(`/proc/${proc.pid}/environ`, "utf8")).split("\0").includes(needle)) marked.add(proc.pid);
        } catch (error) {
          // Gone since ps, or an environment the OS does not disclose (e.g. another user).
          if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            throw new Error(`Could not inspect process ${proc.pid}'s environment`, { cause: error });
          }
        }
      }));
    }
    return marked;
  }
  // `ps -E` prints the arguments and then the environment. Only the environment counts: a process that merely
  // has the marker among its arguments, such as a search for it, is not the run's. The entries are not delimited,
  // so a value that itself contains the marker with this run's random ID would also match.
  // A scan that fails as a whole rejects: it must not pass for one that found nothing.
  const [plain, withEnv] = await Promise.all([
    ps(["-A", "-ww", "-o", "pid=,command="]), ps(["-A", "-E", "-ww", "-o", "pid=,command="]),
  ]);
  const args = commands(plain);
  for (const [pid, full] of commands(withEnv)) {
    const own = args.get(pid);
    if (own === undefined || !full.startsWith(own)) continue;
    if (` ${full.slice(own.length)} `.includes(` ${needle} `)) marked.add(pid);
  }
  return marked;
}

/**
 * The live processes that belong to a run: those it remembers (same ID and start time), those carrying its marker,
 * and everything reached from them as a child or as a member of the same group. A process that left both its
 * parent and its group, and hides its environment, is not found unless it was remembered.
 *
 * `unsure` are members of remembered, leaderless groups that were not identified by this evidence. They may
 * be the run's or belong to a new group that reused the ID. They are not signalled and keep cleanup pending.
 *
 * Forgets remembered groups that have no member left. The result is from a process table read last, after the
 * slower environment scan: act on it at once.
 */
async function scan(owned: Owned, runId: string, variable: string): Promise<{ ours: Proc[]; unsure: Proc[] }> {
  const before = new Map((await listProcesses()).map(proc => [proc.pid, proc.start]));
  const marked = await markedPids(runId, [...before].map(([pid, start]) => ({ pid, ppid: 0, pgid: 0, start })), variable);
  const procs = await listProcesses();
  const byPid = new Map(procs.map(proc => [proc.pid, proc]));
  for (const pgid of owned.groups) {
    if (!procs.some(proc => proc.pgid === pgid)) owned.groups.delete(pgid);
  }
  // Never this process, its group, or the system's.
  const skipGroups = new Set([0, 1, byPid.get(process.pid)?.pgid ?? -1]);
  const candidate = (proc: Proc) => proc.pid !== process.pid && proc.pid > 1;
  // Marked, and still the process that was scanned.
  const isMarked = (proc: Proc) => marked.has(proc.pid) && before.get(proc.pid) === proc.start;
  // A remembered, leaderless group can flag ambiguity, but cannot seed ownership.
  const leaderless = (proc: Proc) => owned.groups.has(proc.pgid) && !skipGroups.has(proc.pgid) && !byPid.has(proc.pgid);
  const ours = new Map<number, Proc>();
  for (const proc of procs) {
    if (!candidate(proc)) continue;
    if (owned.procs.get(proc.pid) === proc.start || isMarked(proc)) ours.set(proc.pid, proc);
  }
  for (let grew = true; grew;) {
    grew = false;
    const groups = new Set([...ours.values()].map(proc => proc.pgid).filter(pgid => !skipGroups.has(pgid)));
    for (const proc of procs) {
      if (ours.has(proc.pid) || !candidate(proc)) continue;
      if (ours.has(proc.ppid) || groups.has(proc.pgid)) {
        ours.set(proc.pid, proc);
        grew = true;
      }
    }
  }
  return { ours: [...ours.values()], unsure: procs.filter(proc => candidate(proc) && !ours.has(proc.pid) && leaderless(proc)) };
}

/** The live processes that belong to a run; see `scan`. Rejects when the process table cannot be read. */
export async function runProcesses(owned: Owned, runId: string, variable = RUN_MARKER): Promise<Proc[]> {
  return (await scan(owned, runId, variable)).ours;
}

/** Remember a run's processes and their groups. Returns whether a process or group was new. */
export function remember(owned: Owned, procs: readonly Proc[]): boolean {
  const before = owned.procs.size + owned.groups.size;
  for (const proc of procs) {
    owned.procs.set(proc.pid, proc.start);
    // Remember the group even if we never saw its leader. The host's own group is not the run's.
    if (proc.pgid > 1 && proc.pgid !== hostGroup) owned.groups.add(proc.pgid);
  }
  return owned.procs.size + owned.groups.size !== before;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone, or not ours to signal.
  }
}

/**
 * Stop a run's processes. `root` gets SIGTERM first, through `term` when the caller still holds the child, and
 * `graceMs` to stop its own children, as Pi and the delegates extension do; whatever is left is killed. Every
 * signal goes to a process found, by ID and start time, in a process table read just before, so a process that
 * took over a dead one's ID is not signalled. Returns what is left: the survivors, and the processes that could not
 * be told from the run's, which are not signalled. `record` saves what the run remembers whenever that grows.
 * Rejects when the table cannot be read.
 */
export async function stopRun(
  owned: Owned, runId: string, root: number | undefined, graceMs: number, term?: () => void, record?: () => Promise<unknown>,
  variable = RUN_MARKER,
): Promise<Proc[]> {
  // Remember the tree before it comes apart, and have the caller save it: a group found only now would otherwise
  // be forgotten if this process dies with a member of it still alive.
  const tree = await runProcesses(owned, runId, variable);
  if (remember(owned, tree)) await record?.();
  const rootStart = root === undefined ? undefined : owned.procs.get(root);
  if (root !== undefined && rootStart !== undefined && tree.some(proc => proc.pid === root && proc.start === rootStart)) {
    // Through the live child handle when there is one, which cannot reach a process that reused the ID.
    if (term) term();
    else signal(root, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await sleep(100);
      if (!(await listProcesses()).some(proc => proc.pid === root && proc.start === rootStart)) break;
    }
  }
  let left: Proc[] = [];
  let unsure: Proc[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    ({ ours: left, unsure } = await scan(owned, runId, variable));
    if (!left.length) break;
    if (remember(owned, left)) await record?.();
    for (const proc of left) signal(proc.pid, "SIGKILL");
    await sleep(150);
  }
  return [...left, ...unsure];
}

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

/**
 * What a run remembers of its processes: each one's ID and start time, and the process groups its own processes
 * led. A group outlives its leader while any member lives, and the system does not reuse the leader's ID until then.
 */
export interface Owned {
  procs: Map<number, string>;
  groups: Set<number>;
}

export function newOwned(procs: Iterable<[number, string]> = [], groups: Iterable<number> = []): Owned {
  return { procs: new Map(procs), groups: new Set(groups) };
}

async function ps(args: string[]): Promise<string> {
  return (await exec("ps", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
}

export async function listProcesses(): Promise<Proc[]> {
  const procs: Proc[] = [];
  for (const line of (await ps(["-A", "-o", "pid=,ppid=,pgid=,lstart="])).split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (row) procs.push({ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), start: row[4] });
  }
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
async function markedPids(runId: string, procs: readonly Proc[]): Promise<Set<number>> {
  const needle = `${RUN_MARKER}=${runId}`;
  const marked = new Set<number>();
  if (process.platform === "linux") {
    await Promise.all(procs.map(async proc => {
      const environ = await readFile(`/proc/${proc.pid}/environ`, "utf8").catch(() => "");
      if (environ.split("\0").includes(needle)) marked.add(proc.pid);
    }));
    return marked;
  }
  // `ps -E` prints the arguments and then the environment. Only the environment counts: a process that merely
  // has the marker among its arguments, such as a search for it, is not the run's.
  const [plain, withEnv] = await Promise.all([
    ps(["-A", "-ww", "-o", "pid=,command="]), ps(["-A", "-E", "-ww", "-o", "pid=,command="]),
  ]).catch(() => ["", ""]);
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
 * the members of the groups its processes led, and everything reached from them as a child or as a member of the
 * same group. Pi and the delegates extension start their children as group leaders, so an orphan whose parent, or
 * whose group leader, died is still found. A process that left both its parent and its group, and hides its
 * environment, is not found. The result is one snapshot of the process table: act on it at once.
 */
export async function runProcesses(owned: Owned, runId: string): Promise<Proc[]> {
  const procs = await listProcesses();
  const marked = await markedPids(runId, procs);
  const byPid = new Map(procs.map(proc => [proc.pid, proc]));
  // Never this process, its group, or the system's.
  const skipGroups = new Set([0, 1, byPid.get(process.pid)?.pgid ?? -1]);
  const candidate = (proc: Proc) => proc.pid !== process.pid && proc.pid > 1;
  // A remembered group is still the run's unless its ID now names another process, which then leads a new group.
  const ownGroup = (pgid: number) => owned.groups.has(pgid) && !skipGroups.has(pgid)
    && (!byPid.has(pgid) || owned.procs.get(pgid) === byPid.get(pgid)!.start);
  const ours = new Map<number, Proc>();
  for (const proc of procs) {
    if (!candidate(proc)) continue;
    if (owned.procs.get(proc.pid) === proc.start || marked.has(proc.pid) || ownGroup(proc.pgid)) ours.set(proc.pid, proc);
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
  return [...ours.values()];
}

/** Add a run's processes, and the groups they lead, to what it remembers. Returns whether anything was new. */
export function remember(owned: Owned, procs: readonly Proc[]): boolean {
  const before = owned.procs.size + owned.groups.size;
  for (const proc of procs) {
    owned.procs.set(proc.pid, proc.start);
    if (proc.pgid === proc.pid) owned.groups.add(proc.pgid);
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
 * `graceMs` to stop its own children, as Pi and the delegates extension do; whatever is left is killed. Every signal goes to a process found in a snapshot taken just before,
 * by ID and start time, so a process that took over a dead one's ID is not signalled. Returns the survivors.
 */
export async function stopRun(
  owned: Owned, runId: string, root: number | undefined, graceMs: number, term?: () => void,
): Promise<Proc[]> {
  // Remember the tree before it comes apart.
  const tree = await runProcesses(owned, runId);
  remember(owned, tree);
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
  for (let attempt = 0; attempt < 20; attempt++) {
    left = await runProcesses(owned, runId);
    if (!left.length) break;
    remember(owned, left);
    for (const proc of left) signal(proc.pid, "SIGKILL");
    await sleep(150);
  }
  return left;
}

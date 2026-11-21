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
 * What a run remembers of its processes: each one's ID and start time, the process groups its own processes led,
 * and when it last saw them (`asOf`, in milliseconds). A group outlives its leader while any member lives. Once it
 * is empty its ID can name a new group, so a leaderless group's members count as the run's only if they had
 * started by `asOf`.
 */
export interface Owned {
  procs: Map<number, string>;
  groups: Set<number>;
  asOf: number;
}

export function newOwned(procs: Iterable<[number, string]> = [], groups: Iterable<number> = [], asOf = 0): Owned {
  return { procs: new Map(procs), groups: new Set(groups), asOf };
}

async function ps(args: string[]): Promise<string> {
  // The C locale fixes the format of the start time.
  return (await exec("ps", args, { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } })).stdout;
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
 * the members of the groups its processes led, and everything reached from them as a child or as a member of the
 * same group. Pi and the delegates extension start their children as group leaders, so an orphan whose parent, or
 * whose group leader, died is still found. A process that left both its parent and its group, and hides its
 * environment, is not found.
 *
 * `unsure` are members of a remembered, leaderless group that started after the run last saw it: a late child of
 * the run's, or a stranger in a group whose ID was reused. They are not the run's to kill, and not proof that the
 * run is gone either.
 *
 * Forgets remembered groups that have no member left. The result is from a process table read last, after the
 * slower environment scan: act on it at once.
 */
async function scan(owned: Owned, runId: string): Promise<{ ours: Proc[]; unsure: Proc[] }> {
  const before = new Map((await listProcesses()).map(proc => [proc.pid, proc.start]));
  const marked = await markedPids(runId, [...before].map(([pid, start]) => ({ pid, ppid: 0, pgid: 0, start })));
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
  // A member of a remembered group whose leader is gone. With a live leader the group is the run's only through
  // that leader, which is then remembered itself.
  const leaderless = (proc: Proc) => owned.groups.has(proc.pgid) && !skipGroups.has(proc.pgid) && !byPid.has(proc.pgid);
  const startedBy = (proc: Proc) => {
    const started = Date.parse(proc.start);
    return Number.isFinite(started) && started <= owned.asOf;
  };
  const ours = new Map<number, Proc>();
  for (const proc of procs) {
    if (!candidate(proc)) continue;
    if (owned.procs.get(proc.pid) === proc.start || isMarked(proc) || (leaderless(proc) && startedBy(proc))) ours.set(proc.pid, proc);
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
export async function runProcesses(owned: Owned, runId: string): Promise<Proc[]> {
  return (await scan(owned, runId)).ours;
}

/**
 * Add a run's processes, and the groups they lead, to what it remembers. `seenAt` is when they were seen while the
 * run was being watched; a recovery, which may come long after, leaves `asOf` alone. Returns whether a process or
 * group was new.
 */
export function remember(owned: Owned, procs: readonly Proc[], seenAt?: number): boolean {
  const before = owned.procs.size + owned.groups.size;
  for (const proc of procs) {
    owned.procs.set(proc.pid, proc.start);
    if (proc.pgid === proc.pid) owned.groups.add(proc.pgid);
  }
  if (seenAt !== undefined) owned.asOf = Math.max(owned.asOf, seenAt);
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
 * be told from the run's, which are not signalled. Rejects when the table cannot be read.
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
  let unsure: Proc[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    ({ ours: left, unsure } = await scan(owned, runId));
    if (!left.length) break;
    remember(owned, left);
    for (const proc of left) signal(proc.pid, "SIGKILL");
    await sleep(150);
  }
  return [...left, ...unsure];
}

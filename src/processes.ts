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
 * What a run remembers: each process's ID and start time, and each group's last observation of an owned member
 * (milliseconds, or null when unknown). A group outlives its leader while any member lives. Once empty its ID can
 * name a new group, so a leaderless group's members count as the run's only if they had started by that group's
 * own observation time.
 */
export interface Owned {
  procs: Map<number, string>;
  groups: Map<number, number | null>;
  /** PIDs from a legacy record whose ownership may have been inferred from the unsafe run-wide cutoff. */
  unverifiedProcs: Map<number, string>;
}

export function newOwned(
  procs: Iterable<[number, string]> = [], groups: Iterable<[number, number | null]> = [],
  unverifiedProcs: Iterable<[number, string]> = [],
): Owned {
  return { procs: new Map(procs), groups: new Map(groups), unverifiedProcs: new Map(unverifiedProcs) };
}

async function ps(args: string[]): Promise<string> {
  // The C locale fixes the format of the start time.
  return (await exec("ps", args, { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } })).stdout;
}

/** This process's own group, once the process table has been read: never a run's. */
let hostGroup: number | undefined;

export async function listProcesses(): Promise<Proc[]> {
  const procs: Proc[] = [];
  for (const line of (await ps(["-A", "-o", "pid=,ppid=,pgid=,lstart="])).split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (row) procs.push({ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), start: row[4] });
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
 * `unsure` are unverified processes from a legacy record and unverified members of remembered, leaderless groups:
 * they may be late children of the run's, or strangers in a group whose ID was reused. They are not the run's to
 * kill, and not proof that the run is gone either.
 *
 * Forgets empty groups and cutoffs invalidated by a clock rollback. The result is from a process table read last,
 * after the slower environment scan: act on it at once.
 */
async function scan(owned: Owned, runId: string): Promise<{ ours: Proc[]; unsure: Proc[]; groupsChanged: boolean }> {
  const before = new Map((await listProcesses()).map(proc => [proc.pid, proc.start]));
  const marked = await markedPids(runId, [...before].map(([pid, start]) => ({ pid, ppid: 0, pgid: 0, start })));
  const procs = await listProcesses();
  const byPid = new Map(procs.map(proc => [proc.pid, proc]));
  const liveGroups = new Set(procs.map(proc => proc.pgid));
  const now = Date.now();
  let groupsChanged = false;
  for (const [pgid, seenAt] of owned.groups) {
    if (!liveGroups.has(pgid)) {
      owned.groups.delete(pgid);
      groupsChanged = true;
    } else if (seenAt !== null && seenAt > now) {
      owned.groups.set(pgid, null);
      groupsChanged = true;
    }
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
    const seenAt = owned.groups.get(proc.pgid);
    const started = Date.parse(proc.start);
    // ps gives whole seconds. A process starting in the observation's own second might have started later.
    return seenAt != null && Number.isFinite(started) && started + 1_000 <= seenAt;
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
  const unsure = procs.filter(proc => candidate(proc) && !ours.has(proc.pid)
    && (owned.unverifiedProcs.get(proc.pid) === proc.start || leaderless(proc)));
  return { ours: [...ours.values()], unsure, groupsChanged };
}

/** The live processes that belong to a run; see `scan`. Rejects when the process table cannot be read. */
export async function runProcesses(owned: Owned, runId: string): Promise<Proc[]> {
  return (await scan(owned, runId)).ours;
}

/** Poll a live run, returning whether its recovery record needs updating. */
export async function trackRunProcesses(owned: Owned, runId: string): Promise<boolean> {
  const seenAt = Date.now();
  const { ours, groupsChanged } = await scan(owned, runId);
  const learned = remember(owned, ours, seenAt);
  return learned || groupsChanged;
}

/**
 * Add a run's processes and groups to what it remembers. Only a group with an owned process observed during the
 * live run gets a new cutoff (`seenAt` is taken before reading the process table). Recovery leaves cutoffs alone.
 * Returns whether the record changed.
 */
export function remember(owned: Owned, procs: readonly Proc[], seenAt?: number): boolean {
  let changed = false;
  for (const proc of procs) {
    if (owned.procs.get(proc.pid) !== proc.start) {
      owned.procs.set(proc.pid, proc.start);
      changed = true;
    }
    // The group of a process of the run is the run's, whether or not its leader was ever seen: the run's
    // processes are started in groups of their own, apart from this process's.
    if (proc.pgid <= 1 || proc.pgid === hostGroup) continue;
    const prior = owned.groups.get(proc.pgid);
    if (prior === undefined || (seenAt !== undefined && (prior === null || seenAt > prior))) {
      owned.groups.set(proc.pgid, seenAt ?? null);
      changed = true;
    }
  }
  return changed;
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
): Promise<Proc[]> {
  // Remember the tree before it comes apart, and have the caller save it: a group found only now would otherwise
  // be forgotten if this process dies with a member of it still alive.
  const tree = await runProcesses(owned, runId);
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
    ({ ours: left, unsure } = await scan(owned, runId));
    if (!left.length) break;
    if (remember(owned, left)) await record?.();
    for (const proc of left) signal(proc.pid, "SIGKILL");
    await sleep(150);
  }
  return [...left, ...unsure];
}

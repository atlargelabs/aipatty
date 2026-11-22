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

interface ProcessScan {
  ours: Proc[];
  unsure: Proc[];
  changed: boolean;
  beganAt: number;
  scannedAt: number;
}

/** Discard group evidence whose observation time is still in the future. */
export function invalidateFutureCutoffs(owned: Owned, at: number): boolean {
  let changed = false;
  for (const [pgid, seenAt] of owned.groups) {
    if (seenAt !== null && seenAt > at) {
      owned.groups.set(pgid, null);
      changed = true;
    }
  }
  return changed;
}

const candidate = (proc: Proc) => proc.pid !== process.pid && proc.pid > 1;
const heldRoot = (proc: Proc, held?: ReadonlySet<number>) => held?.has(proc.pid) && proc.ppid === process.pid && proc.pgid === proc.pid;
// Never expand membership through this host's group or the system's groups.
const excludedGroups = (procs: readonly Proc[]) => new Set([0, 1, procs.find(proc => proc.pid === process.pid)?.pgid ?? hostGroup ?? -1]);

/** Expand independent roots to all their descendants and group members in this snapshot. */
function reachable(procs: readonly Proc[], skipGroups: ReadonlySet<number>, root: (proc: Proc) => boolean | undefined): Map<number, Proc> {
  const ours = new Map<number, Proc>();
  for (const proc of procs) if (candidate(proc) && root(proc)) ours.set(proc.pid, proc);
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
  return ours;
}

async function processSnapshot(
  owned: Owned, runId: string, record?: () => Promise<unknown>, liveChildren?: () => ReadonlySet<number>,
) {
  const first = await listProcesses();
  const held = liveChildren?.();
  // A parent can exit while ps reads again or while we scan environments. Keep independently verified
  // identities now, even if the rest of the scan fails. Only the final table can supply signal targets.
  const early = reachable(first, excludedGroups(first), proc => heldRoot(proc, held) || owned.procs.get(proc.pid) === proc.start);
  const learnedEarly = remember(owned, [...early.values()]);
  if (learnedEarly) await record?.();
  const before = new Map(first.map(proc => [proc.pid, proc.start]));
  const marked = await markedPids(runId, first);
  return { before, learnedEarly, marked, procs: await listProcesses() };
}

/**
 * The live processes that belong to a run: the host's still-held detached children, those it remembers (same ID
 * and start time), those carrying its marker, and everything reached from them by ancestry or group membership.
 * Pi and the delegates extension start their children as group leaders, so an orphan whose parent, or
 * whose group leader, died is still found. A process that left both its parent and its group, and hides its
 * environment, is not found.
 *
 * `unsure` are unverified processes from a legacy record and unverified members of remembered groups with no
 * cutoff or no leader. They may be the run's, or strangers in a group whose ID was reused. They are not the run's
 * to kill, and not proof that the run is gone either.
 *
 * Forgets empty groups and cutoffs invalidated by a clock rollback. The result is from a process table read last,
 * after the slower environment scan: act on it at once.
 */
async function scan(
  owned: Owned, runId: string, record?: () => Promise<unknown>, pendingRecord = false,
  liveChildren?: () => ReadonlySet<number>,
): Promise<ProcessScan> {
  const beganAt = Date.now();
  // Invalidate and save before awaiting ps, in case the clock catches up during the scan or the host dies.
  const invalidatedAtEntry = invalidateFutureCutoffs(owned, beganAt);
  const groupsAtEntry = new Map(owned.groups);
  if (invalidatedAtEntry || pendingRecord) await record?.();
  const { before, learnedEarly, marked, procs } = await processSnapshot(owned, runId, record, liveChildren).catch(async error => {
    if (invalidateFutureCutoffs(owned, Date.now())) await record?.();
    throw error;
  });
  const scannedAt = Date.now();
  let changed = learnedEarly || invalidatedAtEntry;
  const byPid = new Map(procs.map(proc => [proc.pid, proc]));
  const liveGroups = new Set(procs.map(proc => proc.pgid));
  // This snapshot cannot rule out groups added or updated by another operation while it was in flight.
  for (const [pgid, cutoff] of groupsAtEntry) {
    if (!liveGroups.has(pgid) && owned.groups.get(pgid) === cutoff) {
      owned.groups.delete(pgid);
      changed = true;
    }
  }
  changed = invalidateFutureCutoffs(owned, scannedAt) || changed;
  const skipGroups = excludedGroups(procs);
  // Marked, and still the process that was scanned.
  const isMarked = (proc: Proc) => marked.has(proc.pid) && before.get(proc.pid) === proc.start;
  // A member of a remembered group whose leader is gone. With a live leader the group is the run's only through
  // that leader, which is then remembered itself.
  const knownGroup = (proc: Proc) => owned.groups.has(proc.pgid) && !skipGroups.has(proc.pgid);
  const leaderless = (proc: Proc) => knownGroup(proc) && !byPid.has(proc.pgid);
  const startedBy = (proc: Proc) => {
    const seenAt = owned.groups.get(proc.pgid);
    const started = Date.parse(proc.start);
    // ps gives whole seconds. A process starting in the observation's own second might have started later.
    return seenAt != null && Number.isFinite(started) && started + 1_000 <= seenAt;
  };
  // Match handles only to this host's direct detached children; recheck early evidence by identity.
  const held = liveChildren?.();
  const ours = reachable(procs, skipGroups, proc => heldRoot(proc, held) || owned.procs.get(proc.pid) === proc.start
    || isMarked(proc) || (leaderless(proc) && startedBy(proc)));
  const unsure = procs.filter(proc => candidate(proc) && !ours.has(proc.pid)
    && (owned.unverifiedProcs.get(proc.pid) === proc.start
      || (knownGroup(proc) && (owned.groups.get(proc.pgid) === null || !byPid.has(proc.pgid)))));
  return { ours: [...ours.values()], unsure, changed, beganAt, scannedAt };
}

/** The live processes that belong to a run; see `scan`. Rejects when the process table cannot be read. */
export async function runProcesses(owned: Owned, runId: string): Promise<Proc[]> {
  return (await scan(owned, runId)).ours;
}

/** Poll a live run, returning whether its recovery record needs updating. */
export async function trackRunProcesses(
  owned: Owned, runId: string, record?: () => Promise<unknown>, liveChildren?: () => ReadonlySet<number>,
): Promise<boolean> {
  const { ours, changed, beganAt, scannedAt } = await scan(owned, runId, record, false, liveChildren);
  const learned = remember(owned, ours, beganAt <= scannedAt ? beganAt : undefined);
  return learned || changed;
}

/**
 * Add a run's processes and groups to what it remembers. Only a group with an owned process observed during the
 * live run gets a new cutoff (`seenAt` is the time before reading the process table, omitted if the clock went
 * back during that read). Recovery does not advance cutoffs. Returns whether the record changed.
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
 * be told from the run's, which are not signalled. `record` saves new or invalidated ownership evidence, including
 * a `pendingRecord` that previously failed to save. `liveChildren` supplies PIDs verified by a live child handle.
 * Rejects if the table cannot be read or the record cannot be saved.
 */
export async function stopRun(
  owned: Owned, runId: string, root: number | undefined, graceMs: number, term?: () => void, record?: () => Promise<unknown>,
  pendingRecord: () => boolean = () => false, liveChildren?: () => ReadonlySet<number>,
): Promise<Proc[]> {
  // A record write failure blocks cleanup, but must not prevent us from stopping confirmed processes.
  let failedWrite: { error: unknown } | undefined;
  const save = async () => {
    try {
      await record?.();
      failedWrite = undefined;
    } catch (error) {
      failedWrite = { error };
    }
  };
  // Save what changed before signalling: a new group could otherwise be lost on a crash, and a discarded
  // cutoff must not become usable again on restart. Recheck the targets' identities after a write attempt.
  const recordScan = async ({ ours, changed }: ProcessScan) => {
    const learned = remember(owned, ours);
    if (!record || (!learned && !changed)) return ours;
    await save();
    if (!ours.length) return ours;
    const starts = new Map((await listProcesses()).map(proc => [proc.pid, proc.start]));
    return ours.filter(proc => starts.get(proc.pid) === proc.start);
  };
  let stopFailure: { error: unknown } | undefined;
  try {
    const tree = await recordScan(await scan(owned, runId, save, pendingRecord(), liveChildren));
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
      const scanned = await scan(owned, runId, save, false, liveChildren);
      ({ ours: left, unsure } = scanned);
      const targets = await recordScan(scanned);
      if (!left.length) break;
      for (const proc of targets) signal(proc.pid, "SIGKILL");
      await sleep(150);
    }
    return [...left, ...unsure];
  } catch (error) {
    stopFailure = { error };
    throw error;
  } finally {
    if (failedWrite || pendingRecord()) {
      await save();
      if (failedWrite) {
        const { error } = failedWrite;
        const text = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
        const reason = `the process record could not be saved: ${text(error)}`;
        if (stopFailure) {
          throw new AggregateError([stopFailure.error, error], `${text(stopFailure.error)}; ${reason}`);
        }
        throw new Error(reason, { cause: error });
      }
    }
  }
}

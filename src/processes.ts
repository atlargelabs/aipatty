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
  uid: number;
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

function ps(args: string[]) {
  // The C locale fixes the format of the start time.
  return exec("ps", args, { maxBuffer: 64 * 1024 * 1024, timeout: 5_000, env: { ...process.env, LC_ALL: "C" } });
}

/** Expected races or permission boundaries when inspecting another process through /proc. */
export function processEntryUnavailable(error: unknown): boolean {
  return !!error && ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
}

/** This process's own group, once the process table has been read: never a run's. */
let hostGroup: number | undefined;

export async function listProcesses(): Promise<Proc[]> {
  const procs: Proc[] = [];
  const observation = ps(["-A", "-o", "pid=,ppid=,pgid=,uid=,stat=,lstart="]);
  for (const line of (await observation).stdout.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    // Ignore zombies and the ps we just waited for; neither can continue the observed work.
    if (row && Number(row[1]) !== observation.child.pid && !row[5].startsWith("Z")) {
      procs.push({ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), uid: Number(row[4]), start: row[6] });
    }
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
async function markedPids(runId: string, procs: readonly Proc[], variable: string) {
  const needle = `${variable}=${runId}`;
  const marked = new Set<number>();
  const unstable = new Set<number>();
  if (process.platform === "linux") {
    // Bound descriptors and never interpret a resource/I/O failure as proof of no marker.
    for (let offset = 0; offset < procs.length; offset += 16) {
      await Promise.all(procs.slice(offset, offset + 16).map(async proc => {
        try {
          if ((await readFile(`/proc/${proc.pid}/environ`, "utf8")).split("\0").includes(needle)) marked.add(proc.pid);
        } catch (error) {
          // Gone since ps, or an environment the OS does not disclose (e.g. another user).
          if (!processEntryUnavailable(error)) {
            throw new Error(`Could not inspect process ${proc.pid}'s environment`, { cause: error });
          }
        }
      }));
    }
    return { marked, unstable };
  }
  // `ps -E` prints the arguments and then the environment. Only the environment counts: a process that merely
  // has the marker among its arguments, such as a search for it, is not the run's. The entries are not delimited,
  // so a value that itself contains the marker with this run's random ID would also match.
  // A scan that fails as a whole rejects: it must not pass for one that found nothing.
  const [plain, withEnv] = await Promise.all([
    ps(["-A", "-ww", "-o", "pid=,command="]), ps(["-A", "-E", "-ww", "-o", "pid=,command="]),
  ]);
  const args = commands(plain.stdout);
  const environments = commands(withEnv.stdout);
  for (const { pid } of procs) {
    const own = args.get(pid), full = environments.get(pid);
    if (!full || !` ${full} `.includes(` ${needle} `)) continue;
    if (own === undefined || !full.startsWith(own)) unstable.add(pid);
    else if (` ${full.slice(own.length)} `.includes(` ${needle} `)) marked.add(pid);
  }
  return { marked, unstable };
}

function ownedTree(procs: readonly Proc[], known: (proc: Proc) => boolean): Map<number, Proc> {
  const skipGroups = new Set([0, 1, procs.find(proc => proc.pid === process.pid)?.pgid ?? -1]);
  const candidates = procs.filter(proc => proc.pid !== process.pid && proc.pid > 1);
  const ours = new Map<number, Proc>();
  for (const proc of candidates) if (known(proc)) ours.set(proc.pid, proc);
  for (let grew = true; grew;) {
    grew = false;
    const groups = new Set([...ours.values()].map(proc => proc.pgid).filter(pgid => !skipGroups.has(pgid)));
    for (const proc of candidates) {
      if (!ours.has(proc.pid) && (ours.has(proc.ppid) || groups.has(proc.pgid))) {
        ours.set(proc.pid, proc);
        grew = true;
      }
    }
  }
  return ours;
}

/**
 * The live processes that belong to a run: those it remembers (same ID and start time), those carrying its marker,
 * and everything reached from them as a child or as a member of the same group. A process that left both its
 * parent and its group, and hides its environment, is not found unless it was remembered.
 *
 * `unsure` are members of remembered, leaderless groups that were not identified by this evidence. They may
 * be the run's or belong to a new group that reused the ID. They are not signalled and keep cleanup pending.
 *
 * For ordinary runs, forgets groups with no visible members. Stage cleanup retains them for an independent check.
 * The result is from a process table read last, after the slower environment scan: act on it at once.
 */
async function scan(
  owned: Owned, runId: string, variable: string, record?: () => Promise<unknown>, worker = false,
): Promise<{ ours: Proc[]; unsure: Proc[]; workerBusy: boolean }> {
  const isStage = variable !== RUN_MARKER;
  const sampled = new Map<number, string>(), marked = new Map<number, string>();
  const eligible = (proc: Proc) => proc.pid !== process.pid && (!isStage || proc.uid === process.geteuid?.());
  // The live stage worker is the leader of its own group. Only its idle check uses this evidence.
  const workerChild = (proc: Proc) => worker && proc.pid !== process.pid && (proc.pgid === process.pid || proc.ppid === process.pid);
  const tree = (procs: Proc[]) => ownedTree(procs, proc => workerChild(proc)
    || owned.procs.get(proc.pid) === proc.start || marked.get(proc.pid) === proc.start);
  const trackStage = async (found: Map<number, Proc>) => {
    if (!isStage || !record) return false;
    const before = owned.groups.size;
    // Retain verified identities in memory so an unmarked child remains known if it calls setsid().
    // The stage recorder writes only groups, which never seed individual process ownership.
    remember(owned, [...found.values()]);
    if (owned.groups.size === before) return false;
    await record();
    return true;
  };
  let workerBusy = false;
  const snapshot = async () => {
    const procs = await listProcesses();
    if (worker && procs.some(workerChild)) workerBusy = true;
    return procs;
  };
  let previous = await snapshot(), sample = previous.filter(eligible);
  let procs: Proc[];
  let confirmedQuiet = false;
  for (let attempt = 0;; attempt++) {
    // Save any group already established by ancestry or a known identity before fallible marker reads.
    if (isStage && record) await trackStage(tree(previous));
    const observation = await markedPids(runId, sample, variable);
    for (const p of sample) {
      if (!observation.unstable.has(p.pid)) sampled.set(p.pid, p.start);
      if (observation.marked.has(p.pid)) marked.set(p.pid, p.start);
    }
    // A process, marked or reached by ancestry, can vanish before the final table and leave an
    // unmarked successor. Remember evidence from this table too, but never signal from this snapshot.
    const previouslyOwned = isStage && record ? tree(previous) : undefined;
    if (previouslyOwned) await trackStage(previouslyOwned);
    procs = await snapshot();
    previous = procs;
    // A stage parent can detach a successor and exit during marker inspection. Inspect new identities
    // before declaring it idle. Unrelated system-user churn need not settle; staging doesn't change UID.
    if (!isStage) break;
    const newGroups = record && await trackStage(tree(procs));
    sample = procs.filter(p => eligible(p) && sampled.get(p.pid) !== p.start);
    if (!sample.length) {
      const live = new Map(procs.map(p => [p.pid, p.start]));
      const disappeared = [...marked].filter(([pid, start]) => live.get(pid) !== start);
      const lostChild = previouslyOwned && [...previouslyOwned.values()].some(p => live.get(p.pid) !== p.start);
      if (!newGroups && !disappeared.length && !lostChild && (confirmedQuiet || marked.size)) break;
      // ps is not atomic: a parent can exit after enumeration but before its row is read, and its
      // new child may be missing from that same snapshot. Confirm apparent quiet with a fresh scan;
      // also refresh the table after persisting any group evidence found in the last read.
      for (const [pid] of disappeared) marked.delete(pid);
      confirmedQuiet = true;
      previous = await snapshot();
      sample = previous.filter(eligible);
    }
    if (attempt === 15) throw new Error("Process table kept changing during staging cleanup; cannot establish quiescence");
  }
  const byPid = new Map(procs.map(proc => [proc.pid, proc]));
  if (!isStage) {
    for (const pgid of owned.groups) {
      if (!procs.some(proc => proc.pgid === pgid)) owned.groups.delete(pgid);
    }
  }
  // Never this process, its group, or the system's.
  const skipGroups = new Set([0, 1, byPid.get(process.pid)?.pgid ?? -1]);
  // A remembered, leaderless group can flag ambiguity, but cannot seed ownership.
  const leaderless = (proc: Proc) => owned.groups.has(proc.pgid) && !skipGroups.has(proc.pgid) && !byPid.has(proc.pgid);
  const ours = tree(procs);
  const unsure = procs.filter(proc => proc.pid !== process.pid && proc.pid > 1 && !ours.has(proc.pid) && leaderless(proc));
  return { ours: [...ours.values()], unsure, workerBusy };
}

/** The live processes that belong to a run; see `scan`. Rejects when the process table cannot be read. */
export async function runProcesses(owned: Owned, runId: string, variable = RUN_MARKER, record?: () => Promise<unknown>): Promise<Proc[]> {
  return (await scan(owned, runId, variable, record)).ours;
}

function rememberGroups(owned: Owned, procs: Iterable<Proc>): boolean {
  const before = owned.groups.size;
  for (const proc of procs) {
    // Remember the group even if we never saw its leader. The host's own group is not the run's.
    if (proc.pgid > 1 && proc.pgid !== hostGroup) owned.groups.add(proc.pgid);
  }
  return owned.groups.size !== before;
}

/** Remember a run's processes and their groups. Returns whether a process or group was new. */
export function remember(owned: Owned, procs: readonly Proc[]): boolean {
  const before = owned.procs.size;
  for (const proc of procs) owned.procs.set(proc.pid, proc.start);
  return rememberGroups(owned, procs) || owned.procs.size !== before;
}

async function confirmStageGroupsGone(owned: Owned, record?: () => Promise<unknown>, workerGroup?: number): Promise<void> {
  // A non-atomic ps read can miss both an unmarked member and its successor. Only the kernel can
  // confirm the group is gone. A live, inaccessible, or reused group is not authority to signal it.
  const before = owned.groups.size;
  let pending: Error | undefined;
  for (const pgid of owned.groups) {
    if (pgid === workerGroup) continue;
    const message = `Cannot prove staging process group ${pgid} is gone; leave the private stage in place and investigate`;
    try {
      process.kill(-pgid, 0);
      pending ??= new Error(message);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") owned.groups.delete(pgid);
      else pending ??= new Error(message, { cause: error });
    }
  }
  if (owned.groups.size !== before) await record?.();
  if (pending) throw pending;
}

/** The stage worker is still its group leader; require other known groups to be independently absent. */
export async function assertStageWorkerIdle(owned: Owned, variable: string, record: () => Promise<unknown>): Promise<void> {
  const { ours, unsure, workerBusy } = await scan(owned, "1", variable, record, true);
  if (ours.length || unsure.length || workerBusy) throw new Error("Staging still has subprocesses");
  await confirmStageGroupsGone(owned, record, process.pid);
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
 * Rejects when the table cannot be read or when stage cleanup cannot confirm a remembered group is gone.
 */
export async function stopRun(
  owned: Owned, runId: string, root: number | undefined, graceMs: number, term?: () => void, record?: () => Promise<unknown>,
  variable = RUN_MARKER,
): Promise<Proc[]> {
  // Remember the tree before it comes apart, and have the caller save it: a group found only now would otherwise
  // be forgotten if this process dies with a member of it still alive.
  const tree = await runProcesses(owned, runId, variable, record);
  if (remember(owned, tree)) await record?.();
  const rootStart = root === undefined ? undefined : owned.procs.get(root);
  if (root !== undefined && rootStart !== undefined && tree.some(proc => proc.pid === root && proc.start === rootStart)) {
    // Through the live child handle when there is one, which cannot reach a process that reused the ID.
    if (term) term();
    else signal(root, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await sleep(100);
      const procs = await listProcesses();
      if (variable !== RUN_MARKER && record
        && remember(owned, [...ownedTree(procs, proc => owned.procs.get(proc.pid) === proc.start).values()])) await record();
      if (!procs.some(proc => proc.pid === root && proc.start === rootStart)) break;
    }
  }
  let left: Proc[] = [];
  let unsure: Proc[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    ({ ours: left, unsure } = await scan(owned, runId, variable, record));
    if (!left.length) break;
    if (remember(owned, left)) await record?.();
    for (const proc of left) signal(proc.pid, "SIGKILL");
    await sleep(150);
  }
  if (variable !== RUN_MARKER && !left.length && !unsure.length) await confirmStageGroupsGone(owned, record);
  return [...left, ...unsure];
}

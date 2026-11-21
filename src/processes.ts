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

export async function listProcesses(): Promise<Proc[]> {
  const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], { maxBuffer: 16 * 1024 * 1024 });
  const procs: Proc[] = [];
  for (const line of stdout.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (row) procs.push({ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), start: row[4] });
  }
  return procs;
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
  const { stdout } = await exec("ps", ["-A", "-E", "-ww", "-o", "pid=,command="], { maxBuffer: 64 * 1024 * 1024 })
    .catch(() => ({ stdout: "" }));
  for (const line of stdout.split("\n")) {
    const row = /^\s*(\d+)\s(.*)$/.exec(line);
    if (row && ` ${row[2]} `.includes(` ${needle} `)) marked.add(Number(row[1]));
  }
  return marked;
}

/** What a run remembers of the processes it has seen: process ID to start time. */
export type Seen = Map<number, string>;

/**
 * The live processes that belong to a run: those it has `seen` (same ID and start time), those carrying its marker,
 * and everything reached from them as a child or as a member of the same process group. Pi and the delegates
 * extension start their children as group leaders, so an orphan whose parent died is still found by its group.
 * A process that left both its parent and its group, and hides its environment, is not found.
 */
export async function runProcesses(seen: Seen, runId: string): Promise<Proc[]> {
  const procs = await listProcesses();
  const marked = await markedPids(runId, procs);
  const own = procs.find(proc => proc.pid === process.pid);
  // Never this process, its group, or the system's.
  const skipGroups = new Set([0, 1, own?.pgid ?? -1]);
  const ours = new Map<number, Proc>();
  for (const proc of procs) {
    if (proc.pid === process.pid || proc.pid <= 1) continue;
    if (seen.get(proc.pid) === proc.start || marked.has(proc.pid)) ours.set(proc.pid, proc);
  }
  for (let grew = true; grew;) {
    grew = false;
    const groups = new Set([...ours.values()].map(proc => proc.pgid).filter(pgid => !skipGroups.has(pgid)));
    for (const proc of procs) {
      if (ours.has(proc.pid) || proc.pid === process.pid || proc.pid <= 1) continue;
      if (ours.has(proc.ppid) || groups.has(proc.pgid)) {
        ours.set(proc.pid, proc);
        grew = true;
      }
    }
  }
  return [...ours.values()];
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone, or not ours to signal.
  }
}

/**
 * Stop a run's processes. `root` gets SIGTERM first and `graceMs` to stop its own children, as Pi and the delegates
 * extension do; whatever is left is killed. Returns the processes that survived the kills.
 */
export async function stopRun(seen: Seen, runId: string, root: number | undefined, graceMs: number): Promise<Proc[]> {
  const rootStart = root === undefined ? undefined : seen.get(root);
  const rootAlive = async () => root !== undefined
    && (await listProcesses()).some(proc => proc.pid === root && proc.start === rootStart);
  if (await rootAlive()) {
    // Remember the tree before it comes apart.
    for (const proc of await runProcesses(seen, runId)) seen.set(proc.pid, proc.start);
    signal(root!, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && await rootAlive()) await sleep(100);
  }
  let left: Proc[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    left = await runProcesses(seen, runId);
    if (!left.length) break;
    for (const proc of left) signal(proc.pid, "SIGKILL");
    await sleep(150);
  }
  return left;
}

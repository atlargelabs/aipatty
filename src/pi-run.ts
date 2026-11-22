import type { Usage } from "@earendil-works/pi-ai";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { instructions, taskPrompt } from "./pi-prompt.ts";
import { addUsage, githubLink, readReport, RunTrace, usageKey, type JobUsage, type Review } from "./pi-trace.ts";
import { identifiedTree, invalidateFutureCutoffs, listProcesses, newOwned, remember, RUN_MARKER, stopRun, trackRunProcesses, type Owned, type Proc } from "./processes.ts";

const exec = promisify(execFile);

/**
 * How a run ended. `completed` means everything the host can check holds: Pi finished cleanly, and, when a PR was
 * asked for, GitHub has it open against `main`, linked to its issue, and its head commit was reviewed clean.
 */
export type RunStatus = "completed" | "failed" | "aborted" | "timed_out" | "interrupted";

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  summary: string;
  /** Confirmed with `gh`, unless `confirmed` is false: then it is only a link the run printed. */
  pr?: { url: string; number: number; headSha?: string; state?: string; confirmed: boolean };
  issue?: { url: string; confirmed: boolean };
  /**
   * `clean` only when the last finished review was a `/review pr` of this PR at its head commit, gave the verdict
   * "correct", and had no P0 or P1 finding. `none` when no PR was asked for.
   */
  review: {
    status: "clean" | "missing" | "findings" | "stale" | "unverified" | "none";
    verdict?: Review["verdict"];
    sha?: string;
    important: number;
    lesser: number;
  };
  usage: Usage;
  /** False when the run or a delegate was cut off, so that some spend may not have been reported. */
  usageComplete: boolean;
  /** What Pi says is left. */
  remaining: string[];
  /** What the host found wrong, whatever Pi says. */
  problems: string[];
  logDir: string;
}

export interface RunRequest {
  conversationId: number;
  /** The harness task of the tool call: what a call is known by across an abort or a restart. */
  taskId: number;
  task: string;
  /** Whether the run must end with a PR. */
  pr: boolean;
  base: string;
  model: string;
  thinking: string;
  /** From the start of the run, cloning included. */
  timeoutMs: number;
}

/** The active run as saved in the data directory, so a later process can stop and clean up what this one started. */
interface SavedRun {
  runId: string;
  conversationId: number;
  taskId: number;
  pr: boolean;
  startedAt: string;
  workspace: string;
  logDir: string;
  /** The Pi process, once it runs. */
  pid?: number;
  procs: [number, string][];
  /** Group ID and when ownership was last observed, or null when unknown. */
  groups: [number, number | null][];
  /** Legacy process identities: they can block cleanup, but cannot establish ownership. */
  unverifiedProcs?: [number, string][];
  /** The last launcher whose gate may have opened. It guards recovery, but does not authorize signals. */
  activeChild?: [pid: number, start: string];
  /** A launched child's tree may not have been verified; require manual inspection. */
  cleanupUncertain?: true;
}

type LegacySavedRun = Omit<SavedRun, "groups" | "unverifiedProcs"> & { groups: number[]; asOf: number };

/** A detached child's group or process tree could not be verified or saved for recovery. */
class GroupRecordError extends Error {}

/** A call's outcome as kept by task, and whether the spend of its cut-off delegate jobs has been added to it. */
interface Kept {
  outcome: RunOutcome;
  reconciled: boolean;
}

interface ActiveRun {
  saved: SavedRun;
  owned: Owned;
  /** Why the run is being stopped early, once it is. */
  stop?: "aborted" | "timed_out" | "shutdown";
  /** Set once the run's processes are done and its outcome is being settled: from then on it ends as it ended. */
  finalizing: boolean;
  kill(): void;
  done: Promise<RunOutcome | undefined>;
}

/** A delegate job's manifest, as far as the host reads it. */
interface JobManifest {
  parentId?: string;
  ownerSession?: string;
  startedAt?: string;
  finishedAt?: string;
  usage?: JobUsage;
  workspace?: { source?: string };
}

const maxSummary = 6_000;
const maxItems = 20;
const maxItem = 600;
const defaultPollMs = 2_000;
const outcomesKept = 50;
const graceMs = 5_000;
/** The longest event kept whole. Longer ones are the CLI's copies of a whole conversation, which the host does not read. */
const maxLine = 16 * 1024 * 1024;

/** How long a child's output may stay open after the child has exited, held by a process it left behind. */
const drainMs = 5_000;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * A child's exit code, once its output has ended. A process the child left behind can hold the pipes open for
 * ever: after `drainMs` they are closed here instead.
 */
function exitOf(child: ChildProcess, onError: (error: Error) => void, onDrainTimeout: () => void): Promise<number | null> {
  return new Promise(done => {
    child.once("error", error => {
      onError(error);
      done(null);
    });
    child.once("exit", code => {
      const timer = setTimeout(() => {
        onDrainTimeout();
        child.stdout?.destroy();
        child.stderr?.destroy();
        done(code);
      }, drainMs);
      child.once("close", () => {
        clearTimeout(timer);
        done(code);
      });
    });
  });
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

function tail(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    try {
      await rm(temp, { force: true });
    } catch (removeError) {
      throw new AggregateError([error, removeError], `${message(error)}; could not remove ${temp}: ${message(removeError)}`);
    }
    throw error;
  }
}

/** A JSON file's value, or `undefined` when there is no such file. A file that exists and cannot be read throws. */
async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return JSON.parse(text) as T;
}

/**
 * Feed complete lines to `onLine`. Pi's stream is split on LF only: other separators are valid inside its JSON. A
 * line longer than `maxLine` is passed cut short, with `whole` false, so memory stays bounded.
 */
function lineSplitter(onLine: (line: string, whole: boolean) => void) {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  let cut = false;
  const feed = (text: string) => {
    for (let from = 0; from < text.length;) {
      const end = text.indexOf("\n", from);
      const part = text.slice(from, end < 0 ? text.length : end);
      if (rest.length + part.length > maxLine) {
        rest += part.slice(0, maxLine - rest.length);
        cut = true;
      } else {
        rest += part;
      }
      if (end < 0) break;
      onLine(rest, !cut);
      rest = "";
      cut = false;
      from = end + 1;
    }
  };
  return {
    write: (chunk: Buffer) => feed(decoder.write(chunk)),
    end: () => {
      feed(decoder.end());
      if (rest) onLine(rest, !cut);
      rest = "";
      cut = false;
    },
  };
}

/** Events that only repeat what others carry: streaming deltas, and the copies of whole turns and conversations. */
const repeats = ["message_update", "tool_execution_update", "turn_end", "agent_end"].map(type => `{"type":"${type}"`);
function repeated(line: string): boolean {
  return repeats.some(prefix => line.startsWith(prefix));
}

/** How far GitHub's clock and this one's may disagree about which came first, a review's start or a change of base. */
const clockSlackMs = 60_000;

/**
 * The review a run's result stands on: the last finished one. Reviews of one delegate call ran side by side, in no
 * known order, so the least favourable of that call's decides. `baseChangedAt` is when the PR's base branch was
 * last changed, 0 if never.
 */
function reviewOf(trace: RunTrace, pr: RunOutcome["pr"], requested: boolean, baseChangedAt = 0): RunOutcome["review"] {
  if (!requested) return { status: "none", important: 0, lesser: 0 };
  const finished = trace.reviews.filter(review => review.finished);
  const last = finished.at(-1);
  if (!last) return { status: "missing", important: 0, lesser: 0 };
  const statusOf = (review: Review): RunOutcome["review"]["status"] =>
    review.verdict !== "correct" || review.important > 0 ? "findings"
    : !pr?.confirmed ? "unverified"
    // The same head commit under another request, such as `/review commit`, is not a review of the PR's whole diff,
    // and the same number in a clone of another repository is another PR.
    : !review.ownRepo || review.pr !== pr.number || review.sha !== pr.headSha ? "stale"
    // A PR retargeted once its review had begun may have another diff under the same head.
    : baseChangedAt > 0 && baseChangedAt >= review.at - clockSlackMs ? "stale" : "clean";
  const worst = ["findings", "stale", "unverified", "clean"];
  const decisive = finished.filter(review => review.call === last.call)
    .reduce((chosen, review) => worst.indexOf(statusOf(review)) < worst.indexOf(statusOf(chosen)) ? review : chosen, last);
  const { verdict, sha, important, lesser } = decisive;
  return { status: statusOf(decisive), verdict, sha, important, lesser };
}

const reviewText: Record<RunOutcome["review"]["status"], string> = {
  clean: "reviewed",
  missing: "NOT REVIEWED: no crmanager review finished",
  findings: "NOT REVIEWED CLEAN: the last review has important findings or states no \"correct\" verdict",
  stale: "NOT REVIEWED: the last review was not a `/review pr` of this PR, in this repository, at its head commit and current base",
  unverified: "NOT REVIEWED: the PR head could not be confirmed, so the review cannot be matched to it",
  none: "not requested",
};

function money(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

/** The outcome as the model reads it. */
export function outcomeText(outcome: RunOutcome): string {
  const lines = [`Pi run ${outcome.runId}: ${outcome.status}`];
  if (outcome.summary) lines.push(`Summary: ${outcome.summary}`);
  if (outcome.pr) {
    const { url, headSha, state, confirmed } = outcome.pr;
    lines.push(confirmed ? `PR: ${url} (${state?.toLowerCase()}, head ${headSha}). CI on that commit is the authoritative check; this tool did not wait for it.`
      : `PR: ${url} (NOT CONFIRMED with GitHub)`);
  } else if (outcome.review.status !== "none") {
    lines.push("PR: none");
  }
  if (outcome.issue) lines.push(`Issue: ${outcome.issue.url}${outcome.issue.confirmed ? "" : " (NOT CONFIRMED with GitHub)"}`);
  const { status, verdict, sha, important, lesser } = outcome.review;
  if (status !== "none") {
    const detail = status === "missing" ? "" : ` (last review: verdict ${verdict}, commit ${sha ?? "unknown"}, ${important} important and ${lesser} lesser findings)`;
    lines.push(`Review: ${reviewText[status]}${detail}`);
  }
  lines.push(`Cost: ${money(outcome.usage.cost.total)}${outcome.usageComplete ? "" : " (incomplete: some spend may not have been reported)"}, charged to this branch`);
  if (outcome.problems.length) lines.push("Problems found by the host:", ...outcome.problems.map(item => `- ${item}`));
  if (outcome.remaining.length) lines.push("Remaining, as Pi reported:", ...outcome.remaining.map(item => `- ${item}`));
  lines.push(`Logs: ${outcome.logDir}`);
  return lines.join("\n");
}

export interface PiRuns {
  /** The branch and ID of the run in progress. */
  active(): { runId: string; conversationId: number } | undefined;
  /**
   * Run Pi once. Rejects at once when another run is active, or when an earlier run could not be cleaned up;
   * otherwise resolves when the run is over and cleaned up.
   */
  run(request: RunRequest, signal?: AbortSignal): Promise<RunOutcome>;
  /**
   * The outcome of a call whose result the harness did not get from the tool: aborted, or cut off by a restart.
   * Stops the call's run if it is still working, and waits for its cleanup.
   */
  settled(taskId: number): Promise<RunOutcome | undefined>;
  /** Stop the active run's processes and leave its cleanup and its result to the next start. */
  close(): Promise<void>;
}

/** Open the run slot: first stop and clean up a run that a previous process left behind. */
export async function openPiRuns(config: Config): Promise<PiRuns> {
  const { pi } = config;
  const pollMs = pi.pollMs ?? defaultPollMs;
  const stateFile = join(config.dataDir, "pi-run.json");
  const outcomesFile = join(config.dataDir, "pi-outcomes.json");
  const logRoot = join(config.dataDir, "logs", "runs");
  const jobsDir = join(pi.agentDir, "delegates", "jobs");
  await mkdir(logRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.runsDir, { recursive: true, mode: 0o700 });

  const inside = (parent: string, child: string) => resolve(child).startsWith(resolve(parent) + sep);
  /** Whether `path` is a real directory, not a link to one, directly inside `parent`. */
  const ownDir = async (parent: string, path: string) => {
    const stat = await lstat(path).catch(error => {
      // Only a missing path is "not there": anything else leaves the question open.
      if (isMissing(error)) return undefined;
      throw error;
    });
    return !!stat?.isDirectory() && !stat.isSymbolicLink()
      && await realpath(path) === join(await realpath(parent), path.slice(resolve(parent).length + 1));
  };

  /** Why a new run is refused until aipatty restarts: an earlier run's processes or files are still there. */
  let stuck: string | undefined;

  // The newest outcomes by the harness task of their call. An outcome is saved here before its run's record is
  // removed, so that the harness can still be given it when the process dies, or the call is aborted, before the
  // result is committed. Each run's log directory has its own copy, written first.
  const kept = new Map<string, Kept>();
  const isKept = (value: unknown): value is Kept => {
    const entry = value as Kept | null;
    return typeof entry === "object" && entry !== null && typeof entry.reconciled === "boolean"
      && typeof entry.outcome === "object" && entry.outcome !== null && typeof entry.outcome.runId === "string";
  };
  /** The copy in a run's log directory, if it is that run's and that call's. */
  const logged = async (runId: string, taskId?: number): Promise<{ taskId: number; entry: Kept } | undefined> => {
    const copy = await readJson<Kept & { taskId?: unknown }>(join(logRoot, runId, "result.json")).catch(() => undefined);
    if (!isKept(copy) || typeof copy.taskId !== "number" || copy.outcome.runId !== runId) return undefined;
    if (taskId !== undefined && copy.taskId !== taskId) return undefined;
    return { taskId: copy.taskId, entry: { outcome: copy.outcome, reconciled: copy.reconciled } };
  };
  const writeIndex = () => writeJson(outcomesFile, Object.fromEntries(kept));
  try {
    const saved = await readJson<Record<string, unknown>>(outcomesFile);
    if (saved !== undefined && (saved === null || typeof saved !== "object" || Array.isArray(saved))) throw new Error("expected a JSON object");
    for (const [key, entry] of Object.entries(saved ?? {})) if (isKept(entry)) kept.set(key, entry);
  } catch (error) {
    // Rebuild the index from the newest run logs and write it over the unreadable one, which stays in place until
    // then: a rebuild that is cut off is done again.
    const aside = `${outcomesFile}.unreadable-${Date.now()}`;
    await copyFile(outcomesFile, aside).catch(() => {});
    for (const runId of (await readdir(logRoot)).sort().slice(-outcomesKept)) {
      const copy = await logged(runId);
      if (copy) kept.set(String(copy.taskId), copy.entry);
    }
    await writeIndex();
    console.error(`Pi runs: ${outcomesFile} could not be read (${message(error)}); copied to ${aside} and rebuilt from the run logs.`);
  }
  /** Keep a call's outcome, with whether its cut-off delegates' spend is in it: one write decides both. */
  const remembered = async (saved: SavedRun, outcome: RunOutcome, reconciled: boolean) => {
    kept.set(String(saved.taskId), { outcome, reconciled });
    for (const key of [...kept.keys()].slice(0, Math.max(0, kept.size - outcomesKept))) kept.delete(key);
    // The run's own copy first, and the index only after it: recovery prefers the copy, as the newer of the two.
    await writeJson(join(saved.logDir, "result.json"), { outcome, reconciled, taskId: saved.taskId });
    await writeIndex();
  };

  /**
   * The delegate jobs a run started. A job belongs to the run when it carries the run's session ID or was cloned
   * from the run's workspace or from another of its jobs. Throws when the jobs cannot be listed.
   */
  async function findJobs(saved: SavedRun, trace: RunTrace, outcome: RunOutcome): Promise<{ jobs: Map<string, JobManifest>; ours: Set<string> }> {
    const jobs = new Map<string, JobManifest>();
    const ids = await readdir(jobsDir).catch(error => {
      if (isMissing(error)) return [] as string[];
      throw error;
    });
    for (const id of ids) {
      const dir = join(jobsDir, id);
      // A job directory that is a link could lead anywhere.
      if (!await ownDir(jobsDir, dir)) continue;
      try {
        const job = await readJson<JobManifest>(join(dir, "job.json"));
        if (job && typeof job === "object") jobs.set(id, job);
        // A job the run reported is the run's, with or without a manifest: its logs are kept and its clone goes.
        else if (trace.countedJobs.has(id)) jobs.set(id, {});
      } catch (error) {
        if (trace.countedJobs.has(id)) {
          jobs.set(id, {});
          continue;
        }
        // An old job's damage is not this run's problem. One touched since the run began may be this run's: say
        // so, and leave it alone.
        const touched = (await lstat(join(dir, "job.json")).catch(() => undefined))?.mtimeMs ?? Infinity;
        if (touched < Date.parse(saved.startedAt)) continue;
        outcome.problems.push(`Delegate job ${id} has an unreadable manifest (${clip(message(error), 200)}); its clone was left in ${dir}.`);
        outcome.usageComplete = false;
      }
    }
    const ours = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, job] of jobs) {
        if (ours.has(id)) continue;
        const source = job.workspace?.source;
        const fromRun = typeof source === "string" && (resolve(source) === resolve(saved.workspace) || inside(saved.workspace, source)
          || [...ours].some(parent => inside(join(jobsDir, parent), source)));
        if ((trace.sessionId !== undefined && job.ownerSession === trace.sessionId) || fromRun || trace.countedJobs.has(id)) {
          ours.add(id);
          grew = true;
        }
      }
    }
    return { jobs, ours };
  }

  /**
   * Add the spend the event stream did not carry: that of jobs cut off before their call reported, from their
   * manifests. A job's usage includes the jobs it started once it has finished, as a reported one's does.
   */
  function reconcile(trace: RunTrace, outcome: RunOutcome, jobs: Map<string, JobManifest>, ours: Set<string>): void {
    const continuing = trace.continuing;
    // Whether a result covers the job's manifest. A job being continued is covered only until its manifest is
    // replaced by the new attempt's, which starts from zero.
    const reported = (id: string) => trace.countedJobs.has(id)
      && (!continuing.has(id) || usageKey(jobs.get(id)?.usage) === trace.countedJobs.get(id));
    for (const id of ours) {
      if (reported(id)) continue;
      const job = jobs.get(id)!;
      let covered = false;
      const walked = new Set([id]);
      for (let parentId = job.parentId; parentId !== undefined && !walked.has(parentId); parentId = jobs.get(parentId)?.parentId) {
        walked.add(parentId);
        const parent = jobs.get(parentId);
        if (!ours.has(parentId) || !parent) continue;
        // Counted with a parent that reported or finished, or with an earlier attempt of a parent since continued.
        const earlier = trace.countedJobs.has(parentId) && typeof job.startedAt === "string" && typeof parent.startedAt === "string"
          && job.startedAt < parent.startedAt;
        if (reported(parentId) || parent.finishedAt !== undefined || earlier) covered = true;
      }
      if (!covered) addUsage(outcome.usage, job.usage);
    }
  }

  /** Keep the jobs' logs, then delete their clones, which the extension leaves in the agent directory. */
  async function discardJobs(saved: SavedRun, ours: Set<string>): Promise<void> {
    for (const id of ours) {
      const dir = join(jobsDir, id);
      const clone = join(dir, "workspace");
      // The logs are kept before the clone goes. A copy that fails stops the cleanup, with the job left as it is;
      // a manifest that cannot be read is left out, so that the logs beside it are still kept.
      const keep = (manifest: boolean) => cp(dir, join(saved.logDir, "delegates", id), {
        recursive: true, force: true,
        filter: source => source !== clone && !inside(clone, source) && (manifest || source !== join(dir, "job.json")),
      });
      try {
        await keep(true).catch(() => keep(false));
      } catch (error) {
        throw new Error(`the logs of delegate job ${id} could not be kept from ${dir}: ${message(error)}`);
      }
      if (await ownDir(dir, clone)) await rm(clone, { recursive: true, force: true });
      await rm(join(dir, "lease.json"), { force: true });
      await writeFile(join(dir, "discarded"), new Date().toISOString(), { mode: 0o600 }).catch(() => {});
    }
  }

  /** Save a verified, empty stop before reporting or deleting anything that recovery might need again. */
  const disarmLaunchGuard = async (saved: SavedRun, record: () => Promise<void>) => {
    const activeChild = saved.activeChild;
    if (activeChild && !saved.cleanupUncertain) {
      delete saved.activeChild;
      try {
        await record();
      } catch (error) {
        saved.activeChild = activeChild;
        throw error;
      }
    }
  };

  /**
   * Stop what is left of a run, add its cut-off delegates' spend, keep its logs, and delete its workspace and its
   * delegates' clones. `clean` is false when something of the run is still there, or could not be looked at: the
   * caller then keeps the run's record and admits no new run. `reconciled` says whether the outcome now has that
   * spend; when this call added it, the outcome was saved with it before anything was deleted.
   */
  async function cleanUp(
    saved: SavedRun, trace: RunTrace, outcome: RunOutcome, reconciled: boolean, stop: () => Promise<Proc[]>, record: () => Promise<void>,
  ): Promise<{ clean: boolean; reconciled: boolean }> {
    try {
      const left = await stop();
      if (left.length) {
        // Its jobs may still be spending: their spend is added by the cleanup that finds them stopped.
        outcome.problems.push(`${left.length} process(es) could not be stopped, or could not be told from the run's (${left.map(proc => proc.pid).join(", ")}); its workspace was left in ${saved.workspace}.`);
        outcome.usageComplete = false;
        return { clean: false, reconciled };
      }
      if (saved.cleanupUncertain) {
        outcome.problems.push("A child's process tree could not be verified; descendants may remain. Inspect the run before removing its record or workspace.");
        outcome.usageComplete = false;
        return { clean: false, reconciled };
      }
      await disarmLaunchGuard(saved, record);
      const { jobs, ours } = await findJobs(saved, trace, outcome);
      if (!reconciled) {
        reconcile(trace, outcome, jobs, ours);
        reconciled = true;
        // Saved before anything is deleted: from here the outcome, not the manifests, is where that spend lives.
        await remembered(saved, outcome, true);
      }
      await discardJobs(saved, ours);
      // Only the directory this host made for the run, never a path a damaged record names.
      if (saved.workspace !== join(config.runsDir, saved.runId)) throw new Error(`${saved.workspace} is not this run's workspace`);
      if (await ownDir(config.runsDir, saved.workspace)) {
        await rm(saved.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } else if (await lstat(saved.workspace).catch(error => { if (!isMissing(error)) throw error; })) {
        throw new Error(`${saved.workspace} is not a directory of ${config.runsDir}`);
      }
      return { clean: true, reconciled };
    } catch (error) {
      outcome.problems.push(`The run could not be cleaned up: ${clip(message(error), 400)}`);
      outcome.usageComplete = false;
      return { clean: false, reconciled };
    }
  }

  const gh = async (args: string[]): Promise<unknown> => {
    const { stdout } = await exec(pi.gh, args, { cwd: config.dataDir, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  };

  /**
   * Check the PR and issue with GitHub; a URL in the model's output is not proof of either. Anything short of an
   * open PR against `main` that closes a confirmed issue is added to the outcome's problems. Returns when the PR's
   * base branch was last changed, 0 if never.
   */
  async function confirm(trace: RunTrace, outcome: RunOutcome, reported: { pr?: string; issue?: string }): Promise<number> {
    let baseChangedAt = 0;
    const problem = (text: string) => { outcome.problems.push(text); };
    const prUrl = trace.prLinks.at(-1) ?? reported.pr;
    const prLink = prUrl ? githubLink(prUrl, pi.repo, "pull") : undefined;
    const issueUrl = reported.issue ?? trace.issueLinks.at(-1);
    const issueLink = issueUrl ? githubLink(issueUrl, pi.repo, "issues") : undefined;
    type PrView = {
      state?: string; headRefOid?: string; baseRefName?: string;
      closingIssuesReferences?: { number?: number; repository?: { name?: string; owner?: { login?: string } } }[];
    };
    /** Whether GitHub lists the issue among those the PR closes: its own reading of the body, not ours. */
    const closes = (pr: PrView, issue: number) => (pr.closingIssuesReferences ?? []).some(reference => reference.number === issue
      && `${reference.repository?.owner?.login}/${reference.repository?.name}`.toLowerCase() === pi.repo.toLowerCase());
    if (!prUrl) {
      problem("No PR was found, though one was requested.");
    } else if (!prLink) {
      problem(`The reported PR link is not a PR of ${pi.repo}: ${clip(prUrl, 200)}`);
    } else {
      outcome.pr = { url: prLink.url, number: prLink.number, confirmed: false };
      try {
        // Everything is judged from one answer. GitHub works the issue links out shortly after the PR is written,
        // so an answer without the link is asked for again, and the last one stands as a whole.
        let pr: PrView = {};
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await sleep(pi.retryMs ?? 3_000);
          pr = await gh(["pr", "view", String(prLink.number), "--repo", pi.repo, "--json", "number,url,state,headRefOid,baseRefName,closingIssuesReferences"]) as PrView;
          if (!issueLink || closes(pr, issueLink.number)) break;
        }
        if (typeof pr.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(pr.headRefOid)) throw new Error("no head commit in gh's answer");
        outcome.pr = { ...outcome.pr, headSha: pr.headRefOid, state: pr.state ?? "UNKNOWN", confirmed: true };
        if (pr.state !== "OPEN") problem(`The PR is ${pr.state?.toLowerCase()}, not open.`);
        if (pr.baseRefName !== "main") problem(`The PR targets ${pr.baseRefName}, not main.`);
        if (issueLink && !closes(pr, issueLink.number)) {
          problem(`GitHub does not list issue #${issueLink.number} as one the PR closes: its body needs a plain \`Closes #${issueLink.number}\`.`);
        }
        // A review covers the diff against the base the PR had then.
        try {
          for (let page = 1; ; page++) {
            // A history too long to read through is one that cannot be vouched for.
            if (page > 30) throw new Error("the PR has too many events to read");
            const events = await gh(["api", `repos/${pi.repo}/issues/${prLink.number}/events?per_page=100&page=${page}`]) as { event?: string; created_at?: string }[];
            if (!Array.isArray(events)) throw new Error("gh's answer is not a list of events");
            for (const event of events) {
              if (event.event !== "base_ref_changed") continue;
              const at = Date.parse(event.created_at ?? "");
              baseChangedAt = Math.max(baseChangedAt, Number.isFinite(at) ? at : Infinity);
            }
            if (events.length < 100) break;
          }
        } catch (error) {
          baseChangedAt = Infinity;
          problem(`Whether the PR's base was changed could not be checked with gh: ${clip(message(error), 300)}`);
        }
      } catch (error) {
        problem(`The PR could not be confirmed with gh: ${clip(message(error), 300)}`);
      }
    }
    if (!issueUrl) {
      problem("No issue was reported for this change.");
    } else if (!issueLink) {
      problem(`The reported issue link is not an issue of ${pi.repo}: ${clip(issueUrl, 200)}`);
    } else {
      outcome.issue = { url: issueLink.url, confirmed: false };
      try {
        await gh(["issue", "view", String(issueLink.number), "--repo", pi.repo, "--json", "number,state"]);
        outcome.issue.confirmed = true;
      } catch (error) {
        problem(`The issue could not be confirmed with gh: ${clip(message(error), 300)}`);
      }
    }
    return baseChangedAt;
  }

  /** The part of an outcome that the event stream alone decides. */
  function baseOutcome(saved: SavedRun, trace: RunTrace, status: RunStatus): RunOutcome {
    return {
      runId: saved.runId, status, summary: "",
      review: reviewOf(trace, undefined, saved.pr),
      usage: trace.usage,
      usageComplete: status === "completed" && trace.unfinishedDelegates === 0 && trace.unaccountedDelegates === 0,
      remaining: [], problems: [], logDir: saved.logDir,
    };
  }

  /** Links the run printed or reported, for a run that ended without the host asking GitHub. */
  function unconfirmedLinks(trace: RunTrace, outcome: RunOutcome): void {
    const report = readReport(trace.lastText);
    const pr = [trace.prLinks.at(-1), report?.pr].map(url => url && githubLink(url, pi.repo, "pull")).find(Boolean);
    if (pr) outcome.pr = { url: pr.url, number: pr.number, confirmed: false };
    const issue = [report?.issue, trace.issueLinks.at(-1)].map(url => url && githubLink(url, pi.repo, "issues")).find(Boolean);
    if (issue) outcome.issue = { url: issue.url, confirmed: false };
  }

  const processIds = (value: unknown): value is [number, string][] => Array.isArray(value) && value.every(proc =>
    Array.isArray(proc) && proc.length === 2 && Number.isSafeInteger(proc[0]) && typeof proc[1] === "string");

  /** Whether a saved record names the directories this host gives a run, so that cleanup deletes nothing else. */
  const ownRecord = (saved: unknown): saved is SavedRun | LegacySavedRun => {
    const run = saved as SavedRun | LegacySavedRun | null;
    return typeof run === "object" && run !== null
      && typeof run.runId === "string" && /^[0-9A-Za-z][\w-]*$/.test(run.runId)
      && run.workspace === join(config.runsDir, run.runId) && run.logDir === join(logRoot, run.runId)
      && Number.isSafeInteger(run.conversationId) && Number.isSafeInteger(run.taskId)
      && Array.isArray(run.groups) && ("asOf" in run
        ? typeof run.asOf === "number" && run.groups.every(Number.isSafeInteger)
        : run.groups.every(group => Array.isArray(group) && group.length === 2 && Number.isSafeInteger(group[0])
          && (group[1] === null || (Number.isSafeInteger(group[1]) && group[1] >= 0))))
      && processIds(run.procs) && (!("unverifiedProcs" in run) || processIds(run.unverifiedProcs))
      && (!("activeChild" in run) || processIds([run.activeChild]))
      && (!("cleanupUncertain" in run) || run.cleanupUncertain === true);
  };

  // A run the previous process left: stop it, clean up, and report its call `interrupted`. It is never run again.
  let left: SavedRun | undefined;
  let pendingRecoveryRecord = false;
  try {
    const readStartedAt = Date.now();
    const saved = await readJson<unknown>(stateFile);
    const readAt = Math.min(readStartedAt, Date.now());
    // Anything the file holds that is not a run of this data directory, `null` included, is a damaged record.
    if (saved !== undefined && !ownRecord(saved)) throw new Error("it does not describe a run of this data directory");
    if (saved && "asOf" in saved) {
      // Neither the old run-wide time nor the processes it may have misclassified can prove ownership. Keep
      // them as potential blockers (without the time), and require independent evidence before signalling.
      const { asOf: _asOf, groups, procs, ...run } = saved;
      left = { ...run, groups: groups.map(pgid => [pgid, null]), procs: [], unverifiedProcs: procs };
    } else if (saved && saved.groups.some(([, seenAt]) => seenAt !== null && seenAt > readAt)) {
      // Persist this before replaying the run's logs: a future cutoff could become usable while we wait.
      left = { ...saved, groups: saved.groups.map(([pgid, seenAt]) => [pgid, seenAt !== null && seenAt > readAt ? null : seenAt]) };
      try {
        await writeJson(stateFile, left);
      } catch {
        // Use only the corrected record. stopRun will retry the write before signalling or allowing cleanup.
        pendingRecoveryRecord = true;
      }
    } else {
      left = saved;
    }
  } catch (error) {
    left = undefined;
    stuck = `The record of an earlier Pi run, ${stateFile}, cannot be used (${clip(message(error), 300)}). Its processes and workspace may still be there. `
      + "No new run starts until it is inspected and removed, and aipatty restarted.";
    console.error(`Pi runs: ${stuck}`);
  }
  if (left) {
    const saved = left;
    try {
      const key = String(saved.taskId);
      // A run that had already settled keeps its outcome; only its cleanup is finished here. The copy in its log
      // directory is written first, so it can be ahead of the index.
      const settledBefore = (await logged(saved.runId, saved.taskId))?.entry
        ?? (kept.get(key)?.outcome.runId === saved.runId ? kept.get(key) : undefined);
      const owned = newOwned(saved.procs, saved.groups, saved.unverifiedProcs);
      // What the cleanup learns of the run's processes is kept for the next start, should this one not finish.
      const record = async () => {
        await writeJson(stateFile, { ...saved, procs: [...owned.procs], groups: [...owned.groups] });
        pendingRecoveryRecord = false;
      };
      const stop = async () => {
        const activeChild = saved.activeChild;
        let verified = !activeChild;
        const survivors = await stopRun(owned, saved.runId, saved.pid, graceMs, undefined, record, () => pendingRecoveryRecord, undefined, tree => {
          if (activeChild) {
            const [pid, start] = activeChild;
            verified = tree.some(proc => proc.pid === pid && proc.start === start && proc.pgid === pid);
          }
        });
        // An emergency stop may not have been able to write its permanent blocker. If the launcher is now
        // gone too, an empty scan cannot distinguish a clean stop from a detached, unmarked orphan.
        if (!verified) saved.cleanupUncertain = true;
        return survivors;
      };
      const trace = new RunTrace(pi.repo);
      const split = lineSplitter((line, whole) => trace.line(line, whole));
      try {
        for await (const chunk of createReadStream(join(saved.logDir, "events.jsonl"))) split.write(chunk as Buffer);
      } catch (error) {
        if (!isMissing(error)) {
          // Part of a transcript is not the run's account: stop the run, and keep its record for another try.
          const reason = `its events could not be read: ${message(error)}`;
          try {
            if (!(await stop()).length) await disarmLaunchGuard(saved, record);
          } catch (stopError) {
            throw new Error(`${reason}; stopping it also failed: ${message(stopError)}`);
          }
          throw new Error(reason);
        }
      }
      split.end();
      const outcome = settledBefore?.outcome ?? baseOutcome(saved, trace, "interrupted");
      if (!settledBefore) {
        outcome.summary = "aipatty stopped while this run was in progress. The run was stopped and is not run again; "
          + "it may have partially run. Check GitHub for what it published before starting another.";
        outcome.usageComplete = false;
        unconfirmedLinks(trace, outcome);
      }
      const { clean, reconciled } = await cleanUp(saved, trace, outcome, settledBefore?.reconciled ?? false, stop, record);
      if (outcome.status === "completed" && outcome.problems.length) outcome.status = "failed";
      await remembered(saved, outcome, reconciled);
      let handed = clean;
      if (clean) {
        try {
          await rm(stateFile, { force: true });
        } catch (error) {
          handed = false;
          outcome.problems.push(`The run's record could not be closed: ${clip(message(error), 300)}`);
        }
      }
      if (handed) {
        console.error(`Pi run ${saved.runId} was interrupted by a restart; its processes and workspace are cleaned up.`);
      } else {
        // As for a live run: one that leaves the slot shut did not complete.
        if (outcome.status === "completed") outcome.status = "failed";
        await remembered(saved, outcome, reconciled).catch(() => {});
        await record().catch(() => {});
        stuck = `Pi run ${saved.runId} could not be cleaned up after a restart: ${outcome.problems.at(-1)} No new run starts until that is resolved and aipatty restarted.`;
      }
    } catch (error) {
      // The host still opens: only `pi` is closed, until someone has looked.
      stuck = `Pi run ${saved.runId} could not be recovered after a restart (${clip(message(error), 300)}). No new run starts until that is resolved and aipatty restarted.`;
    }
    if (stuck) console.error(`Pi runs: ${stuck}`);
  }

  let active: ActiveRun | undefined;
  let closed = false;

  async function execute(request: RunRequest, saved: SavedRun, run: ActiveRun): Promise<RunOutcome | undefined> {
    const trace = new RunTrace(pi.repo);
    const problems: string[] = [];
    let code: number | null = null;
    let stderr = "";
    let launched = false;
    let term: (() => void) | undefined;

    // Serialize ownership discovery as well as writes. A stop must start with a fresh scan after any in-flight
    // adoption or poll has saved what it learned (or left the record dirty), and no poll may change it mid-stop.
    let ownership = Promise.resolve();
    const withOwnership = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = ownership.then(operation);
      ownership = result.then(() => {}, () => {});
      return result;
    };
    let recording = true;
    let recordEstablished = false;
    let recordDirty = false;
    const write = async (launchPending = false) => {
      if (!recording) return;
      recordDirty = true;
      await writeJson(stateFile, {
        ...saved, cleanupUncertain: launchPending || saved.cleanupUncertain,
        procs: [...run.owned.procs], groups: [...run.owned.groups],
      });
      recordEstablished = true;
      recordDirty = launchPending;
    };
    const save = () => write().catch(error => console.error(`Pi run ${saved.runId}: could not save its record:`, error));
    let killRequested = false;
    let verifiedEmptyStop = false;
    let drainUncertain = false;
    let abandonedChildren = false;
    const abandonment = Promise.withResolvers<null>();
    /** Remember a detached process this host started for the run, before waiting on it. */
    const adopt = async (child: ChildProcess, release: (start: boolean) => void): Promise<GroupRecordError | undefined> => {
      const pid = child.pid;
      if (pid === undefined) {
        release(false);
        return;
      }
      if (run.stop || killRequested) {
        release(false);
        return;
      }
      const seenAt = Date.now();
      if (invalidateFutureCutoffs(run.owned, seenAt)) {
        // Do not let a cutoff we observed in the future become usable again during a slow preflight read.
        try {
          await write();
        } catch (error) {
          release(false);
          run.kill();
          return new GroupRecordError(`could not save corrected process group cutoffs: ${message(error)}`);
        }
      }
      let before: Proc[];
      try {
        before = await listProcesses();
      } catch (error) {
        release(false);
        return new GroupRecordError(`could not read the process table for launcher ${pid}: ${message(error)}`);
      }
      const leader = live(child) ? before.find(proc => proc.pid === pid && proc.ppid === process.pid && proc.pgid === pid) : undefined;
      if (run.stop || killRequested || !leader) {
        release(false);
        if (!run.stop && !killRequested) return new GroupRecordError(`could not verify the launcher for process group ${pid}`);
        return;
      }
      // Before preflight completes, EOF on the gate is sufficient. Now checkpoint the group and block
      // cleanup before opening the gate: a crash during adoption could hide an already detached worker.
      invalidateFutureCutoffs(run.owned, Date.now());
      run.owned.groups.set(pid, null);
      const previousChild = saved.activeChild;
      // Keep this recovery guard even after adoption succeeds. Later storage failures must not prevent us
      // from noticing that the last launcher's ancestry is no longer available after a restart.
      saved.activeChild = [pid, leader.start];
      try {
        await write(true);
      } catch (error) {
        saved.activeChild = previousChild;
        release(false); // EOF lets the launcher exit without running the command or starting descendants.
        run.kill(); // Retry the dirty record and stop any other processes that can be verified.
        return new GroupRecordError(`could not save process group ${pid}: ${message(error)}`);
      }
      if (run.stop || killRequested) {
        saved.activeChild = previousChild;
        release(false);
        return;
      }
      // Exec keeps the verified identity. Keep descendants visible in this read even if a fast command exits.
      release(true);
      let procs: Proc[];
      try {
        procs = await listProcesses();
      } catch (error) {
        // The leader may have exited and an unmarked worker may no longer be reachable. Keep the blocker
        // already on disk, even if a later scan is empty. Stop only what can still be verified.
        saved.cleanupUncertain = true;
        remember(run.owned, [leader]);
        run.kill();
        return new GroupRecordError(`could not scan process group ${pid} after launch: ${message(error)}`);
      }
      const scannedAt = Date.now();
      invalidateFutureCutoffs(run.owned, scannedAt);
      remember(run.owned, [leader, ...identifiedTree(procs, new Map([[pid, leader.start]]))], seenAt <= scannedAt ? seenAt : undefined);
      await save();
    };
    /** The children this host started directly: their live handles also anchor a stop scan. */
    const held = new Set<ChildProcess>();
    const released = new Set<ChildProcess>();
    const live = (child: ChildProcess): child is ChildProcess & { pid: number } =>
      child.pid !== undefined && child.exitCode === null && child.signalCode === null;
    const livePids = (children = held) => new Set([...children].filter(live).map(child => child.pid));
    const stop = async (grace = graceMs, observe?: (tree: readonly Proc[]) => void) => {
      if (!recordEstablished) return []; // Nothing could have been launched.
      return stopRun(run.owned, saved.runId, saved.pid, grace, term, write, () => recordDirty, livePids, observe);
    };
    const disarmStoppedLaunch = async () => {
      if (verifiedEmptyStop && !released.size && !drainUncertain) {
        await disarmLaunchGuard(saved, write).catch(error => console.error(`Pi run ${saved.runId}: could not record the verified stop:`, error));
      }
    };
    run.kill = () => {
      if (killRequested) return;
      killRequested = true;
      // Include a released launcher that exited but whose pipes are still open. Do not forget an anchor
      // simply because it exited while output drained or while the stop waited behind an ownership write.
      const pending = new Set([...released].flatMap(child => child.pid === undefined ? [] : [child.pid]));
      void withOwnership(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const verified = new Set<number>();
          let left: Proc[] | undefined;
          try {
            left = await stop(attempt === 0 ? graceMs : 0, tree => {
              const live = livePids(released);
              for (const proc of tree) if (live.has(proc.pid)) verified.add(proc.pid);
            });
          } catch (error) {
            verified.clear();
            console.error(`Pi run ${saved.runId}: could not stop its processes by scanning:`, error);
          }
          const after = livePids(released);
          const exited = [...pending].filter(pid => !after.has(pid));
          if (exited.some(pid => !verified.has(pid))) break;
          for (const pid of exited) pending.delete(pid);
          if (!after.size) {
            verifiedEmptyStop = left?.length === 0;
            await disarmStoppedLaunch();
            return;
          }
        }
        // Keep the workspace when an emergency stop could not verify the tree. If this write fails, the
        // launcher guard was already saved before the command started, and the fallback must not signal.
        saved.cleanupUncertain = true;
        try {
          await write();
        } catch (error) {
          // Do not sever the ancestry without the active record checkpoint, or wait forever for the child.
          console.error(`Pi run ${saved.runId}: could not save the cleanup blocker:`, error);
          for (const child of held) {
            child.unref();
            for (const stream of child.stdio) {
              if (stream && "unref" in stream && typeof stream.unref === "function") stream.unref();
            }
          }
          abandonedChildren = true;
          abandonment.resolve(null);
          return;
        }
        for (const child of released) if (live(child)) child.kill("SIGKILL");
      }).catch(error => console.error(`Pi run ${saved.runId}: could not stop its children:`, error));
    };
    const drainTimedOut = () => {
      // A detached descendant may still hold an output pipe without being visible in a later scan.
      // Prevent an in-flight stop from disarming after we destroy the pipe, before this write runs.
      drainUncertain = true;
      void withOwnership(async () => {
        saved.cleanupUncertain = true;
        await save();
      });
      run.kill();
    };
    // The deadline covers the whole run, cloning included.
    const timer = setTimeout(() => {
      run.stop ??= "timed_out";
      run.kill();
    }, request.timeoutMs);

    const env: NodeJS.ProcessEnv = {
      ...process.env, PI_CODING_AGENT_DIR: pi.agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      GIT_TERMINAL_PROMPT: "0", [RUN_MARKER]: saved.runId,
    };
    // The server's own setting must not reach the checkout's tests, which refuse a stray AIPATTY_ variable.
    for (const name of Object.keys(env)) if (name.startsWith("AIPATTY_")) delete env[name];

    /** Start a group without running its command until the group is recorded. EOF (even on a crash) fails closed. */
    const launch = (file: string, args: string[], cwd: string | undefined, input: "ignore" | "pipe") => {
      // The shell only waits and execs literal argv; exec preserves the detached leader's PID and group.
      const child = spawn("/bin/sh", ["-c", 'IFS= read -r ready <&3 && [ "$ready" = run ] && exec "$@" 3<&-',
        "aipatty-launch", file, ...args], { cwd, env, stdio: [input, "pipe", "pipe", "pipe"], detached: true });
      const gate = child.stdio[3] as Writable | null;
      gate?.on("error", () => gate.destroy()); // The child can exit before the writer closes.
      held.add(child);
      child.once("close", () => {
        held.delete(child);
        released.delete(child);
      });
      const release = (start: boolean) => {
        if (start) released.add(child);
        gate?.end(start ? "run\n" : "");
      };
      return { child, stdout: child.stdout!, stderr: child.stderr!, release };
    };

    /** Run a setup command as part of the run: in its own process group, recorded, and stopped with the run. */
    const command = async (file: string, args: string[], cwd?: string): Promise<string> => {
      if (run.stop) throw new Error("the run was stopped");
      const { child, stdout, stderr, release } = launch(file, args, cwd, "ignore");
      let out = "", err = "";
      let failure: Error | undefined;
      stdout.on("data", (chunk: Buffer) => { out = (out + chunk).slice(0, 1024 * 1024); });
      stderr.on("data", (chunk: Buffer) => { err = (err + chunk).slice(-8_000); });
      const exit = exitOf(child, error => { failure = error; }, drainTimedOut);
      const adoptionError = await withOwnership(() => adopt(child, release));
      const exitCode = await Promise.race([exit, abandonment.promise]);
      if (adoptionError) throw adoptionError;
      if (abandonedChildren) throw new Error("a child could not be safely stopped");
      if (failure) throw failure;
      if (exitCode !== 0) throw new Error(tail(err, 6) || `${file} exited with ${exitCode ?? "a signal"}`);
      return out;
    };

    try {
      await mkdir(saved.logDir, { recursive: true, mode: 0o700 });
      await mkdir(saved.workspace, { recursive: true, mode: 0o700 });
      // Nothing starts without the record a later process needs to stop it.
      await withOwnership(() => write());
      if (request.pr) {
        // The review cannot run without pi-review, and the delegates extension only says so once a review is asked for.
        const settings = await readJson<{ delegates?: { reviewExtension?: unknown } }>(join(pi.agentDir, "settings.json")).catch(() => undefined);
        const configured = settings?.delegates?.reviewExtension;
        const review = typeof configured === "string" ? configured : join(pi.agentDir, "git/github.com/earendil-works/pi-review/review.ts");
        if (!(await lstat(review).catch(() => undefined))?.isFile()) {
          problems.push(`The review extension is missing at ${review}, so no PR could be reviewed. Install pi-review there or set delegates.reviewExtension in ${join(pi.agentDir, "settings.json")}.`);
        }
      }
      const repo = join(saved.workspace, "repo");
      let baseSha = "";
      if (!problems.length) try {
        await command(pi.git, ["clone", "--quiet", pi.repoUrl, repo]);
        // Resolve the base to a commit: a name that is only a file in the tree is not one.
        const names = [`refs/remotes/origin/${request.base}`, `refs/tags/${request.base}`, ...(/^[0-9a-f]{7,40}$/.test(request.base) ? [request.base] : [])];
        for (const name of names) {
          baseSha = (await command(pi.git, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`], repo).catch(error => {
            if (error instanceof GroupRecordError) throw error;
            return "";
          })).trim();
          if (baseSha) break;
        }
        if (!/^[0-9a-f]{40}$/.test(baseSha)) {
          baseSha = "";
          throw new Error("no such branch, tag or commit");
        }
        const cloned = (await command(pi.git, ["rev-parse", "--verify", "HEAD"], repo)).trim();
        if (cloned !== baseSha) await command(pi.git, ["checkout", "--quiet", "--detach", baseSha], repo);
      } catch (error) {
        baseSha = "";
        if (!run.stop || error instanceof GroupRecordError) problems.push(`Could not clone ${pi.repo} at ${request.base}: ${clip(message(error), 600)}`);
      }
      if (baseSha && !run.stop) {
        const input = {
          runId: saved.runId, repo: pi.repo, branch: request.conversationId, task: request.task, base: request.base, baseSha,
          pr: request.pr, timeoutMinutes: Math.max(1, Math.round(request.timeoutMs / 60_000)),
        };
        const rules = join(saved.logDir, "instructions.md");
        await writeFile(rules, instructions(input), { mode: 0o600 });
        const prompt = taskPrompt(input);
        await writeFile(join(saved.logDir, "prompt.md"), prompt, { mode: 0o600 });
        if (run.stop) throw new Error("the run was stopped"); // Do not spawn after a stop scan may have started.
        const events = createWriteStream(join(saved.logDir, "events.jsonl"), { mode: 0o600 });
        const errors = createWriteStream(join(saved.logDir, "stderr.log"), { mode: 0o600 });
        const { child, stdout, stderr: childStderr, release } = launch(pi.node, [
          pi.cli, "--mode", "json", "--no-session", "--model", request.model, "--thinking", request.thinking,
          // Nothing from the checkout or the agent directory loads by itself: only the pinned delegates extension.
          "--no-approve", "--no-extensions", "-e", pi.extension, "--no-skills", "--no-prompt-templates", "--no-themes",
          "--no-context-files", "--no-mcp", "--append-system-prompt", rules,
        ], repo, "pipe");
        launched = true;
        term = () => { child.kill("SIGTERM"); };
        const exited = exitOf(child, error => { problems.push(`Could not start Pi: ${error.message}`); }, drainTimedOut);
        // A transcript that cannot be written ends the run: its result could not be checked or kept.
        let logFailed = false;
        const logFailure = (error: Error) => {
          if (logFailed) return;
          logFailed = true;
          problems.push(`The run's logs could not be written: ${clip(error.message, 300)}`);
          stdout.resume();
          childStderr.resume();
          run.kill();
        };
        events.on("error", logFailure);
        errors.on("error", logFailure);
        // Keep no more in memory than the disk is behind by: let the pipe fill, and Pi wait.
        const throttled = (source: { pause(): unknown; resume(): unknown }, log: WriteStream) => {
          let waiting = false;
          return (data: string | Buffer) => {
            if (logFailed || log.write(data) || waiting) return;
            waiting = true;
            source.pause();
            log.once("drain", () => {
              waiting = false;
              source.resume();
            });
          };
        };
        const keepEvent = throttled(stdout, events);
        const keepError = throttled(childStderr, errors);
        const split = lineSplitter((line, whole) => {
          trace.line(line, whole);
          if (whole && !repeated(line)) keepEvent(line + "\n");
        });
        stdout.on("data", (chunk: Buffer) => split.write(chunk));
        childStderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-8_000);
          keepError(chunk);
        });
        child.stdin!.on("error", () => {});
        child.stdin!.end(prompt);
        const adoptionError = await withOwnership(() => {
          saved.pid = child.pid;
          return adopt(child, release);
        });
        if (adoptionError) problems.push(`Could not record Pi: ${adoptionError.message}`);
        // Remember the processes the run starts while their parents still live: a delegate leads its own group.
        let polling: Promise<void> | undefined;
        const poll = adoptionError ? undefined : setInterval(() => {
          if (killRequested || polling) return;
          polling = withOwnership(async () => {
            const changed = await trackRunProcesses(run.owned, saved.runId, save, livePids).catch(() => false);
            if (changed || recordDirty) await save();
          }).finally(() => { polling = undefined; });
        }, pollMs);
        code = await Promise.race([exited, abandonment.promise]);
        clearInterval(poll);
        await polling;
        if (abandonedChildren) {
          // Drain the pipes without logging once the run has settled.
          stdout.removeAllListeners("data");
          childStderr.removeAllListeners("data");
          stdout.resume();
          childStderr.resume();
        }
        split.end();
        const flushed = (stream: WriteStream) => new Promise<void>(done => {
          if (stream.destroyed) done();
          else stream.end(done);
        });
        await Promise.all([flushed(events), flushed(errors)]);
      }
    } catch (error) {
      problems.push(`The run failed in the host: ${clip(message(error), 600)}`);
    }
    clearTimeout(timer);
    await ownership;
    // From here the run ends as it ended: a later abort or shutdown gets this outcome.
    run.finalizing = true;
    // A stopped host leaves the workspace, the saved run and the result to the next start.
    if (run.stop === "shutdown") {
      await withOwnership(async () => {
        try {
          if (!(await stop(0)).length && !saved.cleanupUncertain) delete saved.activeChild;
        } catch {
          // The next start must still verify the guarded launcher before cleaning up.
        }
        await save();
      });
      return undefined;
    }
    // Save a verified empty stop before waiting on GitHub, including after an ordinary exit. If the scan
    // or checkpoint fails, keep recovery armed and skip confirmation rather than reporting a saved stop.
    let confirmationStopFailure: { error: unknown } | undefined;
    if (request.pr && launched && run.stop !== "aborted") {
      try {
        await withOwnership(async () => {
          const alreadyVerified = verifiedEmptyStop && !released.size && !drainUncertain;
          if (alreadyVerified || !(await stop()).length) await disarmLaunchGuard(saved, write);
        });
      } catch (error) {
        confirmationStopFailure = { error };
      }
    }

    const ok = launched && code === 0 && trace.settled && !trace.aborted && trace.lastStop === "stop"
      && trace.malformed === 0 && trace.oversized === 0 && !problems.length;
    const outcome = baseOutcome(saved, trace, run.stop ?? (ok ? "completed" : "failed"));
    outcome.problems.push(...problems);
    if (outcome.status === "aborted") outcome.summary = "The run was aborted. It may have partially run.";
    if (outcome.status === "timed_out") outcome.summary = `The run was stopped after ${Math.round(request.timeoutMs / 60_000)} minutes. It may have partially run.`;
    if (launched && outcome.status === "failed" && !problems.length) {
      if (trace.events === 0) outcome.problems.push("Pi produced no event stream.");
      if (trace.malformed) outcome.problems.push(`Pi's output had ${trace.malformed} line(s) that were not JSON events; the result is not trusted.`);
      if (trace.oversized) outcome.problems.push(`Pi's output had ${trace.oversized} event(s) too long to read; the result is not trusted.`);
      if (code !== 0) outcome.problems.push(`Pi exited with ${code === null ? "a signal" : `code ${code}`}.`);
      else if (!trace.settled) outcome.problems.push("Pi exited before it reported the run as settled.");
      else if (trace.lastStop !== "stop") outcome.problems.push(`Pi's last message ended with "${trace.lastStop}"${trace.lastError ? `: ${clip(trace.lastError, 400)}` : ""}.`);
      if (stderr.trim()) outcome.problems.push(`Pi's last error output: ${clip(tail(stderr, 8), 1_200)}`);
    }
    const report = readReport(trace.lastText);
    if (outcome.status === "completed" || outcome.status === "failed") {
      if (report) {
        outcome.summary = clip(report.summary, maxSummary);
        outcome.remaining = report.remaining.slice(0, maxItems).map(item => clip(item, maxItem));
      } else if (launched) {
        outcome.summary = clip(trace.lastText.trim(), maxSummary);
        if (outcome.status === "completed") outcome.problems.push("Pi's last message has no <result> block; its summary is its raw text.");
      }
    }
    try {
      if (outcome.status === "aborted" || !launched || confirmationStopFailure) {
        // Report what the run printed without asking GitHub.
        unconfirmedLinks(trace, outcome);
      } else if (request.pr) {
        const baseChangedAt = await confirm(trace, outcome, { pr: report?.pr, issue: report?.issue });
        outcome.review = reviewOf(trace, outcome.pr, true, baseChangedAt);
        if (outcome.status === "completed" && outcome.review.status !== "clean") {
          outcome.problems.push(`The PR is not reviewed clean. ${reviewText[outcome.review.status]}.`);
        }
      }
    } catch (error) {
      outcome.problems.push(`The result could not be checked: ${clip(message(error), 400)}`);
    }
    if (trace.unfinishedDelegates) outcome.problems.push(`${trace.unfinishedDelegates} delegate call(s) were cut off before they reported; the cost includes what their jobs had recorded.`);
    if (trace.unaccountedDelegates) outcome.problems.push(`${trace.unaccountedDelegates} delegate call(s) ended without a result; their spend is not included.`);
    const { clean, reconciled } = await cleanUp(saved, trace, outcome, false, async () => {
      if (confirmationStopFailure) throw confirmationStopFailure.error;
      return withOwnership(() => stop());
    }, () => withOwnership(() => write()));
    // `completed` only when everything the host checked holds.
    if (outcome.status === "completed" && outcome.problems.length) outcome.status = "failed";
    outcome.problems = outcome.problems.slice(0, maxItems);
    // Saved by call before the run's record goes: the harness may not have committed the result when this process dies.
    // The outcome is settled now. Whatever fails from here keeps the slot closed, and still returns it.
    let handed = clean;
    try {
      await remembered(saved, outcome, reconciled);
      // The record's last state has everything the cleanup learned, for the next start if this one was not clean.
      await withOwnership(async () => {
        await write();
        recording = false;
      });
      if (clean) await rm(stateFile, { force: true });
    } catch (error) {
      handed = false;
      outcome.problems.push(`The run's record could not be closed: ${clip(message(error), 300)}`);
    }
    // The caller sees what happened: a run that leaves the slot shut did not complete.
    if (!handed && outcome.status === "completed") {
      outcome.status = "failed";
      await remembered(saved, outcome, reconciled).catch(() => {});
    }
    if (!handed) {
      stuck = `Pi run ${saved.runId} could not be cleaned up: ${outcome.problems.at(-1)} No new run starts until that is resolved and aipatty restarted.`;
      console.error(`Pi runs: ${stuck}`);
    }
    return outcome;
  }

  return {
    active: () => active && { runId: active.saved.runId, conversationId: active.saved.conversationId },
    async run(request, signal) {
      if (closed) throw new Error("aipatty is shutting down");
      if (active) {
        const { runId, conversationId } = active.saved;
        throw new Error(`Pi run ${runId}, started from branch ${conversationId}, is still active. Only one run at a time: wait for it, or abort that branch.`);
      }
      if (stuck) throw new Error(stuck);
      signal?.throwIfAborted();
      const runId = `${new Date().toISOString().replace(/[-:]|\.\d+Z$/g, "")}-${randomUUID().slice(0, 8)}`;
      const saved: SavedRun = {
        runId, conversationId: request.conversationId, taskId: request.taskId, pr: request.pr,
        startedAt: new Date().toISOString(), workspace: join(config.runsDir, runId), logDir: join(logRoot, runId),
        procs: [], groups: [],
      };
      const run: ActiveRun = { saved, owned: newOwned(), finalizing: false, kill: () => {}, done: Promise.resolve(undefined) };
      active = run;
      const onAbort = () => {
        if (run.finalizing) return;
        run.stop ??= "aborted";
        run.kill();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      run.done = execute(request, saved, run).catch(error => {
        // Nothing of the run is known to be cleaned up: keep its record, and the slot, for the next start.
        stuck = `Pi run ${runId} failed in the host and was not cleaned up (${clip(message(error), 300)}). No new run starts until aipatty restarts.`;
        console.error(`Pi runs: ${stuck}`);
        throw error;
      }).finally(() => {
        signal?.removeEventListener("abort", onAbort);
        if (active === run) active = undefined;
      });
      const outcome = await run.done;
      if (!outcome) {
        // The host is stopping. Settle nothing: the harness closes next, and the next start reports the call as
        // interrupted. An error thrown now could be committed as the call's result first.
        await new Promise<never>((_, reject) => {
          const stopped = () => reject(new Error("aipatty stopped during the run"));
          if (!signal || signal.aborted) stopped();
          else signal.addEventListener("abort", stopped, { once: true });
        });
        throw new Error("aipatty stopped during the run");
      }
      return outcome;
    },
    async settled(taskId) {
      const key = String(taskId);
      if (active && active.saved.taskId === taskId) {
        if (!active.finalizing) {
          active.stop ??= "aborted";
          active.kill();
        }
        return await active.done.catch(() => undefined) ?? kept.get(key)?.outcome;
      }
      return kept.get(key)?.outcome;
    },
    async close() {
      closed = true;
      if (!active) return;
      if (!active.finalizing) {
        active.stop ??= "shutdown";
        active.kill();
      }
      await active.done.catch(() => {});
    },
  };
}

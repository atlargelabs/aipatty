import type { Usage } from "@earendil-works/pi-ai";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { instructions, taskPrompt } from "./pi-prompt.ts";
import { addUsage, githubLink, readReport, RunTrace, type JobUsage, type Review } from "./pi-trace.ts";
import { listProcesses, newOwned, remember, runProcesses, RUN_MARKER, stopRun, type Owned } from "./processes.ts";

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
  callId: string;
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
  callId: string;
  pr: boolean;
  startedAt: string;
  workspace: string;
  logDir: string;
  /** The Pi process, once it runs. */
  pid?: number;
  procs: [number, string][];
  groups: number[];
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

function callKey(conversationId: number, callId: string): string {
  return `${conversationId}:${callId}`;
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
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}

/** A JSON file's value, or `undefined` when there is no such file. A file that exists and cannot be read throws. */
async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text) as T;
}

/** Feed complete lines to `onLine`. Pi's stream is split on LF only: other separators are valid inside its JSON. */
function lineSplitter(onLine: (line: string) => void) {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  const feed = (text: string) => {
    rest += text;
    let end: number;
    while ((end = rest.indexOf("\n")) >= 0) {
      onLine(rest.slice(0, end));
      rest = rest.slice(end + 1);
    }
  };
  return {
    write: (chunk: Buffer) => feed(decoder.write(chunk)),
    end: () => {
      feed(decoder.end());
      if (rest) onLine(rest);
      rest = "";
    },
  };
}

/** Streaming deltas repeat what the completed messages carry; the retained transcript leaves them out. */
function retained(line: string): boolean {
  return !line.startsWith('{"type":"message_update"') && !line.startsWith('{"type":"tool_execution_update"');
}

function reviewOf(trace: RunTrace, pr: RunOutcome["pr"], requested: boolean): RunOutcome["review"] {
  if (!requested) return { status: "none", important: 0, lesser: 0 };
  const last = trace.reviews.findLast(review => review.finished);
  if (!last) return { status: "missing", important: 0, lesser: 0 };
  const { verdict, sha, important, lesser } = last;
  const status = verdict !== "correct" || important > 0 ? "findings"
    : !pr?.confirmed ? "unverified"
    // The same head commit under another request, such as `/review commit`, is not a review of the PR's whole diff.
    : last.pr !== pr.number || sha !== pr.headSha ? "stale" : "clean";
  return { status, verdict, sha, important, lesser };
}

const reviewText: Record<RunOutcome["review"]["status"], string> = {
  clean: "reviewed",
  missing: "NOT REVIEWED: no crmanager review finished",
  findings: "NOT REVIEWED CLEAN: the last review has important findings or states no \"correct\" verdict",
  stale: "NOT REVIEWED: the last review was not a `/review pr` of this PR at its head commit",
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
  settled(conversationId: number, callId: string): Promise<RunOutcome | undefined>;
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
    const stat = await lstat(path).catch(() => undefined);
    return !!stat?.isDirectory() && !stat.isSymbolicLink()
      && await realpath(path) === join(await realpath(parent), path.slice(resolve(parent).length + 1));
  };

  /** Why a new run is refused until aipatty restarts: an earlier run's processes or files are still there. */
  let stuck: string | undefined;

  // The newest outcomes by call. A call's outcome is saved here before its run's record is removed, so that the
  // harness can still be given it when the process dies, or the call is aborted, before the result is committed.
  let outcomes = new Map<string, RunOutcome>();
  try {
    outcomes = new Map(Object.entries(await readJson<Record<string, RunOutcome>>(outcomesFile) ?? {}));
  } catch (error) {
    const aside = `${outcomesFile}.unreadable-${Date.now()}`;
    await rename(outcomesFile, aside).catch(() => {});
    console.error(`Pi runs: ${outcomesFile} could not be read (${message(error)}); moved to ${aside}.`);
  }
  const remembered = async (saved: SavedRun, outcome: RunOutcome) => {
    outcomes.set(callKey(saved.conversationId, saved.callId), outcome);
    for (const key of [...outcomes.keys()].slice(0, Math.max(0, outcomes.size - outcomesKept))) outcomes.delete(key);
    await writeJson(outcomesFile, Object.fromEntries(outcomes));
    await writeJson(join(saved.logDir, "result.json"), outcome).catch(() => {});
  };

  /**
   * Account for and clear away the delegate jobs a run started. A job belongs to the run when it carries the run's
   * session ID or was cloned from the run's workspace or from another of its jobs. Their logs are kept, the spend
   * of jobs that never reported is added from their manifests, and their clones, which the extension leaves in the
   * agent directory, are deleted.
   */
  async function collectJobs(saved: SavedRun, trace: RunTrace, outcome: RunOutcome, reconcile: boolean): Promise<void> {
    const jobs = new Map<string, JobManifest>();
    for (const id of await readdir(jobsDir).catch(() => [] as string[])) {
      const dir = join(jobsDir, id);
      // A job directory that is a link could lead anywhere.
      if (!await ownDir(jobsDir, dir)) continue;
      try {
        const job = await readJson<JobManifest>(join(dir, "job.json"));
        if (job && typeof job === "object") jobs.set(id, job);
      } catch (error) {
        // It may be this run's: say so, and leave it alone.
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
        if ((trace.sessionId !== undefined && job.ownerSession === trace.sessionId) || fromRun) {
          ours.add(id);
          grew = true;
        }
      }
    }
    // Spend the event stream did not carry: jobs cut off before their call reported. A finished job's usage includes
    // the jobs it started, as a reported one's does, so a job below either is already counted.
    const reported = (id: string) => trace.countedJobs.has(id) && !trace.continuing.has(id);
    for (const id of reconcile ? ours : []) {
      if (reported(id)) continue;
      let covered = false;
      const walked = new Set([id]);
      for (let parent = jobs.get(id)?.parentId; parent !== undefined && !walked.has(parent); parent = jobs.get(parent)?.parentId) {
        walked.add(parent);
        if (ours.has(parent) && (reported(parent) || jobs.get(parent)?.finishedAt !== undefined)) covered = true;
      }
      if (!covered) addUsage(outcome.usage, jobs.get(id)?.usage);
    }
    for (const id of ours) {
      const dir = join(jobsDir, id);
      const clone = join(dir, "workspace");
      await cp(dir, join(saved.logDir, "delegates", id), {
        recursive: true, filter: source => source !== clone && !inside(clone, source),
      }).catch(error => console.error(`Pi run ${saved.runId}: could not keep the logs of delegate ${id}:`, error));
      if (await ownDir(dir, clone)) await rm(clone, { recursive: true, force: true });
      await rm(join(dir, "lease.json"), { force: true });
      await writeFile(join(dir, "discarded"), new Date().toISOString(), { mode: 0o600 }).catch(() => {});
    }
  }

  /**
   * Stop what is left of a run, keep its logs, and delete its workspace and its delegates' clones. False when
   * something of the run is still there: the caller then keeps the run's record and admits no new run.
   */
  async function cleanUp(
    saved: SavedRun, owned: Owned, trace: RunTrace, outcome: RunOutcome, options: { term?: () => void; reconcile?: boolean } = {},
  ): Promise<boolean> {
    try {
      const left = await stopRun(owned, saved.runId, saved.pid, graceMs, options.term);
      if (left.length) {
        outcome.problems.push(`${left.length} process(es) of the run could not be stopped (${left.map(proc => proc.pid).join(", ")}); its workspace was left in ${saved.workspace}.`);
        outcome.usageComplete = false;
        return false;
      }
      await collectJobs(saved, trace, outcome, options.reconcile ?? true);
      // Only the directory this host made for the run, never a path a damaged record names.
      if (saved.workspace !== join(config.runsDir, saved.runId)) throw new Error(`${saved.workspace} is not this run's workspace`);
      if (await lstat(saved.workspace).catch(() => undefined)) {
        if (!await ownDir(config.runsDir, saved.workspace)) throw new Error(`${saved.workspace} is not a directory of ${config.runsDir}`);
        await rm(saved.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      }
      return true;
    } catch (error) {
      outcome.problems.push(`The run could not be cleaned up: ${clip(message(error), 400)}`);
      outcome.usageComplete = false;
      return false;
    }
  }

  const gh = async (args: string[]): Promise<unknown> => {
    const { stdout } = await exec(pi.gh, args, { cwd: config.dataDir, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  };

  /**
   * Check the PR and issue with GitHub; a URL in the model's output is not proof of either. Whether the delivery
   * holds: an open PR against `main` whose body links a confirmed issue.
   */
  async function confirm(trace: RunTrace, outcome: RunOutcome, reported: { pr?: string; issue?: string }): Promise<boolean> {
    let delivered = true;
    const problem = (text: string) => {
      outcome.problems.push(text);
      delivered = false;
    };
    const prUrl = trace.prLinks.at(-1) ?? reported.pr;
    const prLink = prUrl ? githubLink(prUrl, pi.repo, "pull") : undefined;
    let body = "";
    if (!prUrl) {
      problem("No PR was found, though one was requested.");
    } else if (!prLink) {
      problem(`The reported PR link is not a PR of ${pi.repo}: ${clip(prUrl, 200)}`);
    } else {
      outcome.pr = { url: prLink.url, number: prLink.number, confirmed: false };
      try {
        const pr = await gh(["pr", "view", String(prLink.number), "--repo", pi.repo, "--json", "number,url,state,headRefOid,baseRefName,body"]) as {
          state?: string; headRefOid?: string; baseRefName?: string; body?: string;
        };
        if (typeof pr.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(pr.headRefOid)) throw new Error("no head commit in gh's answer");
        outcome.pr = { ...outcome.pr, headSha: pr.headRefOid, state: pr.state ?? "UNKNOWN", confirmed: true };
        body = pr.body ?? "";
        if (pr.state !== "OPEN") problem(`The PR is ${pr.state?.toLowerCase()}, not open.`);
        if (pr.baseRefName !== "main") problem(`The PR targets ${pr.baseRefName}, not main.`);
      } catch (error) {
        problem(`The PR could not be confirmed with gh: ${clip(message(error), 300)}`);
      }
    }
    const issueUrl = reported.issue ?? trace.issueLinks.at(-1);
    const issueLink = issueUrl ? githubLink(issueUrl, pi.repo, "issues") : undefined;
    if (!issueUrl) {
      problem("No issue was reported for this change.");
    } else if (!issueLink) {
      problem(`The reported issue link is not an issue of ${pi.repo}: ${clip(issueUrl, 200)}`);
    } else {
      outcome.issue = { url: issueLink.url, confirmed: false };
      try {
        await gh(["issue", "view", String(issueLink.number), "--repo", pi.repo, "--json", "number,state"]);
        outcome.issue.confirmed = true;
        if (outcome.pr?.confirmed && !new RegExp(`#${issueLink.number}\\b`).test(body)) {
          problem(`The PR body does not link issue #${issueLink.number}.`);
        }
      } catch (error) {
        problem(`The issue could not be confirmed with gh: ${clip(message(error), 300)}`);
      }
    }
    return delivered;
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

  /** Whether a saved record names the directories this host gives a run, so that cleanup deletes nothing else. */
  const ownRecord = (saved: SavedRun) => typeof saved.runId === "string" && /^[0-9A-Za-z][\w-]*$/.test(saved.runId)
    && saved.workspace === join(config.runsDir, saved.runId) && saved.logDir === join(logRoot, saved.runId)
    && Number.isSafeInteger(saved.conversationId) && typeof saved.callId === "string"
    && Array.isArray(saved.procs) && Array.isArray(saved.groups);

  // A run the previous process left: stop it, clean up, and report its call `interrupted`. It is never run again.
  let left: SavedRun | undefined;
  try {
    left = await readJson<SavedRun>(stateFile);
    if (left && !ownRecord(left)) throw new Error("it does not describe a run of this data directory");
  } catch (error) {
    left = undefined;
    stuck = `The record of an earlier Pi run, ${stateFile}, cannot be used (${clip(message(error), 300)}). Its processes and workspace may still be there. `
      + "No new run starts until it is inspected and removed, and aipatty restarted.";
    console.error(`Pi runs: ${stuck}`);
  }
  if (left) {
    const trace = new RunTrace(pi.repo);
    const split = lineSplitter(line => trace.line(line));
    try {
      for await (const chunk of createReadStream(join(left.logDir, "events.jsonl"))) split.write(chunk as Buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Pi run ${left.runId}: its events could not be read:`, error);
    }
    split.end();
    const key = callKey(left.conversationId, left.callId);
    // A run that had already settled keeps its outcome; only its cleanup is finished here.
    const outcome = outcomes.get(key) ?? baseOutcome(left, trace, "interrupted");
    if (!outcomes.has(key)) {
      outcome.summary = "aipatty stopped while this run was in progress. The run was stopped and is not run again; "
        + "it may have partially run. Check GitHub for what it published before starting another.";
      outcome.usageComplete = false;
      unconfirmedLinks(trace, outcome);
    }
    // An outcome settled before the restart already has its delegates' spend.
    const clean = await cleanUp(left, newOwned(left.procs, left.groups), trace, outcome, { reconcile: !outcomes.has(key) });
    await remembered(left, outcome);
    if (clean) {
      await rm(stateFile, { force: true });
      console.error(`Pi run ${left.runId} was interrupted by a restart; its processes and workspace are cleaned up.`);
    } else {
      stuck = `Pi run ${left.runId} could not be cleaned up after a restart: ${outcome.problems.at(-1)} No new run starts until that is resolved and aipatty restarted.`;
      console.error(`Pi runs: ${stuck}`);
    }
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

    // One writer at a time, and none once the run's record is handed over.
    let recording = true;
    let saving = Promise.resolve();
    const save = () => saving = saving.then(async () => {
      if (recording) await writeJson(stateFile, { ...saved, procs: [...run.owned.procs], groups: [...run.owned.groups] });
    }).catch(error => console.error(`Pi run ${saved.runId}: could not save its record:`, error));
    /** Remember a process this host started for the run, before waiting on it. */
    const adopt = async (pid: number | undefined) => {
      if (pid === undefined) return;
      const own = (await listProcesses().catch(() => [])).find(proc => proc.pid === pid);
      if (own) remember(run.owned, [own]);
      await save();
    };
    let stopping = Promise.resolve();
    run.kill = () => {
      stopping = stopping.then(async () => { await stopRun(run.owned, saved.runId, saved.pid, graceMs, term); }).catch(() => {});
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

    /** Run a setup command as part of the run: in its own process group, recorded, and stopped with the run. */
    const command = async (file: string, args: string[], cwd?: string): Promise<string> => {
      if (run.stop) throw new Error("the run was stopped");
      const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let out = "", err = "";
      child.stdout.on("data", (chunk: Buffer) => { out = (out + chunk).slice(0, 1024 * 1024); });
      child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk).slice(-8_000); });
      const exit = new Promise<number | null>((done, fail) => {
        child.once("error", fail);
        child.once("close", done);
      });
      exit.catch(() => {});
      await adopt(child.pid);
      // Stopped while it was being recorded: the stop may have missed it.
      if (run.stop) run.kill();
      const exitCode = await exit;
      if (exitCode !== 0) throw new Error(tail(err, 6) || `${file} exited with ${exitCode ?? "a signal"}`);
      return out;
    };

    try {
      await mkdir(saved.logDir, { recursive: true, mode: 0o700 });
      await mkdir(saved.workspace, { recursive: true, mode: 0o700 });
      await save();
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
          baseSha = (await command(pi.git, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`], repo).catch(() => "")).trim();
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
        if (!run.stop) problems.push(`Could not clone ${pi.repo} at ${request.base}: ${clip(message(error), 600)}`);
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
        const events = createWriteStream(join(saved.logDir, "events.jsonl"), { mode: 0o600 });
        const errors = createWriteStream(join(saved.logDir, "stderr.log"), { mode: 0o600 });
        const child = spawn(pi.node, [
          pi.cli, "--mode", "json", "--no-session", "--model", request.model, "--thinking", request.thinking,
          // Nothing from the checkout or the agent directory loads by itself: only the pinned delegates extension.
          "--no-approve", "--no-extensions", "-e", pi.extension, "--no-skills", "--no-prompt-templates", "--no-themes",
          "--no-context-files", "--no-mcp", "--append-system-prompt", rules,
        ], { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
        launched = true;
        term = () => { child.kill("SIGTERM"); };
        const exited = new Promise<number | null>(resolveExit => {
          child.once("error", error => {
            problems.push(`Could not start Pi: ${error.message}`);
            resolveExit(null);
          });
          child.once("close", resolveExit);
        });
        // A transcript that cannot be written ends the run: its result could not be checked or kept.
        let logFailed = false;
        const logFailure = (error: Error) => {
          if (logFailed) return;
          logFailed = true;
          problems.push(`The run's logs could not be written: ${clip(error.message, 300)}`);
          child.stdout.resume();
          child.stderr.resume();
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
        const keepEvent = throttled(child.stdout, events);
        const keepError = throttled(child.stderr, errors);
        const split = lineSplitter(line => {
          trace.line(line);
          if (retained(line)) keepEvent(line + "\n");
        });
        child.stdout.on("data", (chunk: Buffer) => split.write(chunk));
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-8_000);
          keepError(chunk);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(prompt);
        saved.pid = child.pid;
        await adopt(child.pid);
        if (run.stop) run.kill();
        // Remember the processes the run starts while their parents still live: a delegate leads its own group.
        let polling: Promise<void> | undefined;
        const poll = setInterval(() => {
          polling ??= runProcesses(run.owned, saved.runId).then(async procs => {
            if (remember(run.owned, procs)) await save();
          }).catch(() => {}).finally(() => { polling = undefined; });
        }, pollMs);
        code = await exited;
        clearInterval(poll);
        await polling;
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
    await stopping;
    await saving;

    // A stopped host leaves the workspace, the saved run and the result to the next start.
    if (run.stop === "shutdown") {
      await stopRun(run.owned, saved.runId, saved.pid, 0, term).catch(() => {});
      await save();
      await saving;
      return undefined;
    }
    // From here the run ends as it ended: a later abort or shutdown gets this outcome.
    run.finalizing = true;

    const ok = launched && code === 0 && trace.settled && !trace.aborted && trace.lastStop === "stop" && trace.malformed === 0 && !problems.length;
    const outcome = baseOutcome(saved, trace, run.stop ?? (ok ? "completed" : "failed"));
    outcome.problems.push(...problems);
    if (outcome.status === "aborted") outcome.summary = "The run was aborted. It may have partially run.";
    if (outcome.status === "timed_out") outcome.summary = `The run was stopped after ${Math.round(request.timeoutMs / 60_000)} minutes. It may have partially run.`;
    if (launched && outcome.status === "failed" && !problems.length) {
      if (trace.events === 0) outcome.problems.push("Pi produced no event stream.");
      if (trace.malformed) outcome.problems.push(`Pi's output had ${trace.malformed} line(s) that were not JSON events; the result is not trusted.`);
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
      if (outcome.status === "aborted" || !launched) {
        // An abort answers quickly: report what the run printed without asking GitHub.
        unconfirmedLinks(trace, outcome);
      } else if (request.pr) {
        await confirm(trace, outcome, { pr: report?.pr, issue: report?.issue });
        outcome.review = reviewOf(trace, outcome.pr, true);
        if (outcome.status === "completed" && outcome.review.status !== "clean") {
          outcome.problems.push(`The PR is not reviewed clean. ${reviewText[outcome.review.status]}.`);
        }
      }
    } catch (error) {
      outcome.problems.push(`The result could not be checked: ${clip(message(error), 400)}`);
    }
    if (trace.unfinishedDelegates) outcome.problems.push(`${trace.unfinishedDelegates} delegate call(s) were cut off before they reported; the cost includes what their jobs had recorded.`);
    if (trace.unaccountedDelegates) outcome.problems.push(`${trace.unaccountedDelegates} delegate call(s) ended without a result; their spend is not included.`);
    const clean = await cleanUp(saved, run.owned, trace, outcome, { term });
    // `completed` only when everything the host checked holds.
    if (outcome.status === "completed" && outcome.problems.length) outcome.status = "failed";
    outcome.problems = outcome.problems.slice(0, maxItems);
    // Saved by call before the run's record goes: the harness may not have committed the result when this process dies.
    await remembered(saved, outcome);
    recording = false;
    await saving;
    if (clean) {
      await rm(stateFile, { force: true });
    } else {
      stuck = `Pi run ${saved.runId} could not be cleaned up: ${outcome.problems.at(-1)} No new run starts until that is resolved and aipatty restarted.`;
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
        runId, conversationId: request.conversationId, callId: request.callId, pr: request.pr,
        startedAt: new Date().toISOString(), workspace: join(config.runsDir, runId), logDir: join(logRoot, runId), procs: [], groups: [],
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
    async settled(conversationId, callId) {
      const key = callKey(conversationId, callId);
      if (active && callKey(active.saved.conversationId, active.saved.callId) === key) {
        if (!active.finalizing) {
          active.stop ??= "aborted";
          active.kill();
        }
        return await active.done.catch(() => undefined) ?? outcomes.get(key);
      }
      return outcomes.get(key);
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

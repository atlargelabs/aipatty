import type { Usage } from "@earendil-works/pi-ai";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { instructions, taskPrompt } from "./pi-prompt.ts";
import { addUsage, githubLink, readReport, RunTrace, usageKey, type JobUsage, type Review } from "./pi-trace.ts";
import { readPiRunSnapshot, runLogParts } from "./pi-run-view.ts";
import { runStatuses, type PiRunSnapshot, type RunStatus } from "./protocol.ts";
import { listProcesses, newOwned, remember, runProcesses, RUN_MARKER, stopRun, type Owned } from "./processes.ts";

const exec = promisify(execFile);

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  /** Absent for older runs and runs whose end time wasn't observed. */
  durationMs?: number;
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
  groups: number[];
  /** Legacy cutoff; ignored for ownership. Write 0 so older readers can still parse the record. */
  asOf: number;
}

/** A call's outcome as kept by task, and whether the spend of its cut-off delegate jobs has been added to it. */
interface Kept {
  outcome: RunOutcome;
  reconciled: boolean;
  /** Absent in legacy outcomes, keyed only by the durable task. */
  conversationId?: number;
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
function exitOf(child: ChildProcess, onError: (error: Error) => void): Promise<number | null> {
  return new Promise(done => {
    child.once("error", error => {
      onError(error);
      done(null);
    });
    child.once("exit", code => {
      const timer = setTimeout(() => {
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
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
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

/** Delegates reads the trusted setting itself. Check it without editing it or using the legacy fallback. */
async function reviewerProblem(pi: Config["pi"]): Promise<string | undefined> {
  const missingFile = (error: NodeJS.ErrnoException) => {
    // Do not mistake permission errors (or other filesystem failures) for a missing install.
    if (!isMissing(error) && error.code !== "ENOTDIR") throw error;
    return undefined;
  };
  const pinned = await realpath(pi.reviewExtension).catch(missingFile);
  if (!pinned || !(await stat(pinned).catch(missingFile))?.isFile()) {
    return `The pinned review extension is missing or not a file at ${pi.reviewExtension}. Run npm ci --ignore-scripts in the running release.`;
  }
  const path = join(pi.agentDir, "settings.json");
  const fix = `Set delegates.reviewExtension in ${path} to an absolute path to ${pi.reviewExtension} `
    + "(use the absolute deploy/current path for managed releases; see docs/INSTALL.md).";
  let configured: unknown;
  try {
    configured = (await readJson<{ delegates?: { reviewExtension?: unknown } }>(path))?.delegates?.reviewExtension;
  } catch (error) {
    return `The review settings could not be read: ${clip(message(error), 200)}. ${fix}`;
  }
  if (typeof configured !== "string" || !isAbsolute(configured) || configured !== resolve(configured)) {
    return `The review extension setting is missing or is not a normalized absolute file path. ${fix}`;
  }
  // The stable deploy/current path is usually a symlink; compare the files it selects, not the path spelling.
  const selected = await realpath(configured).catch(missingFile);
  if (!selected) return `The configured review extension at ${configured} cannot be resolved. ${fix}`;
  if (selected !== pinned) return `The configured review extension at ${configured} does not match the running release. ${fix}`;
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
  /** Whether there is any run in progress, for the all-idle maintenance gate. */
  hasActive(): boolean;
  /**
   * Run Pi once. Rejects at once when this branch is active or held for cleanup, or when ownership is unknown;
   * otherwise resolves when this run is over and cleaned up.
   */
  run(request: RunRequest, signal?: AbortSignal, onStart?: (runId: string) => void): Promise<RunOutcome>;
  snapshot(runId: string): Promise<PiRunSnapshot | undefined>;
  /**
   * The outcome of a call whose result the harness did not get from the tool: aborted, or cut off by a restart.
   * Stops the call's run if it is still working, and waits for its cleanup.
   */
  settled(taskId: number, conversationId?: number): Promise<RunOutcome | undefined>;
  /** Stop all active runs' processes, leaving interrupted runs to the next start. */
  close(): Promise<void>;
}

/** Under the host's data directory lock, recover runs a previous process left behind before admitting calls. */
export async function openPiRuns(config: Config): Promise<PiRuns> {
  const { pi } = config;
  const pollMs = pi.pollMs ?? defaultPollMs;
  const legacyState = join(config.dataDir, "pi-run.json");
  const stateDir = join(config.dataDir, "pi-runs");
  const outcomesFile = join(config.dataDir, "pi-outcomes.json");
  const outcomeDir = join(config.dataDir, "pi-outcomes");
  const outcomeIndex = (taskId: number) => join(outcomeDir, `${taskId}.json`);
  const logRoot = join(config.dataDir, ...runLogParts);
  const jobsDir = join(pi.agentDir, "delegates", "jobs");
  await mkdir(logRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.runsDir, { recursive: true, mode: 0o700 });

  const inside = (parent: string, child: string) => resolve(child).startsWith(resolve(parent) + sep);
  // Only a missing path is "not there": anything else leaves the question open.
  const typeOf = (path: string) => lstat(path).catch(error => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  /** Whether `path` is a real directory, not a link to one, directly inside `parent`. */
  const ownDir = async (parent: string, path: string) => {
    const stat = await typeOf(path);
    return !!stat?.isDirectory() && !stat.isSymbolicLink()
      && await realpath(path) === join(await realpath(parent), path.slice(resolve(parent).length + 1));
  };

  const active = new Map<number, ActiveRun>();
  const heldBranches = new Map<number, { reason: string; taskId: number; outcome?: RunOutcome }>();
  let ownershipProblem: string | undefined;
  const hold = (saved: SavedRun, problem: string, outcome?: RunOutcome) => {
    const reason = `${problem} No new run starts on branch ${saved.conversationId} until that is resolved and aipatty restarted.`;
    heldBranches.set(saved.conversationId, { reason, taskId: saved.taskId, outcome });
    console.error(`Pi runs: ${reason}`);
  };

  const validRunId = (id: unknown): id is string => typeof id === "string" && /^[0-9A-Za-z][\w-]*$/.test(id);
  type Archived = Kept & { taskId: number };
  const isKept = (value: unknown): value is Kept => {
    const entry = value as Kept | null;
    const outcome = entry?.outcome;
    return typeof entry?.reconciled === "boolean" && !!outcome && validRunId(outcome.runId)
      && runStatuses.some(status => status === outcome.status) && typeof outcome.summary === "string"
      && typeof outcome.review?.status === "string" && Object.hasOwn(reviewText, outcome.review.status)
      && Number.isFinite(outcome.usage?.cost?.total) && Array.isArray(outcome.remaining) && Array.isArray(outcome.problems)
      && (entry.conversationId === undefined || Number.isSafeInteger(entry.conversationId));
  };
  /** The copy in a run's log directory, if it is that run's and that call's. */
  const logged = async (runId: string, saved?: SavedRun, file = "result.json"): Promise<Archived | undefined> => {
    const copy = await readJson<Archived>(join(logRoot, runId, file));
    if (copy === undefined) return undefined;
    if (!isKept(copy) || !Number.isSafeInteger(copy.taskId) || copy.outcome.runId !== runId
      || (saved && (copy.taskId !== saved.taskId || (copy.conversationId !== undefined && copy.conversationId !== saved.conversationId)))) {
      throw new Error(`${runId}/${file} does not describe this run's outcome`);
    }
    return copy;
  };

  // The old bounded index is read for calls that settled on a previous release. New outcomes have independent
  // task-to-run pointers (task IDs are unique in the durable store); concurrent finishes cannot evict or clobber
  // one another. The archive itself is always written first and is the primary copy of result and spend.
  const kept = new Map<string, Kept>();
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
      if (!validRunId(runId)) continue;
      const copy = await logged(runId).catch(() => undefined);
      if (copy) kept.set(String(copy.taskId), copy);
    }
    await writeJson(outcomesFile, Object.fromEntries(kept));
    console.error(`Pi runs: ${outcomesFile} could not be read (${message(error)}); copied to ${aside} and rebuilt from the run logs.`);
  }
  const indexOutcome = async (saved: SavedRun) => {
    await mkdir(outcomeDir, { recursive: true, mode: 0o700 });
    await writeJson(outcomeIndex(saved.taskId), saved.runId);
  };
  const recordOutcome = (saved: SavedRun, outcome: RunOutcome, reconciled: boolean, file: string) =>
    writeJson(join(saved.logDir, file), { outcome, reconciled, taskId: saved.taskId, conversationId: saved.conversationId });
  const rememberOutcome = async (saved: SavedRun, outcome: RunOutcome, reconciled: boolean) => {
    await recordOutcome(saved, outcome, reconciled, "result.json");
    await indexOutcome(saved);
    await rm(join(saved.logDir, "reconciled.json"), { force: true }).catch(() => {});
  };
  const isCall = (copy: Archived | undefined, taskId: number, conversationId?: number): copy is Archived =>
    copy?.taskId === taskId && (conversationId === undefined || copy.conversationId === conversationId);
  const settledOutcome = async (taskId: number, conversationId?: number) => {
    const held = conversationId === undefined ? [...heldBranches.values()].find(hold => hold.taskId === taskId)
      : heldBranches.get(conversationId);
    if (held?.taskId === taskId && held.outcome) return held.outcome;
    const legacy = kept.get(String(taskId));
    let damaged = false;
    try {
      const id = await readJson<unknown>(outcomeIndex(taskId));
      if (id !== undefined) {
        const copy = validRunId(id) ? await logged(id) : undefined;
        if (!isCall(copy, taskId, conversationId)) throw new Error("the indexed archive does not describe this call");
        return copy.outcome;
      }
      if (legacy && (conversationId === undefined || legacy.conversationId === undefined || legacy.conversationId === conversationId)) return legacy.outcome;
    } catch (error) {
      damaged = true;
      console.error(`Pi runs: could not read the indexed outcome of task ${taskId}: ${message(error)}`);
    }
    // The pointer is only an index. On a miss or damage, look for precisely this call's archive, without
    // overwriting evidence or choosing by recency. Only interruption/abort recovery uses this lookup.
    let found: RunOutcome | undefined;
    for (const dir of await readdir(logRoot, { withFileTypes: true })) {
      if (!dir.isDirectory() || !validRunId(dir.name)) continue;
      const copy = await logged(dir.name).catch(() => undefined);
      if (!isCall(copy, taskId, conversationId)) continue;
      if (found) throw new Error(`More than one Pi archive matches task ${taskId}.`);
      found = copy.outcome;
    }
    if (damaged && !found) throw new Error(`Could not locate a Pi archive for task ${taskId} after its outcome index failed. Check ${logRoot}.`);
    return found;
  };

  /**
   * The delegate jobs a run started. A job belongs to the run when it carries the run's session ID or was cloned
   * from the run's workspace or from another of its jobs. Throws when the jobs cannot be listed.
   */
  async function findJobs(saved: SavedRun, trace: RunTrace): Promise<{ jobs: Map<string, JobManifest>; ours: Set<string> }> {
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
        if (!(error instanceof SyntaxError)) {
          // A discarded job with no clone or lease cannot leave an outstanding workspace from this run, and
          // a stale unreadable audit trail must not break every branch. Other I/O failures may leave the scan
          // incomplete: don't mark spend reconciled or clear the record in that case.
          const discarded = (await typeOf(join(dir, "discarded")))?.isFile() && !await typeOf(join(dir, "workspace"))
            && !await typeOf(join(dir, "lease.json"));
          if (!discarded) throw new Error(`Delegate job ${id} could not be read: ${message(error)}`);
        }
        // Recency is not ownership: another Pi can be writing a job now. Without a reported ID or readable
        // provenance, leave the manifest, logs and clone untouched and do not include its spend in this run.
        if (trace.countedJobs.has(id)) jobs.set(id, {});
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

  /**
   * Stop what is left of a run, add its cut-off delegates' spend, keep its logs, and delete its workspace and its
   * delegates' clones. `clean` is false when something of the run is still there, or could not be looked at: the
   * caller then keeps the run's record and holds its branch. `reconciled` says whether the outcome now has that
   * spend; when this call added it, the outcome was saved with it before anything was deleted.
   */
  async function cleanUp(
    saved: SavedRun, owned: Owned, trace: RunTrace, outcome: RunOutcome, reconciled: boolean,
    options: { term?: () => void; record: () => Promise<unknown> },
  ): Promise<{ clean: boolean; reconciled: boolean }> {
    try {
      const left = await stopRun(owned, saved.runId, saved.pid, graceMs, options.term, options.record);
      if (left.length) {
        // Its jobs may still be spending: their spend is added by the cleanup that finds them stopped.
        outcome.problems.push(`${left.length} process(es) could not be stopped, or could not be told from the run's (${left.map(proc => proc.pid).join(", ")}); its workspace was left in ${saved.workspace}.`);
        outcome.usageComplete = false;
        return { clean: false, reconciled };
      }
      const { jobs, ours } = await findJobs(saved, trace);
      if (!reconciled) {
        reconcile(trace, outcome, jobs, ours);
        reconciled = true;
        // Keep the spend before deleting its sources, but do not publish a terminal result until cleanup ends.
        await recordOutcome(saved, outcome, true, "reconciled.json");
      }
      await discardJobs(saved, ours);
      // Only the directory this host made for the run, never a path a damaged record names.
      if (saved.workspace !== join(config.runsDir, saved.runId)) throw new Error(`${saved.workspace} is not this run's workspace`);
      if (await ownDir(config.runsDir, saved.workspace)) {
        await rm(saved.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } else if (await typeOf(saved.workspace)) {
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

  /** Whether a saved record names the directories this host gives a run, so that cleanup deletes nothing else. */
  const ownRecord = (saved: unknown): saved is SavedRun => {
    const run = saved as SavedRun | null;
    return typeof run === "object" && run !== null
      && validRunId(run.runId) && run.workspace === join(config.runsDir, run.runId) && run.logDir === join(logRoot, run.runId)
      && Number.isSafeInteger(run.conversationId) && Number.isSafeInteger(run.taskId)
      && typeof run.pr === "boolean" && typeof run.startedAt === "string"
      && (run.pid === undefined || Number.isSafeInteger(run.pid))
      && typeof run.asOf === "number" && Array.isArray(run.groups) && run.groups.every(Number.isSafeInteger)
      && Array.isArray(run.procs) && run.procs.every(proc => Array.isArray(proc) && proc.length === 2
        && Number.isSafeInteger(proc[0]) && typeof proc[1] === "string");
  };

  const recordProblem = (path: string, error: unknown) => {
    const reason = `The earlier Pi run state at ${path} cannot be used (${clip(message(error), 300)}). Processes and workspaces may still be there. `
      + "No new run starts until it is inspected and resolved, and aipatty restarted.";
    ownershipProblem ??= reason;
    console.error(`Pi runs: ${reason}`);
  };
  const records: { path: string; saved: SavedRun }[] = [];
  const ambiguousIds = new Set<string>();
  // Fully enumerate before trying cleanup: a conflicting record must not supply ownership evidence for a signal.
  const readRecord = async (path: string, expectedId?: string) => {
    try {
      const type = await lstat(path).catch(error => {
        if (expectedId === undefined && isMissing(error)) return undefined;
        throw error;
      });
      if (!type) return; // A legacy installation may have no singleton record.
      if (!type.isFile() || type.nlink !== 1) throw new Error("not an independent regular file");
      const saved = await readJson<unknown>(path);
      if (!ownRecord(saved)) throw new Error("it does not describe a run of this data directory");
      if (expectedId !== undefined && saved.runId !== expectedId) {
        ambiguousIds.add(saved.runId);
        throw new Error("its run ID does not match its filename");
      }
      records.push({ path, saved });
    } catch (error) {
      if (expectedId !== undefined) ambiguousIds.add(expectedId);
      recordProblem(path, error);
    }
  };
  await readRecord(legacyState);
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    if (!await ownDir(config.dataDir, stateDir)) throw new Error("not a directory of the data directory");
    for (const name of await readdir(stateDir)) {
      const path = join(stateDir, name);
      // An unfinished atomic write is not a checkpoint: Pi cannot start before the first rename succeeds.
      if (/^[0-9A-Za-z][\w-]*\.json\.[0-9a-f-]{36}\.tmp$/.test(name)) continue;
      const id = name.endsWith(".json") ? name.slice(0, -5) : undefined;
      if (validRunId(id)) await readRecord(path, id);
      else recordProblem(path, "unexpected file in the checkpoint directory");
    }
  } catch (error) {
    recordProblem(stateDir, error);
  }
  const identities = new Map<string, SavedRun>();
  const ambiguous = new Set<SavedRun>();
  for (const { saved } of records) {
    const processIds = saved.procs.map(([pid, start]) => `process:${pid}:${start}`);
    for (const identity of new Set([`run:${saved.runId}`, `branch:${saved.conversationId}`, `task:${saved.taskId}`, ...processIds])) {
      const first = identities.get(identity);
      if (first) {
        ambiguous.add(first);
        ambiguous.add(saved);
      } else {
        identities.set(identity, saved);
      }
    }
  }

  // Recover each known owner independently. A run is stopped, not replayed. The legacy file is recovered in
  // place and never copied to the new directory, so a crash during cutover cannot create a second record.
  async function recover(saved: SavedRun, stateFile: string) {
    const owned = newOwned(saved.procs, saved.groups);
    const record = () => writeJson(stateFile, { ...saved, procs: [...owned.procs], groups: [...owned.groups], asOf: 0 });
    const trace = new RunTrace(pi.repo);
    let outcome: RunOutcome | undefined;
    const interrupted = (result: RunOutcome) => {
      result.status = "interrupted";
      result.summary = "aipatty stopped while this run was in progress. The run is not run again; "
        + "it may have partially run. Check GitHub for what it published before starting another.";
      result.usageComplete = false;
      return result;
    };
    try {
      const old = kept.get(String(saved.taskId));
      const final = await logged(saved.runId, saved) ?? (old?.outcome.runId === saved.runId
        && (old.conversationId === undefined || old.conversationId === saved.conversationId) ? old : undefined);
      outcome = final?.outcome;
      const pending = final ? undefined : await logged(saved.runId, saved, "reconciled.json");
      // If events can't be replayed for cleanup, still deliver spend saved before the interruption.
      if (pending) outcome = interrupted(pending.outcome);
      const split = lineSplitter((line, whole) => trace.line(line, whole));
      try {
        for await (const chunk of createReadStream(join(saved.logDir, "events.jsonl"))) split.write(chunk as Buffer);
      } catch (error) {
        if (!isMissing(error)) throw new Error(`its events could not be read: ${message(error)}`);
      }
      split.end();
      if (!outcome) {
        outcome = interrupted(baseOutcome(saved, trace, "interrupted"));
        unconfirmedLinks(trace, outcome);
      }
      const { clean, reconciled } = await cleanUp(saved, owned, trace, outcome, (final ?? pending)?.reconciled ?? false, { record });
      if (outcome.status === "completed" && outcome.problems.length) outcome.status = "failed";
      await rememberOutcome(saved, outcome, reconciled);
      if (clean) {
        await rm(stateFile, { force: true });
        console.error(`Pi run ${saved.runId} was left by a restart; its processes and workspace are cleaned up.`);
      } else {
        await record().catch(() => {});
        hold(saved, `Pi run ${saved.runId} could not be cleaned up after a restart: ${outcome.problems.at(-1)}`, outcome);
      }
    } catch (error) {
      // Without its account, stop what can be proved ours but do not delete its workspace or jobs. A known
      // terminal result is still safe to deliver to Durable, independently of whether cleanup could run.
      await stopRun(owned, saved.runId, saved.pid, graceMs, undefined, record).catch(() => {});
      hold(saved, `Pi run ${saved.runId} could not be recovered after a restart (${clip(message(error), 300)}).`, outcome);
    }
  }
  await Promise.all(records.map(({ path, saved }) => {
    if (ambiguous.has(saved) || ambiguousIds.has(saved.runId)) {
      recordProblem(path, "conflicting claims to a Pi run, branch, task or process identity");
      return;
    }
    return recover(saved, path);
  }));

  let closed = false;

  async function execute(request: RunRequest, saved: SavedRun, run: ActiveRun): Promise<RunOutcome | undefined> {
    const stateFile = join(stateDir, `${saved.runId}.json`);
    const trace = new RunTrace(pi.repo);
    const problems: string[] = [];
    let code: number | null = null;
    let stderr = "";
    let launched = false;
    let term: (() => void) | undefined;

    // One writer at a time, and none once the run's record is handed over.
    let recording = true;
    let saving: Promise<unknown> = Promise.resolve();
    const write = () => saving = saving.catch(() => {}).then(async () => {
      if (!recording) return;
      await writeJson(stateFile, { ...saved, procs: [...run.owned.procs], groups: [...run.owned.groups] });
    });
    const save = () => write().catch(error => console.error(`Pi run ${saved.runId}: could not save its record:`, error));
    /** Remember a process this host started for the run, before waiting on it. */
    const adopt = async (pid: number | undefined) => {
      if (pid === undefined) return;
      const own = (await listProcesses().catch(() => [])).find(proc => proc.pid === pid);
      if (own) remember(run.owned, [own]);
      await save();
    };
    /** The children this host started itself and still holds: stopped through their handles when all else fails. */
    const held = new Set<ChildProcess>();
    let stopping = Promise.resolve();
    run.kill = () => {
      stopping = stopping.then(async () => {
        try {
          await stopRun(run.owned, saved.runId, saved.pid, graceMs, term, save);
        } catch (error) {
          // The process table could not be read. Kill what this host started, by handle and so by group: each
          // leads its own. What they started is left to the cleanup, which keeps the slot closed if it cannot look.
          console.error(`Pi run ${saved.runId}: could not stop its processes by scanning:`, error);
          for (const child of held) {
            if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        }
      });
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
    // pi-web-search must resolve its config from the trusted Pi agent dir, never a checkout-relative override.
    delete env.PI_WEB_SEARCH_CONFIG;
    delete env.PATTY_CLAUDE_CODE_MODEL;

    /** Run a setup command as part of the run: in its own process group, recorded, and stopped with the run. */
    const command = async (file: string, args: string[], cwd?: string): Promise<string> => {
      if (run.stop) throw new Error("the run was stopped");
      const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      held.add(child);
      child.once("close", () => held.delete(child));
      let out = "", err = "";
      let failure: Error | undefined;
      child.stdout.on("data", (chunk: Buffer) => { out = (out + chunk).slice(0, 1024 * 1024); });
      child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk).slice(-8_000); });
      const exit = exitOf(child, error => { failure = error; });
      await adopt(child.pid);
      // Stopped while it was being recorded: the stop may have missed it.
      if (run.stop) run.kill();
      const exitCode = await exit;
      if (failure) throw failure;
      if (exitCode !== 0) throw new Error(tail(err, 6) || `${file} exited with ${exitCode ?? "a signal"}`);
      return out;
    };

    try {
      await mkdir(saved.logDir, { recursive: true, mode: 0o700 });
      await mkdir(saved.workspace, { recursive: true, mode: 0o700 });
      // Nothing starts without the record a later process needs to stop it.
      await write();
      if (request.pr) {
        const problem = await reviewerProblem(pi);
        if (problem) problems.push(problem);
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
        const claude = request.model.startsWith("claude-code/") ? request.model.slice("claude-code/".length) : undefined;
        const child = spawn(pi.node, [
          pi.cli, "--mode", "json", "--no-session", "--model", claude ?? request.model, "--thinking", request.thinking,
          // Only pinned release extensions, never resources or executable settings discovered in the checkout.
          "--no-approve", "--no-extensions", "-e", pi.extension, "-e", pi.webFetchExtension, "-e", pi.webSearchExtension,
          "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--append-system-prompt", rules,
          ...(claude === undefined ? [] : ["--provider", "claude-code", "-e", pi.claudeCodeExtension]),
        ], { cwd: repo, env: claude === undefined ? env : {
          ...env, PATTY_CLAUDE_CODE_MODEL: claude, PATH: env.PATH?.split(delimiter).filter(isAbsolute).join(delimiter) || "/usr/bin:/bin",
        }, stdio: ["pipe", "pipe", "pipe"], detached: true });
        launched = true;
        held.add(child);
        child.once("close", () => held.delete(child));
        term = () => { child.kill("SIGTERM"); };
        const exited = exitOf(child, error => { problems.push(`Could not start Pi: ${error.message}`); });
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
        const split = lineSplitter((line, whole) => {
          trace.line(line, whole);
          if (whole && !repeated(line)) keepEvent(line + "\n");
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
    await saving.catch(() => {});

    // A stopped host leaves the workspace, the saved run and the result to the next start.
    if (run.stop === "shutdown") {
      await stopRun(run.owned, saved.runId, saved.pid, 0, term, save).catch(() => {});
      await save();
      return undefined;
    }
    // From here the run ends as it ended: a later abort or shutdown gets this outcome.
    run.finalizing = true;

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
      if (outcome.status === "aborted" || !launched) {
        // An abort answers quickly: report what the run printed without asking GitHub.
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
    const { clean, reconciled } = await cleanUp(saved, run.owned, trace, outcome, false, { term, record: save });
    // `completed` only when everything the host checked holds.
    if (outcome.status === "completed" && outcome.problems.length) outcome.status = "failed";
    outcome.problems = outcome.problems.slice(0, maxItems);
    outcome.durationMs = Math.max(0, Date.now() - Date.parse(saved.startedAt));
    // Saved by call before the run's record goes: the harness may not have committed the result when this process dies.
    // The outcome is settled now. Whatever fails from here holds this branch, and still returns the outcome.
    let handed = clean;
    try {
      await rememberOutcome(saved, outcome, reconciled);
      // The record's last state has everything the cleanup learned, for the next start if this one was not clean.
      await write();
      if (clean) await rm(stateFile, { force: true });
    } catch (error) {
      handed = false;
      outcome.problems.push(`The run's record could not be closed: ${clip(message(error), 300)}`);
      if (outcome.status === "completed") outcome.status = "failed";
      await rememberOutcome(saved, outcome, reconciled).catch(() => {});
    } finally {
      recording = false;
    }
    if (!handed) hold(saved, `Pi run ${saved.runId} could not be cleaned up: ${outcome.problems.at(-1)}`, outcome);
    return outcome;
  }

  return {
    hasActive: () => active.size > 0,
    snapshot: runId => readPiRunSnapshot(config.dataDir, pi.repo, runId, () => {
      const run = [...active.values()].find(run => run.saved.runId === runId);
      return run ? Date.parse(run.saved.startedAt) : undefined;
    }),
    async run(request, signal, onStart) {
      if (closed) throw new Error("aipatty is shutting down");
      const branch = request.conversationId;
      const current = active.get(branch);
      if (current) throw new Error(`Pi run ${current.saved.runId} is still active on branch ${branch}. Wait for it, or abort this branch.`);
      if (ownershipProblem) throw new Error(ownershipProblem);
      const held = heldBranches.get(branch);
      if (held) throw new Error(held.reason);
      signal?.throwIfAborted();
      const runId = `${new Date().toISOString().replace(/[-:]|\.\d+Z$/g, "")}-${randomUUID().slice(0, 8)}`;
      const saved: SavedRun = {
        runId, conversationId: request.conversationId, taskId: request.taskId, pr: request.pr,
        startedAt: new Date().toISOString(), workspace: join(config.runsDir, runId), logDir: join(logRoot, runId),
        procs: [], groups: [], asOf: 0,
      };
      const run: ActiveRun = { saved, owned: newOwned(), finalizing: false, kill: () => {}, done: Promise.resolve(undefined) };
      // Reserve before execute can yield, including when two tool calls arrive in one model batch.
      active.set(branch, run);
      const onAbort = () => {
        if (run.finalizing) return;
        run.stop ??= "aborted";
        run.kill();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      run.done = execute(request, saved, run).catch(error => {
        // Keep its record, and hold this branch, for the next start.
        hold(saved, `Pi run ${runId} failed in the host and was not cleaned up (${clip(message(error), 300)}).`);
        throw error;
      }).finally(() => {
        signal?.removeEventListener("abort", onAbort);
        active.delete(branch);
      });
      onStart?.(runId);
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
    async settled(taskId, conversationId) {
      const run = conversationId === undefined ? [...active.values()].find(run => run.saved.taskId === taskId)
        : active.get(conversationId);
      if (run?.saved.taskId === taskId) {
        if (!run.finalizing && !run.stop) {
          run.stop = "aborted";
          run.kill();
        }
        const outcome = await run.done.catch(() => undefined);
        if (outcome) return outcome;
      }
      return settledOutcome(taskId, conversationId);
    },
    async close() {
      closed = true;
      const runs = [...active.values()];
      for (const run of runs) {
        if (run.finalizing || run.stop) continue;
        run.stop = "shutdown";
        run.kill();
      }
      await Promise.allSettled(runs.map(run => run.done));
    },
  };
}

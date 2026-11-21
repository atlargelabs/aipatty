import type { Usage } from "@earendil-works/pi-ai";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { instructions, taskPrompt } from "./pi-prompt.ts";
import { githubLink, readReport, RunTrace, type Review } from "./pi-trace.ts";
import { runProcesses, RUN_MARKER, stopRun, type Seen } from "./processes.ts";

const exec = promisify(execFile);

/** How a run ended. Only `completed` means Pi finished and, when a PR was asked for, GitHub has that PR. */
export type RunStatus = "completed" | "failed" | "aborted" | "timed_out" | "interrupted";

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  summary: string;
  /** Confirmed with `gh`, unless `confirmed` is false: then it is only a link the run printed. */
  pr?: { url: string; number: number; headSha?: string; state?: string; confirmed: boolean };
  issue?: { url: string; confirmed: boolean };
  /**
   * `clean` only when the last finished review covered the PR's head commit, gave the verdict "correct", and had no
   * P0 or P1 finding. `none` when no PR was asked for.
   */
  review: {
    status: "clean" | "missing" | "findings" | "stale" | "unverified" | "none";
    verdict?: Review["verdict"];
    sha?: string;
    important: number;
    lesser: number;
  };
  usage: Usage;
  /** False when a delegate or the run itself was cut off before it reported its spend. */
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
  pid?: number;
  seen: [number, string][];
}

interface ActiveRun {
  saved: SavedRun;
  seen: Seen;
  /** Why the run is being stopped early, once it is. */
  stop?: "aborted" | "timed_out" | "shutdown";
  kill(): void;
  done: Promise<RunOutcome | undefined>;
}

const maxSummary = 6_000;
const maxItems = 20;
const maxItem = 600;
const defaultPollMs = 2_000;
const interruptedKept = 50;

function callKey(conversationId: number, callId: string): string {
  return `${conversationId}:${callId}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

function tail(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
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

function reviewOf(trace: RunTrace, headSha: string | undefined, pr: boolean): RunOutcome["review"] {
  if (!pr) return { status: "none", important: 0, lesser: 0 };
  const last = trace.reviews.findLast(review => review.finished);
  if (!last) return { status: "missing", important: 0, lesser: 0 };
  const { verdict, sha, important, lesser } = last;
  const status = verdict !== "correct" || important > 0 ? "findings"
    : headSha === undefined ? "unverified"
    : sha !== headSha ? "stale" : "clean";
  return { status, verdict, sha, important, lesser };
}

const reviewText: Record<RunOutcome["review"]["status"], string> = {
  clean: "reviewed",
  missing: "NOT REVIEWED: no crmanager review finished",
  findings: "NOT REVIEWED CLEAN: the last review has important findings or no clear \"correct\" verdict",
  stale: "NOT REVIEWED: the last review covered a different commit from the PR head",
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
  lines.push(`Cost: ${money(outcome.usage.cost.total)}${outcome.usageComplete ? "" : " (incomplete: some spend was not reported)"}, charged to this branch`);
  if (outcome.problems.length) lines.push("Problems found by the host:", ...outcome.problems.map(item => `- ${item}`));
  if (outcome.remaining.length) lines.push("Remaining, as Pi reported:", ...outcome.remaining.map(item => `- ${item}`));
  lines.push(`Logs: ${outcome.logDir}`);
  return lines.join("\n");
}

export interface PiRuns {
  /** The branch and ID of the run in progress. */
  active(): { runId: string; conversationId: number } | undefined;
  /** Run Pi once. Rejects at once when another run is active; otherwise resolves when the run is over and cleaned up. */
  run(request: RunRequest, signal?: AbortSignal): Promise<RunOutcome>;
  /**
   * The outcome of a call that the harness ended itself: aborted, or interrupted by a restart. Waits for the run's
   * processes to be stopped and its workspace removed.
   */
  settled(conversationId: number, callId: string): Promise<RunOutcome | undefined>;
  /** Stop the active run's processes and leave its cleanup and its result to the next start. */
  close(): Promise<void>;
}

/** Open the run slot: first stop and clean up a run that a previous process left behind. */
export async function openPiRuns(config: Config): Promise<PiRuns> {
  const pollMs = config.pi.pollMs ?? defaultPollMs;
  const { pi } = config;
  const stateFile = join(config.dataDir, "pi-run.json");
  const interruptedFile = join(config.dataDir, "pi-interrupted.json");
  const logRoot = join(config.dataDir, "logs", "runs");
  const jobsDir = join(pi.agentDir, "delegates", "jobs");
  await mkdir(logRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.runsDir, { recursive: true, mode: 0o700 });

  const inside = (parent: string, child: string) => resolve(child).startsWith(resolve(parent) + sep);

  /**
   * Keep the logs of the delegate jobs a run started, then delete their clones, which the extension leaves in the
   * agent directory. A job belongs to the run when it carries the run's session ID or was cloned from its workspace.
   */
  async function collectJobs(saved: SavedRun, sessionId: string | undefined): Promise<void> {
    const ids = await readdir(jobsDir).catch(() => [] as string[]);
    const jobs = new Map<string, { ownerSession?: string; source?: string }>();
    for (const id of ids) {
      const job = await readJson<{ ownerSession?: string; workspace?: { source?: string } }>(join(jobsDir, id, "job.json"));
      if (job) jobs.set(id, { ownerSession: job.ownerSession, source: job.workspace?.source });
    }
    const ours = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, job] of jobs) {
        if (ours.has(id)) continue;
        const source = job.source;
        const fromRun = source !== undefined && (resolve(source) === resolve(saved.workspace) || inside(saved.workspace, source)
          || [...ours].some(parent => inside(join(jobsDir, parent), source)));
        if ((sessionId !== undefined && job.ownerSession === sessionId) || fromRun) {
          ours.add(id);
          grew = true;
        }
      }
    }
    for (const id of ours) {
      const dir = join(jobsDir, id);
      const clone = join(dir, "workspace");
      await cp(dir, join(saved.logDir, "delegates", id), {
        recursive: true, filter: source => source !== clone && !inside(clone, source),
      }).catch(error => console.error(`Pi run ${saved.runId}: could not keep the logs of delegate ${id}:`, error));
      const stat = await lstat(clone).catch(() => undefined);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) await rm(clone, { recursive: true, force: true });
      await rm(join(dir, "lease.json"), { force: true });
      await writeFile(join(dir, "discarded"), new Date().toISOString(), { mode: 0o600 }).catch(() => {});
    }
  }

  /** Stop what is left of a run, keep its logs, and delete its workspace and its delegates' clones. */
  async function cleanUp(saved: SavedRun, seen: Seen, sessionId: string | undefined, problems: string[]): Promise<void> {
    const left = await stopRun(seen, saved.runId, saved.pid, 5_000);
    if (left.length) problems.push(`${left.length} process(es) of the run could not be stopped: ${left.map(proc => proc.pid).join(", ")}`);
    await collectJobs(saved, sessionId);
    await rm(saved.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }

  const gh = async (args: string[]): Promise<unknown> => {
    const { stdout } = await exec(pi.gh, args, { cwd: config.dataDir, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  };

  /** Check the PR and issue with GitHub. A URL in the model's output is not proof of either. */
  async function confirm(trace: RunTrace, outcome: RunOutcome, reported: { pr?: string; issue?: string }): Promise<void> {
    const prUrl = trace.prLinks.at(-1) ?? reported.pr;
    const prLink = prUrl ? githubLink(prUrl, pi.repo) : undefined;
    let body = "";
    if (prUrl && prLink?.kind !== "pull") {
      outcome.problems.push(`The reported PR link is not a PR of ${pi.repo}: ${clip(prUrl, 200)}`);
    } else if (prLink) {
      outcome.pr = { url: prLink.url, number: prLink.number, confirmed: false };
      try {
        const pr = await gh(["pr", "view", String(prLink.number), "--repo", pi.repo, "--json", "number,url,state,headRefOid,baseRefName,body"]) as {
          state?: string; headRefOid?: string; baseRefName?: string; body?: string;
        };
        if (typeof pr.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(pr.headRefOid)) throw new Error("no head commit in gh's answer");
        outcome.pr = { ...outcome.pr, headSha: pr.headRefOid, state: pr.state ?? "UNKNOWN", confirmed: true };
        body = pr.body ?? "";
        if (pr.state !== "OPEN") outcome.problems.push(`The PR is ${pr.state?.toLowerCase()}, not open.`);
        if (pr.baseRefName !== "main") outcome.problems.push(`The PR targets ${pr.baseRefName}, not main.`);
      } catch (error) {
        outcome.problems.push(`The PR could not be confirmed with gh: ${clip(error instanceof Error ? error.message : String(error), 300)}`);
      }
    }
    const issueUrl = reported.issue ?? trace.issueLinks.at(-1);
    const issueLink = issueUrl ? githubLink(issueUrl, pi.repo) : undefined;
    if (issueUrl && issueLink?.kind !== "issues") {
      outcome.problems.push(`The reported issue link is not an issue of ${pi.repo}: ${clip(issueUrl, 200)}`);
    } else if (issueLink) {
      outcome.issue = { url: issueLink.url, confirmed: false };
      try {
        await gh(["issue", "view", String(issueLink.number), "--repo", pi.repo, "--json", "number,state"]);
        outcome.issue.confirmed = true;
        if (outcome.pr?.confirmed && !new RegExp(`#${issueLink.number}\\b`).test(body)) {
          outcome.problems.push(`The PR body does not link issue #${issueLink.number}.`);
        }
      } catch (error) {
        outcome.problems.push(`The issue could not be confirmed with gh: ${clip(error instanceof Error ? error.message : String(error), 300)}`);
      }
    }
  }

  /** The part of an outcome that the event stream alone decides. */
  function baseOutcome(saved: SavedRun, trace: RunTrace, status: RunStatus): RunOutcome {
    return {
      runId: saved.runId, status, summary: "",
      review: reviewOf(trace, undefined, saved.pr),
      usage: trace.usage,
      usageComplete: status === "completed" && trace.unfinishedDelegates === 0,
      remaining: [], problems: [], logDir: saved.logDir,
    };
  }

  /** Links the run printed, for a run that ended without the host asking GitHub. */
  function unconfirmedLinks(trace: RunTrace, outcome: RunOutcome): void {
    const pr = trace.prLinks.at(-1) && githubLink(trace.prLinks.at(-1)!, pi.repo);
    if (pr) outcome.pr = { url: pr.url, number: pr.number, confirmed: false };
    const issue = trace.issueLinks.at(-1);
    if (issue) outcome.issue = { url: issue, confirmed: false };
  }

  // A run the previous process left: its call is reported `interrupted` and never run again.
  const interrupted = new Map<string, RunOutcome>(Object.entries(await readJson<Record<string, RunOutcome>>(interruptedFile) ?? {}));
  const left = await readJson<SavedRun>(stateFile);
  if (left) {
    const trace = new RunTrace(pi.repo);
    const split = lineSplitter(line => trace.line(line));
    split.write(await readFile(join(left.logDir, "events.jsonl")).catch(() => Buffer.alloc(0)));
    split.end();
    const outcome = baseOutcome(left, trace, "interrupted");
    outcome.summary = "aipatty stopped while this run was in progress. The run was stopped and is not run again; "
      + "it may have partially run. Check GitHub for what it published before starting another.";
    outcome.usageComplete = false;
    unconfirmedLinks(trace, outcome);
    await cleanUp(left, new Map(left.seen), trace.sessionId, outcome.problems);
    await writeJson(join(left.logDir, "result.json"), outcome).catch(() => {});
    interrupted.set(callKey(left.conversationId, left.callId), outcome);
    for (const key of [...interrupted.keys()].slice(0, Math.max(0, interrupted.size - interruptedKept))) interrupted.delete(key);
    await writeJson(interruptedFile, Object.fromEntries(interrupted));
    await rm(stateFile, { force: true });
    console.error(`Pi run ${left.runId} was interrupted by a restart; its processes and workspace are cleaned up.`);
  }

  let active: ActiveRun | undefined;
  let closed = false;
  /** The newest outcomes by call, for a call the harness ended while its run was finishing. */
  const finished = new Map<string, RunOutcome>();

  async function execute(request: RunRequest, saved: SavedRun, run: ActiveRun, signal: AbortSignal | undefined): Promise<RunOutcome | undefined> {
    const trace = new RunTrace(pi.repo);
    const problems: string[] = [];
    let code: number | null = null;
    let stderr = "";
    let baseSha = "";
    let launched = false;
    const save = () => writeJson(stateFile, { ...saved, seen: [...run.seen] });
    try {
      await mkdir(saved.logDir, { recursive: true, mode: 0o700 });
      await mkdir(saved.workspace, { recursive: true, mode: 0o700 });
      await save();
      if (request.pr) {
        // The review cannot run without pi-review, and the delegates extension only says so once a review is asked for.
        const settings = await readJson<{ delegates?: { reviewExtension?: unknown } }>(join(pi.agentDir, "settings.json"));
        const configured = settings?.delegates?.reviewExtension;
        const review = typeof configured === "string" ? configured : join(pi.agentDir, "git/github.com/earendil-works/pi-review/review.ts");
        if (!(await lstat(review).catch(() => undefined))?.isFile()) {
          problems.push(`The review extension is missing at ${review}, so no PR could be reviewed. Install pi-review there or set delegates.reviewExtension in ${join(pi.agentDir, "settings.json")}.`);
        }
      }
      const repo = join(saved.workspace, "repo");
      const git = (args: string[], cwd?: string) => exec(pi.git, args, { cwd, timeout: 300_000, maxBuffer: 16 * 1024 * 1024, signal });
      if (!problems.length) try {
        await git(["clone", "--quiet", pi.repoUrl, repo]);
        if (request.base !== "main") await git(["checkout", "--quiet", request.base], repo);
        baseSha = (await git(["rev-parse", "--verify", "HEAD"], repo)).stdout.trim();
      } catch (error) {
        if (!run.stop) problems.push(`Could not clone ${pi.repo} at ${request.base}: ${clip(error instanceof Error ? error.message : String(error), 600)}`);
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
        const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: pi.agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", [RUN_MARKER]: saved.runId };
        // The server's own setting must not reach the checkout's tests, which refuse a stray AIPATTY_ variable.
        for (const name of Object.keys(env)) if (name.startsWith("AIPATTY_")) delete env[name];
        const child = spawn(pi.node, [
          pi.cli, "--mode", "json", "--no-session", "--model", request.model, "--thinking", request.thinking,
          // Nothing from the checkout or the agent directory loads by itself: only the pinned delegates extension.
          "--no-approve", "--no-extensions", "-e", pi.extension, "--no-skills", "--no-prompt-templates", "--no-themes",
          "--no-context-files", "--no-mcp", "--append-system-prompt", rules,
        ], { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
        launched = true;
        const exited = new Promise<number | null>(resolveExit => {
          child.once("error", error => {
            problems.push(`Could not start Pi: ${error.message}`);
            resolveExit(null);
          });
          child.once("close", resolveExit);
        });
        if (child.pid !== undefined) {
          saved.pid = child.pid;
          for (const proc of await runProcesses(new Map(), saved.runId).catch(() => [])) run.seen.set(proc.pid, proc.start);
          await save();
        }
        const split = lineSplitter(line => {
          trace.line(line);
          if (retained(line)) events.write(line + "\n");
        });
        child.stdout.on("data", (chunk: Buffer) => split.write(chunk));
        child.stderr.on("data", (chunk: Buffer) => {
          errors.write(chunk);
          stderr = (stderr + chunk.toString()).slice(-8_000);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(prompt);
        // Remember the processes the run starts while their parents still live: a delegate leads its own group.
        let polling = false;
        const poll = setInterval(() => {
          if (polling) return;
          polling = true;
          void runProcesses(run.seen, saved.runId).then(async procs => {
            const before = run.seen.size;
            for (const proc of procs) run.seen.set(proc.pid, proc.start);
            if (run.seen.size !== before) await save();
          }).catch(() => {}).finally(() => { polling = false; });
        }, pollMs);
        const timer = setTimeout(() => {
          run.stop ??= "timed_out";
          run.kill();
        }, request.timeoutMs);
        let stopping: Promise<unknown> | undefined;
        run.kill = () => { stopping ??= stopRun(run.seen, saved.runId, child.pid, 5_000).catch(() => {}); };
        if (run.stop) run.kill();
        code = await exited;
        clearInterval(poll);
        clearTimeout(timer);
        await stopping;
        split.end();
        const flushed = (stream: WriteStream) => new Promise<void>(done => stream.end(done));
        await Promise.all([flushed(events), flushed(errors)]);
      }
    } catch (error) {
      problems.push(`The run failed in the host: ${clip(error instanceof Error ? error.message : String(error), 600)}`);
    }
    // A stopped host leaves the workspace, the saved run and the result to the next start.
    if (run.stop === "shutdown") {
      await stopRun(run.seen, saved.runId, saved.pid, 0).catch(() => {});
      return undefined;
    }

    const ok = launched && code === 0 && trace.settled && !trace.aborted && trace.lastStop === "stop" && trace.malformed === 0;
    const status: RunStatus = run.stop ?? (ok ? "completed" : "failed");
    const outcome = baseOutcome(saved, trace, status);
    outcome.problems.push(...problems);
    if (status === "aborted") outcome.summary = "The run was aborted. It may have partially run.";
    if (status === "timed_out") outcome.summary = `The run was stopped after ${Math.round(request.timeoutMs / 60_000)} minutes. It may have partially run.`;
    if (launched && status === "failed" && !problems.length) {
      if (trace.events === 0) outcome.problems.push("Pi produced no event stream.");
      if (trace.malformed) outcome.problems.push(`Pi's output had ${trace.malformed} line(s) that were not JSON events; the result is not trusted.`);
      if (code !== 0) outcome.problems.push(`Pi exited with ${code === null ? "a signal" : `code ${code}`}.`);
      else if (!trace.settled) outcome.problems.push("Pi exited before it reported the run as settled.");
      else if (trace.lastStop !== "stop") outcome.problems.push(`Pi's last message ended with "${trace.lastStop}"${trace.lastError ? `: ${clip(trace.lastError, 400)}` : ""}.`);
      if (stderr.trim()) outcome.problems.push(`Pi's last error output: ${clip(tail(stderr, 8), 1_200)}`);
    }
    const report = readReport(trace.lastText);
    if (status === "completed" || status === "failed") {
      if (report) {
        outcome.summary = clip(report.summary, maxSummary);
        outcome.remaining = report.remaining.slice(0, maxItems).map(item => clip(item, maxItem));
      } else if (launched) {
        outcome.summary = clip(trace.lastText.trim(), maxSummary);
        if (status === "completed") outcome.problems.push("Pi's last message has no <result> block; its summary is its raw text.");
      }
    }
    if (status === "aborted") {
      // An abort answers quickly: report what the run printed without asking GitHub.
      unconfirmedLinks(trace, outcome);
    } else if (request.pr) {
      await confirm(trace, outcome, { pr: report?.pr, issue: report?.issue });
      outcome.review = reviewOf(trace, outcome.pr?.confirmed ? outcome.pr.headSha : undefined, true);
      if (!outcome.pr?.confirmed) {
        if (!outcome.pr) outcome.problems.push("No PR was found, though one was requested.");
        if (outcome.status === "completed") outcome.status = "failed";
      }
      if (outcome.status === "completed" && !outcome.issue?.confirmed) outcome.problems.push("No issue was confirmed for this change.");
    }
    if (trace.unfinishedDelegates) outcome.problems.push(`${trace.unfinishedDelegates} delegate call(s) never reported: their spend is not included.`);
    await cleanUp(saved, run.seen, trace.sessionId, outcome.problems);
    outcome.problems = outcome.problems.slice(0, maxItems);
    await writeJson(join(saved.logDir, "result.json"), outcome).catch(() => {});
    await rm(stateFile, { force: true });
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
      signal?.throwIfAborted();
      const runId = `${new Date().toISOString().replace(/[-:]|\.\d+Z$/g, "")}-${randomUUID().slice(0, 8)}`;
      const saved: SavedRun = {
        runId, conversationId: request.conversationId, callId: request.callId, pr: request.pr,
        startedAt: new Date().toISOString(), workspace: join(config.runsDir, runId), logDir: join(logRoot, runId), seen: [],
      };
      const run: ActiveRun = { saved, seen: new Map(), kill: () => {}, done: Promise.resolve(undefined) };
      active = run;
      const onAbort = () => {
        run.stop ??= "aborted";
        run.kill();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      run.done = execute(request, saved, run, signal).finally(() => {
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
      finished.set(callKey(request.conversationId, request.callId), outcome);
      for (const key of [...finished.keys()].slice(0, Math.max(0, finished.size - interruptedKept))) finished.delete(key);
      return outcome;
    },
    async settled(conversationId, callId) {
      const key = callKey(conversationId, callId);
      if (active && callKey(active.saved.conversationId, active.saved.callId) === key) {
        active.stop ??= "aborted";
        active.kill();
        return await active.done.catch(() => undefined);
      }
      return finished.get(key) ?? interrupted.get(key);
    },
    async close() {
      closed = true;
      if (!active) return;
      active.stop = "shutdown";
      active.kill();
      await active.done.catch(() => {});
    },
  };
}

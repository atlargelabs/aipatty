import type { Usage } from "@earendil-works/pi-ai";

/** A review by a `crmanager` delegate, as its result reported it. */
export interface Review {
  /** The first line of the delegate's task, such as `/review pr 12`. */
  request: string;
  /** The PR the delegate was asked to review, when the request names one of this repository by number or URL. */
  pr?: number;
  /** Whether the delegate's clone was of this repository, so that a PR number means this repository's PR. */
  ownRepo: boolean;
  /** Whether the delegate finished; a failed review has no verdict. */
  finished: boolean;
  /** The commit the delegate reviewed, when it reviewed one. */
  sha?: string;
  verdict: "correct" | "needs attention" | "unknown";
  /** Findings tagged P0 or P1. */
  important: number;
  /** Findings tagged P2 or P3. */
  lesser: number;
}

/** A delegate job's spend as the extension reports it: token counts and one cost figure. */
export interface JobUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

/** What Pi's last message says it did. Claims, until checked against GitHub. */
export interface Report {
  summary: string;
  issue?: string;
  pr?: string;
  remaining: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function emptyUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Add Pi's usage, or a delegate job's, to `total`. */
export function addUsage(total: Usage, usage: unknown): void {
  if (!record(usage)) return;
  const input = number(usage.input), output = number(usage.output);
  const cacheRead = number(usage.cacheRead), cacheWrite = number(usage.cacheWrite);
  total.input += input;
  total.output += output;
  total.cacheRead += cacheRead;
  total.cacheWrite += cacheWrite;
  total.totalTokens += input + output + cacheRead + cacheWrite;
  // Pi reports a cost breakdown; the delegates extension reports one number.
  if (record(usage.cost)) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      total.cost[key] += number(usage.cost[key]);
    }
  } else {
    total.cost.total += number(usage.cost);
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => record(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("");
}

/**
 * Read a review's findings and verdict from the reviewer's text, in the format pi-review asks for. A verdict is
 * declared by a line that opens with it, as in `**Verdict: correct.**`, or by a `Verdict` heading and the line
 * under it. The value must be exactly one of the two verdicts, not a sentence that starts with the word. Quoted
 * lines and fenced examples are not the reviewer's own. Any declared "needs attention" wins; a declaration that
 * cannot be read, or none at all, is `unknown`.
 */
export function readReview(summary: string): Pick<Review, "verdict" | "important" | "lesser"> {
  const important = summary.match(/\[P[01]\]/g)?.length ?? 0;
  const lesser = summary.match(/\[P[23]\]/g)?.length ?? 0;
  const lines: string[] = [];
  let fenced = false;
  for (const line of summary.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && !/^\s*>/.test(line)) lines.push(line.replace(/^[\s#*_-]+/, ""));
  }
  const values = new Set<string>();
  lines.forEach((line, index) => {
    const opened = /^(?:the\s+)?(?:overall\s+|final\s+)?verdict\b(?:\s+is\b)?[\s:*_"'`“”–—-]*/i.exec(line);
    if (!opened) return;
    // A heading of its own is declared by the next line that has text.
    const rest = line.slice(opened[0].length) || (lines.slice(index + 1).find(next => next.trim()) ?? "").replace(/^[\s:*_"'`“”–—-]+/, "");
    // "needs attention" anywhere in the declaration is that; "correct" must be the whole value.
    values.add(/needs[ _-]attention/i.test(rest) ? "needs attention"
      : /^correct(?=\s*$|\s*[^\w\s])/i.test(rest) ? "correct" : "unknown");
  });
  const verdict = values.has("needs attention") ? "needs attention"
    : values.has("unknown") || !values.has("correct") ? "unknown" : "correct";
  return { verdict, important, lesser };
}

/** `owner/name` of a GitHub remote, from its SSH or HTTPS URL. */
export function remoteRepo(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  return /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

/** A job's usage as one comparable value. */
export function usageKey(usage: unknown): string {
  const value = record(usage) ? usage : {};
  return [value.input, value.output, value.cacheRead, value.cacheWrite, value.cost].map(number).join("/");
}

/** The `<result>` block Pi is asked to end with. */
export function readReport(text: string): Report | undefined {
  const blocks = [...text.matchAll(/<result>\s*([\s\S]*?)\s*<\/result>/g)];
  const body = blocks.at(-1)?.[1].replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (body === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!record(value) || typeof value.summary !== "string") return undefined;
  const url = (field: unknown) => typeof field === "string" && field.trim() ? field.trim() : undefined;
  return {
    summary: value.summary,
    issue: url(value.issue),
    pr: url(value.pr),
    remaining: Array.isArray(value.remaining) ? value.remaining.filter(item => typeof item === "string") : [],
  };
}

const delegateTools = new Set(["delegate", "delegate_parallel"]);

/**
 * Folds Pi's JSON event stream into what the host reports: spend, reviews, links, and how the run ended. It reads
 * only what the CLI and the delegates extension emitted themselves, never the model's account of it, except for
 * `report`, which the host then checks.
 */
export class RunTrace {
  /** The session ID; the delegates extension records it on every job the run starts. */
  sessionId: string | undefined;
  /** Pi's own model calls and its delegates', each counted once. */
  readonly usage = emptyUsage();
  /** Delegate jobs whose results were seen, each with the usage its newest result reported. */
  readonly countedJobs = new Map<string, string>();
  /** Jobs that a call which ended without a result was continuing. */
  private readonly lostContinuations = new Set<string>();
  /** Records too long to keep, of a kind the host reads. */
  oversized = 0;
  /** Delegate calls that ended without a result to account for. */
  unaccountedDelegates = 0;
  readonly reviews: Review[] = [];
  /** PRs a `prmanager` delegate published or `gh pr create` printed, oldest first. */
  readonly prLinks: string[] = [];
  /** Issues `gh issue create` printed, oldest first. */
  readonly issueLinks: string[] = [];
  /** Lines that were not JSON objects. */
  malformed = 0;
  events = 0;
  settled = false;
  aborted = false;
  /** The last assistant message. */
  lastText = "";
  lastStop: string | undefined;
  lastError: string | undefined;
  private readonly pending = new Map<string, { tool: string; args: unknown }>();
  private readonly repo: string;

  constructor(repo: string) {
    this.repo = repo;
  }

  /** Delegate calls that started and never reported: their spend is known only from the jobs they left. */
  get unfinishedDelegates(): number {
    return [...this.pending.values()].filter(call => delegateTools.has(call.tool)).length;
  }

  /**
   * Jobs that a call was continuing when it was cut off or ended without a result: their newest result does not
   * cover that work.
   */
  get continuing(): Set<string> {
    const ids = new Set(this.lostContinuations);
    for (const call of this.pending.values()) {
      if (!delegateTools.has(call.tool) || !record(call.args)) continue;
      for (const task of Array.isArray(call.args.tasks) ? call.args.tasks : [call.args]) {
        if (record(task) && typeof task.continue === "string") ids.add(task.continue);
      }
    }
    return ids;
  }

  /** One line of the stream. `whole` is false for a record that was too long to keep. */
  line(line: string, whole = true): void {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!text.trim()) return;
    if (!whole) {
      // The CLI's copies of a whole turn or conversation are not read. Anything else that long is a loss.
      if (/^\{"type":"(agent_end|turn_end|message_update|tool_execution_update)"/.test(text)) this.events++;
      else this.oversized++;
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      this.malformed++;
      return;
    }
    if (!record(event) || typeof event.type !== "string") {
      this.malformed++;
      return;
    }
    this.events++;
    this.event(event);
  }

  private event(event: Record<string, unknown>): void {
    switch (event.type) {
      case "session":
        if (typeof event.id === "string") this.sessionId = event.id;
        return;
      case "message_end": {
        const message = event.message;
        if (!record(message) || message.role !== "assistant") return;
        addUsage(this.usage, message.usage);
        this.lastText = contentText(message.content);
        this.lastStop = typeof message.stopReason === "string" ? message.stopReason : undefined;
        this.lastError = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
        return;
      }
      case "compaction_end":
        if (record(event.result)) addUsage(this.usage, event.result.usage);
        return;
      case "tool_execution_start":
        if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
          this.pending.set(event.toolCallId, { tool: event.toolName, args: event.args });
        }
        return;
      case "tool_execution_end": {
        if (typeof event.toolCallId !== "string") return;
        const call = this.pending.get(event.toolCallId);
        this.pending.delete(event.toolCallId);
        if (!call || !record(event.result)) return;
        if (delegateTools.has(call.tool)) {
          this.delegates(call.args, event.result);
        } else {
          // Model work another tool did itself.
          addUsage(this.usage, event.result.usage);
          if (call.tool === "bash") this.shell(call.args, event.result);
        }
        return;
      }
      case "agent_settled":
        this.settled = true;
        this.aborted = event.aborted === true;
        return;
    }
  }

  private delegates(args: unknown, result: Record<string, unknown>): void {
    const reported = record(result.details) ? result.details.delegateResult : undefined;
    const results = Array.isArray(reported) ? reported : [reported];
    const tasks = record(args) && Array.isArray(args.tasks) ? args.tasks : [args];
    let accounted = 0;
    tasks.forEach((task, index) => {
      const job = results[index];
      if (record(job) && typeof job.id === "string") return;
      if (record(task) && typeof task.continue === "string") this.lostContinuations.add(task.continue);
    });
    results.forEach((job, index) => {
      if (!record(job) || typeof job.id !== "string") return;
      accounted++;
      // Each call reports the work of that call: a continued job reports again under the same ID, with new spend.
      this.countedJobs.set(job.id, usageKey(job.usage));
      this.lostContinuations.delete(job.id);
      // A job's usage already includes the delegates it started itself.
      addUsage(this.usage, job.usage);
      if (record(job.delivery) && typeof job.delivery.prUrl === "string") this.link(job.delivery.prUrl);
      if (job.profile !== "crmanager") return;
      const task = tasks[index];
      const request = record(task) && typeof task.task === "string" ? task.task.trim().split(/\r?\n/)[0] : "";
      const asked = /^\/review (commit|branch|pr) (\S+)$/.exec(request);
      const finished = job.success === true;
      const sha = record(job.workspace) && typeof job.workspace.baseSha === "string" ? job.workspace.baseSha : undefined;
      const summary = typeof job.summary === "string" ? job.summary : "";
      this.reviews.push({
        request, finished,
        ownRepo: remoteRepo(record(job.workspace) ? job.workspace.remoteUrl : undefined)?.toLowerCase() === this.repo.toLowerCase(),
        pr: asked?.[1] !== "pr" ? undefined
          : /^[1-9]\d*$/.test(asked[2]) ? Number(asked[2]) : githubLink(asked[2], this.repo, "pull")?.number,
        // A review of uncommitted changes names the commit it started from, not what it reviewed.
        sha: asked ? sha : undefined,
        ...(finished ? readReview(summary) : { verdict: "unknown", important: 0, lesser: 0 }),
      });
    });
    // A call that ended with no result, or fewer than it was asked for, spent something nobody reported.
    if (accounted < tasks.length) this.unaccountedDelegates += tasks.length - accounted;
  }

  private shell(args: unknown, result: Record<string, unknown>): void {
    const command = record(args) && typeof args.command === "string" ? args.command : "";
    if (!/\bgh\s+(pr|issue)\s+create\b/.test(command)) return;
    for (const url of contentText(result.content).match(/https:\/\/github\.com\/[^\s"'<>)]+/g) ?? []) this.link(url);
  }

  private link(url: string): void {
    const found = githubLink(url, this.repo);
    if (!found) return;
    const links = found.kind === "pull" ? this.prLinks : this.issueLinks;
    if (!links.includes(found.url)) links.push(found.url);
  }
}

/** A PR or issue URL of `repo`, in its canonical form; anything else, or a link of the other `kind`, is undefined. */
export function githubLink(url: string, repo: string, kind?: "pull" | "issues"): { kind: "pull" | "issues"; number: number; url: string } | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/([1-9]\d*)(?:[/?#].*)?$/.exec(url.trim());
  if (!match || match[1].toLowerCase() !== repo.toLowerCase() || (kind && match[2] !== kind)) return undefined;
  const found = match[2] as "pull" | "issues";
  return { kind: found, number: Number(match[3]), url: `https://github.com/${repo}/${found}/${match[3]}` };
}

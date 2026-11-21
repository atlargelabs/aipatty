import type { Usage } from "@earendil-works/pi-ai";

/** A review by a `crmanager` delegate, as its result reported it. */
export interface Review {
  /** The first line of the delegate's task, such as `/review pr 12`. */
  request: string;
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

function add(total: Usage, usage: unknown): void {
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

/** Read a review's findings and verdict from the reviewer's text, in the format pi-review asks for. */
export function readReview(summary: string): Pick<Review, "verdict" | "important" | "lesser"> {
  const important = summary.match(/\[P[01]\]/g)?.length ?? 0;
  const lesser = summary.match(/\[P[23]\]/g)?.length ?? 0;
  // "needs attention" anywhere wins: a verdict that cannot be read must not pass as clean.
  const verdict = /needs[ _-]attention/i.test(summary) ? "needs attention"
    : /\bcorrect\b/i.test(summary) ? "correct" : "unknown";
  return { verdict, important, lesser };
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
  /** Delegate jobs whose results, and so whose spend, were seen. */
  readonly countedJobs = new Set<string>();
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

  /** Delegate or shell calls that started and never reported: their spend, or what they published, is unknown. */
  get unfinishedDelegates(): number {
    return [...this.pending.values()].filter(call => delegateTools.has(call.tool)).length;
  }

  line(line: string): void {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!text.trim()) return;
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
        add(this.usage, message.usage);
        this.lastText = contentText(message.content);
        this.lastStop = typeof message.stopReason === "string" ? message.stopReason : undefined;
        this.lastError = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
        return;
      }
      case "compaction_end":
        if (record(event.result)) add(this.usage, event.result.usage);
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
        if (delegateTools.has(call.tool)) this.delegates(call.args, event.result);
        else if (call.tool === "bash") this.shell(call.args, event.result);
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
    results.forEach((job, index) => {
      if (!record(job) || typeof job.id !== "string" || this.countedJobs.has(job.id)) return;
      this.countedJobs.add(job.id);
      // A job's usage already includes the delegates it started itself.
      add(this.usage, job.usage);
      if (record(job.delivery) && typeof job.delivery.prUrl === "string") this.link(job.delivery.prUrl);
      if (job.profile !== "crmanager") return;
      const task = tasks[index];
      const request = record(task) && typeof task.task === "string" ? task.task.trim().split(/\r?\n/)[0] : "";
      const finished = job.success === true;
      const sha = record(job.workspace) && typeof job.workspace.baseSha === "string" ? job.workspace.baseSha : undefined;
      // A review of uncommitted changes names the commit it started from, not what it reviewed.
      const reviewed = /^\/review (commit|branch|pr) /.test(request) ? sha : undefined;
      const summary = typeof job.summary === "string" ? job.summary : "";
      this.reviews.push({
        request, finished, sha: reviewed,
        ...(finished ? readReview(summary) : { verdict: "unknown", important: 0, lesser: 0 }),
      });
    });
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

/** A PR or issue URL of `repo`, in its canonical form; anything else is undefined. */
export function githubLink(url: string, repo: string): { kind: "pull" | "issues"; number: number; url: string } | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/([1-9]\d*)(?:[/?#].*)?$/.exec(url.trim());
  if (!match || match[1].toLowerCase() !== repo.toLowerCase()) return undefined;
  const kind = match[2] as "pull" | "issues";
  return { kind, number: Number(match[3]), url: `https://github.com/${repo}/${kind}/${match[3]}` };
}

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { eventText, githubLink } from "./pi-trace.ts";
import { piRunId, runStatuses, type PiRunActivity, type PiRunSnapshot, type PiRunText } from "./protocol.ts";

export const runLogParts = ["logs", "runs"] as const;
const eventBytes = 2 * 1024 * 1024;
const resultBytes = 256 * 1024;
const stderrBytes = 12 * 1024;
const maxActivity = 24;

const absent = (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP") return undefined;
  throw error;
};

/** Follow the configured data directory, but no links below it, including the run directory itself. */
async function runDirectory(dataDir: string, runId: string): Promise<string | undefined> {
  let dir = await realpath(dataDir).catch(absent);
  if (!dir) return undefined;
  for (const part of [...runLogParts, runId]) {
    dir = join(dir, part);
    if (!(await lstat(dir).catch(absent))?.isDirectory()) return undefined;
  }
  return dir;
}

/** A bounded read of one regular log file. Never follow a spill path or wait for a pipe. */
async function readLog(dir: string, name: "events.jsonl" | "stderr.log" | "result.json", limit: number, tail: boolean) {
  const file = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(absent);
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (!tail && stat.size > limit)) return undefined;
    const size = Math.min(limit, stat.size);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, tail ? stat.size - size : 0);
    if (!tail && bytesRead !== size) return undefined;
    return { text: buffer.toString("utf8", 0, bytesRead), truncated: stat.size > size || bytesRead !== size };
  } finally {
    await file.close();
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parse(text: string | undefined) {
  try { return text === undefined ? undefined : object(JSON.parse(text)); } catch { return undefined; }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]) {
  return allowed.find(item => item === value);
}

function clip(value: unknown, limit: number): PiRunText | undefined {
  return typeof value === "string" && value.length ? { text: value.slice(0, limit), truncated: value.length > limit } : undefined;
}

function sha(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value : undefined;
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function confirmedLink(value: unknown, repo: string, kind: "pull" | "issues") {
  const link = object(value);
  const found = link?.confirmed === true && typeof link.url === "string" ? githubLink(link.url, repo, kind) : undefined;
  return found && Number.isSafeInteger(found.number) ? found.url : undefined;
}

function outcomeOf(raw: Record<string, unknown>, repo: string): NonNullable<PiRunSnapshot["result"]> {
  const pr = confirmedLink(raw.pr, repo, "pull");
  const issue = confirmedLink(raw.issue, repo, "issues");
  const review = object(raw.review);
  const status = oneOf(review?.status, ["clean", "missing", "findings", "stale", "unverified", "none"] as const);
  const list = (value: unknown) => Array.isArray(value) ? value : [];
  const problems = list(raw.problems), remaining = list(raw.remaining);
  const maxItems = 20;
  const items = (values: unknown[]) => values.slice(0, maxItems).flatMap(value => clip(value, 800) ?? []);
  return {
    summary: clip(raw.summary, 6_000),
    pr: pr ? { url: pr, headSha: sha(object(raw.pr)?.headSha) } : undefined,
    issue: issue ? { url: issue } : undefined,
    review: status ? {
      status, verdict: oneOf(review?.verdict, ["correct", "needs attention", "unknown"] as const), sha: sha(review?.sha),
      important: count(review?.important), lesser: count(review?.lesser),
    } : undefined,
    problems: items(problems), remaining: items(remaining), listsTruncated: problems.length > maxItems || remaining.length > maxItems,
  };
}

function activityOf(log: PiRunText): NonNullable<PiRunSnapshot["activity"]> {
  const lines = log.text.split("\n");
  // A writer appends complete, LF-terminated events; don't parse a window's first fragment or a torn last line.
  let incomplete = !!lines.pop();
  if (log.truncated) lines.shift();
  const items: PiRunActivity[] = [];
  let truncated = log.truncated;
  const keep = (item: PiRunActivity) => {
    items.push(item);
    if (items.length > maxActivity) {
      items.shift();
      truncated = true;
    }
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = parse(line);
    if (!event) {
      incomplete = true;
      continue;
    }
    if (event.type === "message_end") {
      const message = object(event.message);
      const output = message?.role === "assistant" ? clip(eventText(message.content), 2_000) : undefined;
      if (output) keep({ kind: "text", output });
    }
    if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") continue;
    if (typeof event.toolName !== "string" || !/^[\w.-]{1,100}$/.test(event.toolName)) continue;
    const name = event.toolName;
    if (event.type === "tool_execution_start") {
      keep({ kind: "tool", name, status: "started" });
    } else {
      const result = object(event.result);
      // Shell output is useful for following checks. Do not expose other tools' returned files, arguments or details.
      const text = name === "bash" ? eventText(result?.content) : undefined;
      // Pi can append a note with the path it spilled to; the pane does not expose or read that path.
      const body = text?.replace(/\n\n\[Showing [^\n]*\. Full output: [^\n]*\]/g, "");
      const output = clip(body, 4_000);
      const shellTruncated = name === "bash" && object(object(result?.details)?.truncation)?.truncated === true;
      if (output && (body !== text || shellTruncated)) output.truncated = true;
      keep({ kind: "tool", name, status: event.isError === true ? "error" : "finished", output });
    }
  }
  return { items, truncated, incomplete };
}

/** Inspect only the occupied slot or a run with a matching archived result, independent of the recovery cache. */
export async function readPiRunSnapshot(
  dataDir: string, repo: string, runId: string, activeSince: () => number | undefined,
): Promise<PiRunSnapshot | undefined> {
  if (!piRunId.test(runId)) return undefined;
  const startedAt = activeSince();
  const dir = await runDirectory(dataDir, runId);
  let snapshot: PiRunSnapshot;
  if (startedAt !== undefined) {
    snapshot = { runId, status: "running", durationMs: Math.max(0, Date.now() - startedAt) };
  } else {
    if (!dir) return undefined;
    const copy = parse((await readLog(dir, "result.json", resultBytes, false))?.text);
    const outcome = object(copy?.outcome);
    const status = oneOf(outcome?.status, runStatuses);
    if (!outcome || outcome.runId !== runId || !status || !count(copy?.taskId) || typeof copy?.reconciled !== "boolean") return undefined;
    snapshot = { runId, status, durationMs: count(outcome.durationMs), result: outcomeOf(outcome, repo) };
  }
  if (dir) {
    const [events, stderr] = await Promise.all([
      readLog(dir, "events.jsonl", eventBytes, true), readLog(dir, "stderr.log", stderrBytes, true),
    ]);
    if (events) snapshot.activity = activityOf(events);
    if (stderr?.text) snapshot.stderr = stderr;
  }
  return snapshot;
}

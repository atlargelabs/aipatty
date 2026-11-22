#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { on } from "node:events";
import WebSocket, { type RawData } from "ws";
import { LOOPBACK, readFaux, readPort } from "./config.ts";
import type { BranchInfo, SearchMatch } from "./branches.ts";
import { failureText, messageText, shutdownHeader, upgradeEntry, type ConversationPage, type StreamFrame } from "./protocol.ts";
import { branchLine } from "./tools.ts";
import { upgradeCommand, upgradeHeader } from "./upgrade-state.ts";

/** The conversation path of a branch ID, or the root's. */
function conversationPath(branch = "root"): string {
  if (branch !== "root" && !/^[1-9]\d*$/.test(branch)) throw new Error(`Expected a branch ID: ${branch}`);
  return `/api/conversations/${branch}`;
}

async function request<T>(base: URL, path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, base), options).catch((error: unknown) => {
    // fetch() says only "fetch failed"; its cause has the reason.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const reason = (cause as NodeJS.ErrnoException).code ?? (cause instanceof Error ? cause.message : String(cause));
    throw new Error(`Cannot reach the server at ${base.origin} (${reason}). Is it running, and is --port its port?`);
  });
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not this server's JSON: a proxy's error page, or another service on the port.
    throw new Error(response.ok ? `Expected JSON from ${response.url}` : `HTTP ${response.status} ${response.statusText}`.trim());
  }
  if (!response.ok) {
    const message = value && typeof value === "object" && "error" in value ? value.error : undefined;
    throw new Error(typeof message === "string" ? message : `HTTP ${response.status}`);
  }
  return value as T;
}

async function send(base: URL, content: string, root: string): Promise<void> {
  if (content === upgradeCommand) {
    const { upgradeId } = await request<{ upgradeId: string }>(base, `${root}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", [upgradeHeader]: "1" },
      body: JSON.stringify({ content, requestId: randomUUID() }), redirect: "error",
    });
    if (typeof upgradeId !== "string") throw new Error("This server does not support /upgrade");
    console.log(`Upgrade ${upgradeId} accepted. Use log on this branch for the result.`);
    return;
  }
  const { submissionId } = await request<{ submissionId: number }>(base, `${root}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, requestId: randomUUID() }),
  });
  const url = new URL(`${root}/stream?submissionId=${submissionId}`, base);
  url.protocol = "ws:";
  const socket = new WebSocket(url);
  let printed = "";
  const print = (text: string) => {
    if (!text.startsWith(printed)) {
      if (printed) process.stdout.write("\n");
      printed = "";
    }
    process.stdout.write(text.slice(printed.length));
    printed = text;
  };

  try {
    for await (const [data] of on(socket, "message", { close: ["close"] }) as AsyncIterable<[RawData]>) {
      const frame = JSON.parse(data.toString()) as StreamFrame;
      if (frame.type === "state" || frame.type === "update") {
        const message = frame.live.generation?.message;
        if (message && frame.live.run?.inputs.some(id => id === submissionId)) print(messageText(message));
      } else if (frame.type === "settled" && frame.submissionId === submissionId) {
        if (frame.status === "unanswered") throw new Error(`Run failed: ${failureText(frame.reason, frame.detail)}`);
        print(frame.answer);
        return;
      }
    }
    throw new Error("Stream closed before the run settled");
  } finally {
    if (printed) process.stdout.write("\n");
    socket.terminate();
  }
}

async function log(base: URL, root: string, limit?: number): Promise<void> {
  const pages: ConversationPage[] = [];
  let before: number | null = null;
  do {
    const path: string = before === null ? root : `${root}?before=${before}`;
    const page: ConversationPage = await request(base, path);
    pages.push(page);
    before = page.before;
    if (limit !== undefined && pages.reduce((n, p) => n + p.entries.length, 0) >= limit) break;
  } while (before !== null);

  let entries = pages.reverse().flatMap(page => page.entries);
  if (limit !== undefined) entries = entries.slice(-limit);
  for (const entry of entries) {
    const post = upgradeEntry(entry);
    if (post) console.log(`${limit === undefined ? "" : `[${entry.id}] `}${post.role}: ${post.text}`);
    for (const message of entry.model ?? []) {
      const text = messageText(message);
      if (text) console.log(limit === undefined ? `${message.role}: ${text}` : `[${entry.id}] ${message.role}: ${text}`);
    }
  }
}

const usage = `Usage: aipatty [--port <n>] [--branch <id>] <command>
  health | models | shutdown
  model set [provider] <modelId> | thinking set <level>
  send "<text>" | send "/upgrade" | abort | log
  branches [list] | branches read <id> [--limit <n>] | branches search <id> "<text>"
  fork "<title>" [--at <entryId>] | rename "<title>"
--branch selects the branch for model, thinking, send, abort, log, fork and rename; default the root.
--port is the server's port on this machine; default 8790.`;

/** Remove `--name <value>` from `args`, returning the value. */
function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  args.splice(index, 2);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const branch = takeOption(args, "--branch");
  const limitArg = takeOption(args, "--limit");
  const at = takeOption(args, "--at");
  const port = readPort(takeOption(args, "--port"), 1);
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
  const [command, ...rest] = args;
  const root = conversationPath(branch);
  readFaux(); // The CLI has no environment settings; this rejects a leftover or misspelt one.
  const base = new URL(`http://${LOOPBACK}:${port}`);
  const json = (path: string, method: string, body: unknown) => request(base, path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const scoped = branch !== undefined;
  if (command === "health" && rest.length === 0 && !scoped) {
    print(await request(base, "/health"));
  } else if (command === "models" && rest.length === 0 && !scoped) {
    print(await request(base, "/api/models"));
  } else if (command === "shutdown" && rest.length === 0 && !scoped && at === undefined && limitArg === undefined) {
    const ack = await request<{ status: string } | null>(base, "/api/shutdown", {
      method: "POST", headers: { [shutdownHeader]: "1" }, redirect: "manual",
    });
    if (ack?.status !== "shutdown-requested") throw new Error("Expected a shutdown acknowledgement from the server");
    console.log("Shutdown requested.");
  } else if (command === "model" && (rest.length === 2 || rest.length === 3) && rest[0] === "set") {
    const model = { provider: rest.length === 3 ? rest[1] : undefined, modelId: rest.at(-1) };
    print(await json(scoped ? `${root}/model` : "/api/model", "PUT", model));
  } else if (command === "thinking" && rest.length === 2 && rest[0] === "set") {
    print(await json(scoped ? `${root}/thinking` : "/api/thinking", "PUT", { level: rest[1] }));
  } else if (command === "abort" && rest.length === 0) {
    await request(base, `${root}/abort`, { method: "POST" });
  } else if (command === "log" && rest.length === 0) {
    await log(base, root, limit);
  } else if (command === "send" && rest.length === 1 && rest[0].trim()) {
    await send(base, rest[0], root);
  } else if (command === "fork" && rest.length === 1) {
    const branchInfo = await json(`${root}/fork`, "POST", { title: rest[0], ...(at ? { at: Number(at) } : {}) });
    print(branchInfo);
  } else if (command === "rename" && rest.length === 1) {
    print(await json(`${root}/title`, "PUT", { title: rest[0] }));
  } else if (command === "branches" && !scoped && (rest.length === 0 || (rest.length === 1 && rest[0] === "list"))) {
    const { branches, totalCost } = await request<{ branches: BranchInfo[]; totalCost: number }>(base, "/api/branches");
    for (const info of branches) console.log(branchLine(info));
    console.log(`Total spend: $${totalCost.toFixed(2)}`);
  } else if (command === "branches" && !scoped && rest.length === 2 && rest[0] === "read") {
    await log(base, conversationPath(rest[1]), limit ?? 50);
  } else if (command === "branches" && !scoped && rest.length === 3 && rest[0] === "search") {
    const query = new URLSearchParams({ q: rest[2], ...(limit ? { limit: String(limit) } : {}) });
    const { matches } = await request<{ matches: SearchMatch[] }>(base, `${conversationPath(rest[1])}/search?${query}`);
    if (!matches.length) console.log("No matches");
    for (const match of matches) console.log(`[${match.entryId}] ${match.role}: ${match.excerpt}`);
  } else {
    throw new Error(usage);
  }
}

try {
  await main();
} catch (error) {
  console.error("aipatty:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

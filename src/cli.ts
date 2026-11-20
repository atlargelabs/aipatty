#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { on } from "node:events";
import WebSocket, { type RawData } from "ws";
import { DEFAULT_URL } from "./config.ts";
import { messageText, type ConversationPage, type StreamFrame } from "./protocol.ts";

const root = "/api/conversations/root";

async function request<T>(base: URL, path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, base), options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

async function send(base: URL, content: string): Promise<void> {
  const { submissionId } = await request<{ submissionId: number }>(base, `${root}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, requestId: randomUUID() }),
  });
  const url = new URL(`${root}/stream?submissionId=${submissionId}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
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
      if (frame.type === "state") {
        const message = frame.live.generation?.message;
        if (message && frame.live.run?.inputs.some(id => id === submissionId)) print(messageText(message));
      } else if (frame.type === "settled" && frame.submissionId === submissionId) {
        if (frame.status === "unanswered") throw new Error(`Run failed: ${frame.reason}`);
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

async function log(base: URL): Promise<void> {
  const pages: ConversationPage[] = [];
  let before: number | null = null;
  do {
    const path: string = before === null ? root : `${root}?before=${before}`;
    const page: ConversationPage = await request(base, path);
    pages.push(page);
    before = page.before;
  } while (before !== null);

  for (const page of pages.reverse()) {
    for (const entry of page.entries) {
      for (const message of entry.model ?? []) {
        const text = messageText(message);
        if (text) console.log(`${message.role}: ${text}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const base = new URL(process.env.AIPATTY_URL ?? DEFAULT_URL);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("AIPATTY_URL must be HTTP(S)");
  if (command === "health" && args.length === 0) {
    console.log(JSON.stringify(await request(base, "/health"), null, 2));
  } else if (command === "models" && args.length === 0) {
    console.log(JSON.stringify(await request(base, "/api/models"), null, 2));
  } else if (command === "model" && (args.length === 2 || args.length === 3) && args[0] === "set") {
    console.log(JSON.stringify(await request(base, "/api/model", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: args.length === 3 ? args[1] : undefined, modelId: args.at(-1) }),
    }), null, 2));
  } else if (command === "log" && args.length === 0) {
    await log(base);
  } else if (command === "send" && args.length === 1 && args[0].trim()) {
    await send(base, args[0]);
  } else {
    throw new Error('Usage: aipatty health | aipatty models | aipatty model set [provider] <modelId> | aipatty send "<text>" | aipatty log');
  }
}

try {
  await main();
} catch (error) {
  console.error("aipatty:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

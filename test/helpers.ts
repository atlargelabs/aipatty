import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import { readConfig } from "../src/config.ts";
import { applyUpdate, type StreamFrame } from "../src/protocol.ts";

export const checkout = join(import.meta.dirname, "..");

export async function until<T>(
  read: () => Promise<T> | T, done: (value: T) => boolean = Boolean, timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected state");
    await sleep(20);
  }
}

/** Isolated filesystem fixtures within the ignored dependency directory. */
export async function fixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(checkout, "node_modules", "aipatty-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Server options that use no real paths and ask for a free port. */
export function fixtureArgs(dir: string): string[] {
  return ["--data-dir", dir, "--port", "0", "--pi-dir", dir];
}

/** Isolated, ephemeral-port server settings on the fake model. */
export function fauxConfig(dir: string) {
  return readConfig(fixtureArgs(dir), { AIPATTY_FAUX: "1" });
}

/** The same on the real catalog: the bundled models plus any `models-store.json` in `dir`. */
export function realConfig(dir: string) {
  return readConfig(fixtureArgs(dir), {});
}

/** Collect frames starting with the first message, not just after the open event, and fold them as a client would. */
export function connect(t: TestContext, base: string, suffix = "", options?: WebSocket.ClientOptions) {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/api/conversations/root/stream" + suffix, options);
  t.after(() => ws.terminate());
  const frames: StreamFrame[] = [];
  let state: Extract<StreamFrame, { type: "state" }> | undefined;
  ws.on("message", (data: RawData) => {
    const frame = JSON.parse(data.toString()) as StreamFrame;
    frames.push(frame);
    if (frame.type === "state") state = frame;
    else if (frame.type === "update" && state) state = applyUpdate(state, frame);
  });
  return { ws, frames, state: () => state, opened: once(ws, "open", { signal: AbortSignal.timeout(3_000) }) };
}

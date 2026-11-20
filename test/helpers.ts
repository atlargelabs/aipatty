import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import { readConfig } from "../src/config.ts";
import { applyUpdate, type StreamFrame } from "../src/protocol.ts";

export const checkout = join(import.meta.dirname, "..");

export async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean = Boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
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

/** Use no real paths, even if test configuration changes provider. */
export function fixtureEnv(dir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AIPATTY_FAUX: "1",
    AIPATTY_DATA_DIR: dir,
    AIPATTY_PORT: "0",
    AIPATTY_PI_DIR: dir,
    ...overrides,
  };
}

/** Build isolated, ephemeral-port server settings. */
export function fauxConfig(dir: string) {
  return readConfig(fixtureEnv(dir));
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

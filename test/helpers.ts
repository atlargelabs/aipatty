import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import WebSocket, { type RawData } from "ws";
import { readConfig } from "../src/config.ts";
import type { StreamFrame } from "../src/protocol.ts";

export const checkout = join(import.meta.dirname, "..");

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
    AIPATTY_AUTH_FILE: join(dir, "auth.json"),
    AIPATTY_MODELS_STORE: join(dir, "models-store.json"),
    ...overrides,
  };
}

/** Build isolated, ephemeral-port server settings. */
export function fauxConfig(dir: string) {
  return readConfig(fixtureEnv(dir));
}

/** Collect frames starting with the first message, not just after the open event. */
export function connect(t: TestContext, base: string, suffix = "") {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/api/conversations/root/stream" + suffix);
  t.after(() => ws.terminate());
  const frames: StreamFrame[] = [];
  ws.on("message", (data: RawData) => frames.push(JSON.parse(data.toString()) as StreamFrame));
  return { ws, frames, opened: once(ws, "open", { signal: AbortSignal.timeout(3_000) }) };
}

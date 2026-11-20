import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Server settings, including the model to use for a new root conversation. */
export interface Config {
  dataDir: string;
  host: string;
  trustedHosts: string[];
  port: number;
  provider: string;
  model: string;
  /** Applied to the root conversation at every start when set; a new root otherwise gets `DEFAULT_THINKING`. */
  thinking: ModelThinkingLevel | undefined;
  authFile: string;
  modelsStore: string;
  faux: boolean;
}

/** The thinking level of a new root conversation when `AIPATTY_THINKING` is unset. */
export const DEFAULT_THINKING: ModelThinkingLevel = "high";

/** The default local endpoint shared by the server and CLI. */
export const DEFAULT_URL = "http://127.0.0.1:8790";

function absolutePath(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

/** Parse aipatty's environment, rejecting invalid port and thinking settings. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = env.AIPATTY_PORT ?? "8790";
  if (!/^\d+$/.test(port) || Number(port) > 65_535) {
    throw new Error("AIPATTY_PORT must be an integer between 0 and 65535");
  }
  const thinking = env.AIPATTY_THINKING;
  const level = thinkingLevels.find(value => value === thinking);
  if (thinking !== undefined && !level) {
    throw new Error(`AIPATTY_THINKING must be one of: ${thinkingLevels.join(", ")}`);
  }
  const faux = env.AIPATTY_FAUX === "1";
  return {
    dataDir: absolutePath(env.AIPATTY_DATA_DIR ?? (faux ? "~/.aipatty/faux" : "~/.aipatty/data")),
    host: env.AIPATTY_HOST ?? "127.0.0.1",
    trustedHosts: (env.AIPATTY_TRUSTED_HOSTS ?? "").split(",").map(s => s.trim()).filter(Boolean),
    port: Number(port),
    provider: faux ? "faux" : (env.AIPATTY_PROVIDER ?? "openai"),
    model: faux ? "faux-1" : (env.AIPATTY_MODEL ?? "gpt-6.2-sol"),
    thinking: level,
    authFile: absolutePath(env.AIPATTY_AUTH_FILE ?? "~/.pi/agent/auth.json"),
    modelsStore: absolutePath(env.AIPATTY_MODELS_STORE ?? "~/.pi/agent/models-store.json"),
    faux,
  };
}

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Server settings. */
export interface Config {
  dataDir: string;
  port: number;
  /** The pi CLI's login file. */
  authFile: string;
  /** The pi CLI's cached model catalog. */
  modelsStore: string;
  faux: boolean;
}

/** The only address the server listens on. Other machines reach it through an SSH port forward. */
export const LOOPBACK = "127.0.0.1";

/** The port the server listens on, and the CLI connects to, unless `--port` says otherwise. */
export const DEFAULT_PORT = 8790;

const serverUsage = "Usage: node src/main.ts [--port <n>] [--data-dir <path>] [--pi-dir <path>]";

/**
 * Whether `AIPATTY_FAUX` asks for the fake model. It is the only environment setting; an empty value is unset. The
 * server and the CLI both check the prefix, so a leftover or misspelt name is an error, not a setting to ignore.
 */
export function readFaux(env: NodeJS.ProcessEnv = process.env): boolean {
  const unknown = Object.keys(env).filter(name => name.startsWith("AIPATTY_") && name !== "AIPATTY_FAUX");
  if (unknown.length) {
    throw new Error(`Unknown setting ${unknown.join(", ")}. The only environment setting is AIPATTY_FAUX; `
      + "the port, data directory and pi directory are command-line options");
  }
  return env.AIPATTY_FAUX === "1";
}

/** Parse a `--port` value. Only the server may take 0, which asks the operating system for a free port. */
export function readPort(value: string | undefined, min: 0 | 1): number {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > 65_535) {
    throw new Error(`--port must be an integer between ${min} and 65535`);
  }
  return Number(value);
}

function absolutePath(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

/** Parse the server's command-line options and its one environment setting. */
export function readConfig(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Config {
  const faux = readFaux(env);
  let values: { port?: string; "data-dir"?: string; "pi-dir"?: string };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { port: { type: "string" }, "data-dir": { type: "string" }, "pi-dir": { type: "string" } },
      allowPositionals: false,
    }));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n${serverUsage}`);
  }
  for (const name of ["data-dir", "pi-dir"] as const) {
    if (values[name] === "") throw new Error(`--${name} needs a path`);
  }
  const piDir = absolutePath(values["pi-dir"] ?? "~/.pi/agent");
  return {
    dataDir: absolutePath(values["data-dir"] ?? (faux ? "~/.aipatty/faux" : "~/.aipatty/data")),
    port: readPort(values.port, 0),
    authFile: join(piDir, "auth.json"),
    modelsStore: join(piDir, "models-store.json"),
    faux,
  };
}

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Server settings. */
export interface Config {
  /** The `--install-dir` root, when the directories below derive from one. */
  installDir?: string;
  dataDir: string;
  port: number;
  /** The pi CLI's login file. */
  authFile: string;
  /** The pi CLI's cached model catalog. */
  modelsStore: string;
  faux: boolean;
  /** The working directory of the model's own `read`, `write`, `edit` and `bash`. */
  workDir: string;
  /** Where each `pi` run gets its disposable workspace. */
  runsDir: string;
  pi: PiConfig;
}

/** What a `pi` run launches and where it publishes. Executables are release-relative; agent state is shared. */
export interface PiConfig {
  /** The Node binary that runs this server. */
  node: string;
  /** The pinned Pi CLI of this release. */
  cli: string;
  /** The pinned delegates extension of this release. */
  extension: string;
  /** Top-level only: the managed just-web-fetch adapter, pinned pi-web-search, and opt-in Claude Code adapter. */
  webFetchExtension: string;
  webSearchExtension: string;
  claudeCodeExtension: string;
  /** The pinned pi-review entry point of this release, loaded only by crmanager. */
  reviewExtension: string;
  /** The Pi agent directory the CLI shares with the server: sign-in, model cache, delegates settings and jobs. */
  agentDir: string;
  /** The only repository a run may work on, and the URL it is cloned from with the service account's access. */
  repo: string;
  repoUrl: string;
  git: string;
  gh: string;
  /** How often a run's process tree is recorded; the tests shorten it. */
  pollMs?: number;
  /** How long to wait before asking GitHub again for a PR's linked issues; the tests shorten it. */
  retryMs?: number;
}

/** The checkout this server runs from. */
const release = fileURLToPath(new URL("../", import.meta.url));

/** The only address the server listens on. Other machines reach it through an SSH port forward. */
export const LOOPBACK = "127.0.0.1";

/** The port the server listens on, and the CLI connects to, unless `--port` says otherwise. */
export const DEFAULT_PORT = 8790;

const serverUsage = "Usage: node src/main.ts [--port <n>] [--install-dir <path>] [--data-dir <path>] [--pi-dir <path>] [--work-dir <path>] [--runs-dir <path>]";

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
  let values: { port?: string; "install-dir"?: string; "data-dir"?: string; "pi-dir"?: string; "work-dir"?: string; "runs-dir"?: string };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        port: { type: "string" }, "install-dir": { type: "string" },
        "data-dir": { type: "string" }, "pi-dir": { type: "string" },
        "work-dir": { type: "string" }, "runs-dir": { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n${serverUsage}`);
  }
  for (const name of ["install-dir", "data-dir", "pi-dir", "work-dir", "runs-dir"] as const) {
    if (values[name] !== undefined && !values[name].trim()) throw new Error(`--${name} needs a path`);
  }
  const root = values["install-dir"] === undefined ? undefined : absolutePath(values["install-dir"]);
  const piDir = absolutePath(values["pi-dir"] ?? (root === undefined ? "~/.pi/agent" : join(root, "pi")));
  return {
    ...(root === undefined ? {} : { installDir: root }),
    dataDir: absolutePath(values["data-dir"] ?? (root === undefined
      ? (faux ? "~/.aipatty/faux" : "~/.aipatty/data") : join(root, faux ? "faux" : "data"))),
    port: readPort(values.port, 0),
    authFile: join(piDir, "auth.json"),
    modelsStore: join(piDir, "models-store.json"),
    faux,
    workDir: absolutePath(values["work-dir"] ?? (root === undefined ? "~/.aipatty/work" : join(root, "work"))),
    runsDir: absolutePath(values["runs-dir"] ?? (root === undefined ? "~/.aipatty/runs" : join(root, "runs"))),
    pi: {
      node: process.execPath,
      cli: join(release, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
      extension: join(release, "node_modules/pi-delegates/src/index.ts"),
      webFetchExtension: join(release, "src/extensions/just-web-fetch.ts"),
      webSearchExtension: join(release, "node_modules/pi-web-search/src/index.ts"),
      claudeCodeExtension: join(release, "src/extensions/claude-code.ts"),
      reviewExtension: join(release, "node_modules/@earendil-works/pi-review/review.ts"),
      agentDir: piDir,
      repo: "atlargelabs/aipatty",
      repoUrl: "git@github.com:atlargelabs/aipatty.git",
      git: "git",
      gh: "gh",
    },
  };
}

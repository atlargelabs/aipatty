import { homedir } from "node:os";
import { join, resolve } from "node:path";

const names = ["DATA_DIR", "HOST", "TRUSTED_HOSTS", "PORT", "PI_DIR", "FAUX", "URL"] as const;

/** Server settings. */
export interface Config {
  dataDir: string;
  host: string;
  trustedHosts: string[];
  port: number;
  /** The pi CLI's login file. */
  authFile: string;
  /** The pi CLI's cached model catalog. */
  modelsStore: string;
  faux: boolean;
}

/** The default local endpoint shared by the server and CLI. */
export const DEFAULT_URL = "http://127.0.0.1:8790";

/**
 * aipatty's settings from the environment, without the `AIPATTY_` prefix. An empty value is unset. The server and the
 * CLI share the prefix, so each accepts the other's settings; any other name is a mistake, not a setting to ignore.
 */
export function readSettings(env: NodeJS.ProcessEnv = process.env): Partial<Record<typeof names[number], string>> {
  const known = names.map(name => `AIPATTY_${name}`);
  const unknown = Object.keys(env).filter(name => name.startsWith("AIPATTY_") && !known.includes(name));
  if (unknown.length) throw new Error(`Unknown setting ${unknown.join(", ")}. The settings are: ${known.join(", ")}`);
  return Object.fromEntries(names.flatMap(name => env[`AIPATTY_${name}`] ? [[name, env[`AIPATTY_${name}`]]] : []));
}

function absolutePath(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

/** Parse the server's settings. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const settings = readSettings(env);
  const port = settings.PORT ?? "8790";
  if (!/^\d+$/.test(port) || Number(port) > 65_535) {
    throw new Error("AIPATTY_PORT must be an integer between 0 and 65535");
  }
  const faux = settings.FAUX === "1";
  const piDir = absolutePath(settings.PI_DIR ?? "~/.pi/agent");
  return {
    dataDir: absolutePath(settings.DATA_DIR ?? (faux ? "~/.aipatty/faux" : "~/.aipatty/data")),
    host: settings.HOST ?? "127.0.0.1",
    trustedHosts: (settings.TRUSTED_HOSTS ?? "").split(",").map(s => s.trim()).filter(Boolean),
    port: Number(port),
    authFile: join(piDir, "auth.json"),
    modelsStore: join(piDir, "models-store.json"),
    faux,
  };
}

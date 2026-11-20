import type { ProviderEnv } from "@earendil-works/pi-ai";
import { exec } from "node:child_process";

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envNamePrefix = /^[A-Za-z_][A-Za-z0-9_]*/;
const commandTimeoutMs = 10_000;

/** Whether a stored value is the pi CLI's `!command` form. */
export function isCommandValue(config: string): boolean {
  return config.startsWith("!");
}

/**
 * Interpolate the pi CLI's template form: `$VAR` and `${VAR}` name environment variables, `$$` is a literal `$` and
 * `$!` a literal `!`. A variable is looked up in `env` first, then the process environment; an empty one counts as unset.
 */
export function resolveTemplate(config: string, env?: ProviderEnv): string {
  let resolved = "";
  const missing: string[] = [];
  const lookup = (name: string) => {
    const value = env?.[name] || process.env[name];
    if (value) resolved += value;
    else if (!missing.includes(name)) missing.push(name);
  };
  for (let index = 0; index < config.length;) {
    const dollar = config.indexOf("$", index);
    if (dollar < 0) {
      resolved += config.slice(index);
      break;
    }
    resolved += config.slice(index, dollar);
    const next = config[dollar + 1];
    if (next === "$" || next === "!") {
      resolved += next;
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = config.indexOf("}", dollar + 2);
      const name = end < 0 ? undefined : config.slice(dollar + 2, end);
      if (name === undefined) {
        resolved += "$";
        index = dollar + 1;
      } else {
        if (envName.test(name)) lookup(name);
        else resolved += config.slice(dollar, end + 1);
        index = end + 1;
      }
      continue;
    }
    const name = envNamePrefix.exec(config.slice(dollar + 1))?.[0];
    if (name) lookup(name);
    else resolved += "$";
    index = dollar + 1 + (name?.length ?? 0);
  }
  if (missing.length) {
    throw new Error(`environment variable${missing.length > 1 ? "s" : ""} ${missing.join(", ")} not set`);
  }
  return resolved;
}

/**
 * Run the command of a `!command` value in the default shell and return its trimmed output. Unlike the CLI this does
 * not block the event loop, and a failure is an error rather than a missing value. The error never quotes the command.
 */
export function runCommandValue(config: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(config.slice(1), { encoding: "utf8", timeout: commandTimeoutMs }, (error, stdout) => {
      if (error) {
        reject(new Error(error.killed
          ? `command timed out after ${commandTimeoutMs / 1000} s`
          : `command failed (exit ${error.code ?? "unknown"})`));
        return;
      }
      const value = stdout.trim();
      if (value) resolve(value);
      else reject(new Error("command printed nothing"));
    });
  });
}

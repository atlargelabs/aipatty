import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve once from the running module, not a mutable deploy/current path at launch or in a child.
export const release = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
export const managedPi = {
  cli: join(release, "src/managed-pi/cli.ts"),
  extension: join(release, "src/managed-pi/delegates.ts"),
  settings: join(release, "src/managed-pi/settings.json"),
  // At this pi-web-search pin only ENOENT (not {}) selects the current model. This release ships no override.
  webSearchConfig: join(release, "src/managed-pi/web-search.json"),
  bundleCli: join(release, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
  reviewExtension: join(release, "node_modules/@earendil-works/pi-review/review.ts"),
  delegatesEntry: join(release, "node_modules/pi-delegates/src/index.ts"),
} as const;

export const repo = "atlargelabs/aipatty";

function hasKeys(value: unknown, ...keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function checks(value: unknown, ...names: string[]): boolean {
  return Array.isArray(value) && value.length === names.length && value.every((step: unknown, i) =>
    hasKeys(step, "name", "command", "timeoutMs") && step.name === names[i]
    && typeof step.command === "string" && !!step.command.trim() && !/[\x00-\x1f\x7f-\x9f]/u.test(step.command)
    && typeof step.timeoutMs === "number" && Number.isInteger(step.timeoutMs) && step.timeoutMs >= 1 && step.timeoutMs <= 86_400_000);
}

/** Reject omissions as well as malformed policy; the upstream resolver would otherwise supply permissive defaults. */
export function readManagedDelegateSettings(path = managedPi.settings) {
  try {
    const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (hasKeys(settings, "delegates") && hasKeys(settings.delegates, "version", "maxParallel", "publication", "environment")) {
      const { version, maxParallel, publication, environment } = settings.delegates;
      if (version === 1 && typeof maxParallel === "number" && Number.isInteger(maxParallel) && maxParallel >= 1 && maxParallel <= 32
        && hasKeys(publication, "repository", "remote", "baseBranch", "requiredChecks")
        && publication.repository === repo && publication.remote === "origin" && publication.baseBranch === "main"
        && Array.isArray(publication.requiredChecks) && publication.requiredChecks.every(c => typeof c === "string" && c.trim())
        && hasKeys(environment, "setup", "checks") && checks(environment.setup, "dependencies")
        && checks(environment.checks, "typecheck", "tests")) {
        return { delegates: { version, maxParallel, publication, environment, reviewExtension: managedPi.reviewExtension } };
      }
    }
    throw new Error("expected the managed delegates limit, publication guard rails, setup and both required checks");
  } catch (error) {
    throw new Error(`Invalid managed Pi settings at ${path}. Restore the running release; do not edit the Pi state directory. ${String(error)}`);
  }
}

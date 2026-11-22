import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { exists, ownedDir, ownedFile, shaPattern, syncPath, type UpgradePaths } from "./upgrade-state.ts";

const gitMs = 90_000;
const installMs = 10 * 60_000;
const checkMs = 2 * 60_000;

/** Detached command groups with a hard deadline, so a stuck install/check cannot hang the old host. */
export function command(file: string, args: string[], options: {
  cwd?: string; ms?: number; log?: number; env?: NodeJS.ProcessEnv; exitCodes?: number[];
} = {}): Promise<string> {
  const { cwd, ms = gitMs, log, env, exitCodes = [0] } = options;
  return new Promise((done, reject) => {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", log ?? "pipe", log ?? "pipe"] });
    let out = "", err = "";
    child.stdout?.setEncoding("utf8").on("data", data => { out = (out + data).slice(-2_000_000); });
    child.stderr?.setEncoding("utf8").on("data", data => { err = (err + data).slice(-8_000); });
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        // Only signal the group we just created and only while its leader is our live child.
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error); }
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(new Error(`${file} ${args[0]} timed out (${ms} ms)`));
    }, ms);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => {
      // A descendant can hold a pipe after exit. Do not keep the group-kill timer once the leader is gone.
      clearTimeout(timer);
      if (log === undefined) setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 500).unref();
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== null && exitCodes.includes(code)) done(out);
      else reject(new Error(`${file} ${args[0]} exited ${code ?? signal}${err.trim() ? `: ${err.trim()}` : ""}`));
    });
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  // Do not let a workspace or inherited Git index, configuration, or repository choose the fetched tree.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return command("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env: gitEnv() });
}

export async function releaseHead(dir: string): Promise<string> {
  ownedDir(dir);
  ownedDir(join(dir, ".git")); // No worktrees, alternates or repo elsewhere.
  if (exists(join(dir, ".git/objects/info/alternates"))) throw new Error(`Git alternates are not supported: ${dir}`);
  const head = (await git(dir, "rev-parse", "--verify", "HEAD^{commit}")).trim();
  if (!shaPattern.test(head)) throw new Error(`Expected a Git commit at ${dir}`);
  return head;
}

export async function verifyRelease(dir: string, sha: string): Promise<void> {
  if (await releaseHead(dir) !== sha) throw new Error(`Release directory does not match its commit: ${dir}`);
  if ((await git(dir, "status", "--porcelain=v1", "--untracked-files=all")).trim()) throw new Error(`Dirty release: ${dir}`);
  if ((await git(dir, "ls-files", "-v", "-z")).split("\0").some(line => line && !line.startsWith("H "))) {
    throw new Error(`Release has hidden/special index entries: ${dir}`);
  }
  ownedFile(join(dir, "src/main.ts"));
}

/** Exact pre-install tree contents, including ignored files, links and executable bits, excluding only .git. */
function treeDigest(dir: string): string {
  const hash = createHash("sha256");
  const walk = (parent: string, prefix: string) => {
    for (const name of readdirSync(parent).sort()) {
      if (!prefix && name === ".git") continue;
      const path = join(parent, name), relative = prefix + name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        ownedDir(path);
        hash.update(JSON.stringify([relative, "dir"]));
        walk(path, relative + "/");
      } else if (stat.isSymbolicLink()) {
        hash.update(JSON.stringify([relative, "link", readlinkSync(path)]));
      } else {
        ownedFile(path);
        hash.update(JSON.stringify([relative, "file", !!(stat.mode & 0o111), createHash("sha256").update(readFileSync(path)).digest("hex")]));
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

function syncTree(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) syncTree(path);
    else if (stat.isFile()) syncPath(path);
    else if (!stat.isSymbolicLink()) throw new Error(`Unexpected staged file: ${path}`);
  }
  syncPath(dir);
}

/** Resolve one remote main tip into a fresh, private directory. Never use the live release's Git config. */
export async function stageRelease(options: {
  paths: UpgradePaths; id: string; old: string; bootstrap?: string; origin: string; log: number;
  pinned(sha: string): void; note(text: string): void;
}): Promise<string> {
  const { paths, id, old, bootstrap, origin, log, pinned, note } = options;
  const staging = join(paths.deploy, `.stage-${id}`);
  mkdirSync(staging, { mode: 0o700 }); // Exclusive: never reuse a half-prepared release.
  try {
    note(`Fetching refs/heads/main from ${origin}`);
    await git(staging, "init", "--quiet", "--template=");
    await git(staging, "remote", "add", "-t", "main", "origin", origin);
    await git(staging, "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--depth=1", "origin", "+refs/heads/main:refs/remotes/origin/main");
    const sha = (await git(staging, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}")).trim();
    const dest = paths.release(sha);
    pinned(sha);
    if (bootstrap && bootstrap !== dest) throw new Error(`Bootstrap must be the fetched main tip: ${dest}`);
    if (sha === old && !bootstrap) return sha;
    if (!bootstrap && exists(dest)) throw new Error(`Release already exists; inspect and move the inactive directory before requesting again: ${dest}`);
    await git(staging, "checkout", "--quiet", "--detach", sha);
    await verifyRelease(staging, sha);
    if (bootstrap) {
      await verifyRelease(bootstrap, sha);
      if (treeDigest(bootstrap) !== treeDigest(staging)) throw new Error("Bootstrap is not an exact clean main tree (including ignored files and dependencies)");
      if (sha === old) return sha;
    }
    const prepared = bootstrap ?? staging;
    // The checked-in npm config and the pinned lockfile are part of the fetched release.
    for (const [args, ms] of [[ ["ci", "--ignore-scripts"], installMs ], [ ["run", "check"], checkMs ], [ ["test"], installMs ]] as const) {
      note(`Running npm ${args.join(" ")}`);
      await command("npm", [...args], { cwd: prepared, ms, log });
    }
    await verifyRelease(prepared, sha);
    ownedFile(join(prepared, "src/upgrade-supervisor.ts"));
    syncTree(prepared);
    if (!bootstrap) {
      if (exists(dest)) throw new Error(`Release appeared during staging: ${dest}`);
      renameSync(staging, dest);
    }
    syncPath(paths.deploy);
    return sha;
  } finally {
    // This is only the unique directory we created, never current or a published release.
    rmSync(staging, { recursive: true, force: true });
  }
}

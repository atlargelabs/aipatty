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
const reapMs = 5_000;
class UnreapedCommand extends Error {}

/** Detached command groups with a hard deadline, so a stuck install/check cannot hang the old host. */
export function command(file: string, args: string[], options: {
  cwd?: string; ms?: number; log?: number; env?: NodeJS.ProcessEnv; exitCodes?: number[]; signal?: AbortSignal;
} = {}): Promise<string> {
  const { cwd, ms = gitMs, log, env, exitCodes = [0], signal } = options;
  signal?.throwIfAborted();
  return new Promise((done, reject) => {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", log ?? "pipe", log ?? "pipe"] });
    let out = "", err = "", exited = false;
    let failure: Error | undefined, reap: NodeJS.Timeout | undefined;
    child.stdout?.setEncoding("utf8").on("data", data => { out = (out + data).slice(-2_000_000); });
    child.stderr?.setEncoding("utf8").on("data", data => { err = (err + data).slice(-8_000); });
    const cancel = (reason: Error) => {
      if (failure) return;
      failure = reason;
      if (!exited && child.pid !== undefined) {
        // Only signal the group we just created and only while its leader is our live child.
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error); }
      }
      reap = setTimeout(() => {
        clean();
        child.unref();
        child.stdout?.destroy();
        child.stderr?.destroy();
        reject(new UnreapedCommand(`${reason.message}; command did not exit. Retain the private staging directory.`));
      }, reapMs);
    };
    const abort = () => cancel(new Error(`${file} ${args[0]} cancelled: staging supervisor disconnected`));
    const timer = setTimeout(() => cancel(new Error(`${file} ${args[0]} timed out (${ms} ms)`)), ms);
    const clean = () => {
      clearTimeout(timer);
      clearTimeout(reap);
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => { clean(); reject(failure ?? error); });
    child.once("exit", () => {
      // A descendant can hold a pipe after exit. Do not keep the group-kill timer once the leader is gone.
      exited = true;
      clearTimeout(timer);
      if (log === undefined) setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 500).unref();
    });
    child.once("close", (code, killed) => {
      clean();
      if (failure) reject(failure);
      else if (code !== null && exitCodes.includes(code)) done(out);
      else reject(new Error(`${file} ${args[0]} exited ${code ?? killed}${err.trim() ? `: ${err.trim()}` : ""}`));
    });
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  // Do not let a workspace or inherited Git index, configuration, or repository choose the fetched tree.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

function gitAt(cwd: string, signal?: AbortSignal) {
  return (...args: string[]) => command("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env: gitEnv(), signal });
}

async function releaseHead(dir: string, signal?: AbortSignal): Promise<string> {
  ownedDir(dir);
  ownedDir(join(dir, ".git")); // No worktrees, alternates or repo elsewhere.
  if (exists(join(dir, ".git/objects/info/alternates"))) throw new Error(`Git alternates are not supported: ${dir}`);
  const head = (await gitAt(dir, signal)("rev-parse", "--verify", "HEAD^{commit}")).trim();
  if (!shaPattern.test(head)) throw new Error(`Expected a Git commit at ${dir}`);
  return head;
}

export async function verifyRelease(dir: string, sha: string, signal?: AbortSignal): Promise<void> {
  const git = gitAt(dir, signal);
  if (await releaseHead(dir, signal) !== sha) throw new Error(`Release directory does not match its commit: ${dir}`);
  if ((await git("status", "--porcelain=v1", "--untracked-files=all")).trim()) throw new Error(`Dirty release: ${dir}`);
  if ((await git("ls-files", "-v", "-z")).split("\0").some(line => line && !line.startsWith("H "))) {
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
  paths: UpgradePaths; id: string; old: string; bootstrap?: string; origin: string; log: number; signal: AbortSignal;
  pinned(sha: string): void; note(text: string): void;
}): Promise<string> {
  const { paths, id, old, bootstrap, origin, log, pinned, note, signal } = options;
  const staging = join(paths.deploy, `.stage-${id}`);
  mkdirSync(staging, { mode: 0o700 }); // Exclusive: never reuse a half-prepared release.
  let reaped = true;
  try {
    note(`Fetching refs/heads/main from ${origin}`);
    const git = gitAt(staging, signal);
    await git("init", "--quiet", "--template=");
    await git("remote", "add", "-t", "main", "origin", origin);
    await git("fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--depth=1", "origin", "+refs/heads/main:refs/remotes/origin/main");
    const sha = (await git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}")).trim();
    const dest = paths.release(sha);
    pinned(sha);
    if (bootstrap && bootstrap !== dest) throw new Error(`Bootstrap must be the fetched main tip: ${dest}`);
    if (sha === old && !bootstrap) return sha;
    if (!bootstrap && exists(dest)) throw new Error(`Release already exists; inspect and move the inactive directory before requesting again: ${dest}`);
    await git("checkout", "--quiet", "--detach", sha);
    await verifyRelease(staging, sha, signal);
    const bootstrapTree = bootstrap && treeDigest(staging);
    const verifyBootstrap = async () => {
      if (!bootstrap) return;
      await verifyRelease(bootstrap, sha, signal);
      if (treeDigest(bootstrap) !== bootstrapTree) throw new Error("Bootstrap is not an exact clean main tree (including ignored files and dependencies)");
    };
    await verifyBootstrap();
    if (sha === old) return sha;
    // Always run commands in the private checkout, even in bootstrap. Checks never write the staged helper tree.
    for (const [args, ms] of [[ ["ci", "--ignore-scripts"], installMs ], [ ["run", "check"], checkMs ], [ ["test"], installMs ]] as const) {
      note(`Running npm ${args.join(" ")}`);
      await command("npm", [...args], { cwd: staging, ms, log, signal });
    }
    await verifyRelease(staging, sha, signal);
    ownedFile(join(staging, "src/upgrade-supervisor.ts"));
    const dependencies = join(staging, "node_modules");
    ownedDir(dependencies);
    syncTree(staging);
    await verifyBootstrap();
    signal.throwIfAborted();
    if (bootstrap) {
      // Only publish the checked pinned dependencies; the verified operator checkout already supplies the code.
      renameSync(dependencies, join(bootstrap, "node_modules"));
      syncPath(bootstrap);
    } else {
      if (exists(dest)) throw new Error(`Release appeared during staging: ${dest}`);
      renameSync(staging, dest);
    }
    syncPath(paths.deploy);
    return sha;
  } catch (error) {
    reaped = !(error instanceof UnreapedCommand);
    throw error;
  } finally {
    // This is only the unique directory we created, never current or a published release.
    if (reaped) rmSync(staging, { recursive: true, force: true });
  }
}

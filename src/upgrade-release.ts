import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { exists, ownedDir, ownedFile, shaPattern, syncPath, type UpgradePaths } from "./upgrade-state.ts";

const gitMs = 90_000;
const installMs = 10 * 60_000;
const checkMs = 2 * 60_000;
const reapMs = 5_000;
export class InterruptedStageError extends Error {}

/** Bound all commands. An interrupted stage leaves its private files and processes for explicit maintenance. */
export function command(file: string, args: string[], options: {
  cwd?: string; ms?: number; log?: number; env?: NodeJS.ProcessEnv; exitCodes?: number[]; signal?: AbortSignal;
  rejectStderr?: boolean;
} = {}): Promise<string> {
  const { cwd, ms = gitMs, log, env, exitCodes = [0], signal, rejectStderr } = options;
  signal?.throwIfAborted();
  return new Promise((done, reject) => {
    // Stage commands share the worker's group. Independent inspections keep their own transient group.
    const child = spawn(file, args, { cwd, env, detached: signal === undefined, stdio: ["ignore", log ?? "pipe", log ?? "pipe"] });
    let out = "", err = "", exited = false;
    let failure: Error | undefined, reap: NodeJS.Timeout | undefined;
    child.stdout?.setEncoding("utf8").on("data", data => { out = (out + data).slice(-2_000_000); });
    child.stderr?.setEncoding("utf8").on("data", data => { err = (err + data).slice(-8_000); });
    const cancel = (reason: Error) => {
      if (failure) return;
      failure = reason;
      if (signal) {
        clean();
        child.unref();
        child.stdout?.destroy();
        child.stderr?.destroy();
        reject(new InterruptedStageError(reason.message));
        return;
      }
      if (!exited && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } // Only the group we created while its leader is our live child.
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error); }
      }
      reap = setTimeout(() => {
        clean();
        child.unref();
        child.stdout?.destroy();
        child.stderr?.destroy();
        reject(new Error(`${reason.message}; command did not exit`));
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
      exited = true;
      // Inspectors have a bounded drain; for staging, a pipe that never closes is an interruption.
      if (!signal) {
        clearTimeout(timer);
        if (log === undefined) setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 500).unref();
      }
    });
    child.once("close", (code, killed) => {
      clean();
      const detail = `${file} ${args[0]} exited ${code ?? killed}${err.trim() ? `: ${err.trim()}` : ""}`;
      if (failure) reject(failure);
      else if (signal && killed) reject(new InterruptedStageError(detail));
      else if (code !== null && exitCodes.includes(code) && (!rejectStderr || !err.trim())) done(out);
      else reject(new Error(detail));
    });
  });
}

export function gitEnv(): NodeJS.ProcessEnv {
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

/** Include ignored files, links and executable bits. Bootstrap compares only the worktrees of two clones. */
function treeDigest(dir: string, { worktree = false, noStageLinks }: { worktree?: boolean; noStageLinks?: string } = {}): string {
  const hash = createHash("sha256");
  const walk = (parent: string, prefix: string) => {
    for (const name of readdirSync(parent).sort()) {
      if (worktree && !prefix && name === ".git") continue;
      const path = join(parent, name), relative = prefix + name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        ownedDir(path);
        hash.update(JSON.stringify([relative, "dir"]));
        walk(path, relative + "/");
      } else if (stat.isSymbolicLink()) {
        const link = readlinkSync(path);
        if (noStageLinks) {
          const inStage = (target: string) => target === noStageLinks || target.startsWith(noStageLinks + sep);
          let real: string | undefined;
          try { real = realpathSync(path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (inStage(resolve(dirname(path), link)) || (real && inStage(real))) {
            throw new Error(`Release link points into its private stage: ${path}`);
          }
        }
        hash.update(JSON.stringify([relative, "link", link]));
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

async function verifyBootstrap(dir: string, sha: string, digest: string, signal?: AbortSignal): Promise<void> {
  await verifyRelease(dir, sha, signal);
  if (treeDigest(dir, { worktree: true }) !== digest) {
    throw new Error("Bootstrap is not an exact clean main tree (including ignored files and dependencies)");
  }
}

export interface StageOutput { sha: string; digest?: string; bootstrapTree?: string }

/** This worker only prepares its private checkout; it cannot publish, clean up or change the journal. */
export async function stageRelease(options: {
  paths: UpgradePaths; id: string; old: string; bootstrap?: string; origin: string; log: number; signal: AbortSignal;
  pinned(sha: string): Promise<void>; note(text: string): void;
}): Promise<StageOutput> {
  const { paths, id, old, bootstrap, origin, log, pinned, note, signal } = options;
  const staging = paths.stage(id);
  ownedDir(staging);
  note(`Fetching refs/heads/main from ${origin}`);
  const git = gitAt(staging, signal);
  await git("init", "--quiet", "--template=");
  await git("remote", "add", "-t", "main", "origin", origin);
  await git("fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--depth=1", "origin", "+refs/heads/main:refs/remotes/origin/main");
  const sha = (await git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}")).trim();
  const dest = paths.release(sha);
  await pinned(sha);
  if (bootstrap && bootstrap !== dest) throw new Error(`Bootstrap must be the fetched main tip: ${dest}`);
  if (sha === old && !bootstrap) return { sha };
  if (!bootstrap && exists(dest)) throw new Error(`Release already exists; inspect and move the inactive directory before requesting again: ${dest}`);
  await git("checkout", "--quiet", "--detach", sha);
  await verifyRelease(staging, sha, signal);
  const bootstrapTree = bootstrap ? treeDigest(staging, { worktree: true }) : undefined;
  if (bootstrap && bootstrapTree) await verifyBootstrap(bootstrap, sha, bootstrapTree, signal);
  if (sha === old) return { sha };
  // Always run commands in the private checkout, even in bootstrap. Checks never write the staged helper tree.
  for (const [args, ms] of [[ ["ci", "--ignore-scripts", "--include=dev"], installMs ], [ ["run", "check"], checkMs ], [ ["test"], installMs ]] as const) {
    note(`Running npm ${args.join(" ")}`);
    await command("npm", [...args], { cwd: staging, env: gitEnv(), ms, log, signal });
  }
  await verifyRelease(staging, sha, signal);
  ownedFile(join(staging, "src/upgrade-supervisor.ts"));
  ownedDir(join(staging, "node_modules"));
  return { sha, digest: treeDigest(staging), bootstrapTree };
}

/** Only the coordinator publishes, after normal worker exit. Do not move any worker-owned inode into a release. */
export async function publishRelease(paths: UpgradePaths, id: string, output: StageOutput, bootstrap?: string): Promise<void> {
  const { sha, digest, bootstrapTree } = output;
  const staged = paths.stage(id), dest = paths.release(sha);
  if (!digest || (bootstrap && (bootstrap !== dest || !bootstrapTree))) throw new Error("Stage output is incomplete");
  const copy = mkdtempSync(join(paths.deploy, `.publish-${id}-`));
  try {
    cpSync(staged, copy, { recursive: true, verbatimSymlinks: true });
    if (treeDigest(copy, { noStageLinks: staged }) !== digest) throw new Error("Checked release changed before publication");
    await verifyRelease(copy, sha);
    syncTree(copy);
    if (bootstrap && bootstrapTree) {
      await verifyBootstrap(bootstrap, sha, bootstrapTree);
      renameSync(join(copy, "node_modules"), join(bootstrap, "node_modules"));
      syncTree(bootstrap); // The operator checkout's sources and Git metadata also need to survive a reboot.
    } else {
      if (exists(dest)) throw new Error(`Release appeared during staging: ${dest}`);
      renameSync(copy, dest);
    }
    syncPath(paths.deploy);
  } finally { rmSync(copy, { recursive: true, force: true }); }
}

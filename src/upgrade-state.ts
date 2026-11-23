import { randomUUID } from "node:crypto";
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { ownSqliteLock } from "./ownership.ts";

export const shaPattern = /^[0-9a-f]{40}$/;
export const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const upgradeRequestKey = /^[A-Za-z0-9_-]{16,64}$/;
export const upgradeCommand = "/upgrade";
export const upgradeHeader = "x-aipatty-upgrade";
export const upgradeEntryKind = "aipatty.upgrade";
export const upgradeChildEnv = "PATTY_UPGRADE_CHILD";
export const upgradeProtocol = 1;

const phases = ["requested", "staging", "stopping", "switching", "restoring", "restored", "done"] as const;
const outcomes = ["upgraded", "noop", "failed", "cancelled", "rolled-back"] as const;
export interface UpgradeResult {
  kind: typeof outcomes[number];
  active?: string;
  reason?: string;
}

export interface ProcessIdentity { pid: number; start: string }

export interface UpgradeJournal {
  version: 1;
  id: string;
  branch?: number;
  requestKey?: string;
  port: number;
  faux: boolean;
  old: string;
  legacy: boolean;
  phase: typeof phases[number];
  target?: string;
  oldProcess?: ProcessIdentity;
  reason?: string;
  result?: UpgradeResult;
  reported?: true;
}

function validProcess(value: ProcessIdentity | undefined): boolean {
  return value === undefined || (!!value && Number.isSafeInteger(value.pid) && value.pid > 1 && typeof value.start === "string" && !!value.start);
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const uid = process.getuid?.();

function inspect(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

export function exists(path: string): boolean {
  return inspect(path) !== undefined;
}

export function ownedFile(path: string, required = true): boolean {
  const stat = inspect(path);
  if (!stat && !required) return false;
  if (!stat?.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o22)) {
    throw new Error(`Expected an owned regular file, writable only by its owner: ${path}`);
  }
  return true;
}

export function ownedDir(path: string): void {
  const stat = inspect(path);
  if (!stat?.isDirectory() || stat.uid !== uid || (stat.mode & 0o22) || realpathSync(path) !== path) {
    throw new Error(`Expected an owned, canonical directory, writable only by its owner: ${path}`);
  }
}

export function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function atomicFile(path: string, contents: string): void {
  ownedFile(path, false);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, contents, { mode: 0o600, flag: "wx", flush: true });
    renameSync(temp, path);
    syncPath(dirname(path));
  } finally {
    rmSync(temp, { force: true });
  }
}

/** All writable upgrade paths are under an owned install; there are no request-controlled filesystem paths. */
export class UpgradePaths {
  readonly root: string;
  readonly data: string;
  readonly deploy: string;
  readonly state: string;
  readonly journal: string;
  readonly current: string;
  readonly db: string;
  readonly piRun: string;

  constructor(root: string, data: string) {
    this.root = root;
    this.data = data;
    this.deploy = join(root, "deploy");
    this.state = join(root, "upgrade");
    this.journal = join(this.state, "journal.json");
    this.current = join(this.deploy, "current");
    this.db = join(data, "aipatty.sqlite");
    this.piRun = join(data, "pi-run.json");
  }

  static forConfig(config: Config): UpgradePaths {
    const root = config.installDir;
    if (!root || config.port === 0 || config.dataDir !== join(root, config.faux ? "faux" : "data")
      || config.pi.agentDir !== join(root, "pi") || config.workDir !== join(root, "work") || config.runsDir !== join(root, "runs")) {
      throw new Error("Upgrade needs --install-dir, a fixed nonzero port, and no directory overrides");
    }
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Upgrade supports macOS and Linux only");
    if (root === "/" || root !== resolve(root) || /[\r\n]/.test(root)) throw new Error("Use a canonical dedicated installation root");
    const paths = new UpgradePaths(root, config.dataDir);
    for (const dir of [root, paths.deploy, paths.data, config.pi.agentDir, config.workDir, config.runsDir]) ownedDir(dir);
    return paths;
  }

  /** Do not create a journal or claim a development setup just by starting a server. */
  static forStartup(config: Config): UpgradePaths | undefined {
    const data = realpathSync(config.dataDir);
    const dir = basename(data);
    const roots = new Set<string>();
    if (dir === "data" || dir === "faux") roots.add(dirname(data));
    if (config.installDir && exists(config.installDir)) roots.add(realpathSync(config.installDir));
    for (const root of roots) {
      const paths = new UpgradePaths(root, data);
      const state = inspect(paths.state);
      if (!state) continue;
      // Never follow a replacement state symlink. An ordinary sibling directory without a journal
      // is not an installation; inspection errors other than absence still propagate.
      if (state.isSymbolicLink()) ownedDir(paths.state);
      if (!state.isDirectory() || !exists(paths.journal)) continue;
      ownedDir(paths.state);
      const configured = UpgradePaths.forConfig(config);
      if (configured.root !== root) throw new Error(`Use the journal's installation root: ${root}`);
      return configured;
    }
  }

  init(): void {
    if (!exists(this.state)) {
      try { mkdirSync(this.state, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      syncPath(this.root);
    }
    ownedDir(this.state);
  }

  lease(): () => void {
    return this.lock(join(this.state, "owner.sqlite"), "Another upgrade or recovery owns this installation");
  }

  /** Excludes the worker itself during acknowledgement; a free lease says nothing about its subprocesses. */
  stagingLease(id: string): () => void {
    return this.lock(this.artifact(id, ".stage-owner.sqlite"), `Stage worker for ${id} still holds its lease; see its log before recovering`);
  }

  private lock(lock: string, busy: string): () => void {
    this.init();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) ownedFile(lock + suffix, false);
    return ownSqliteLock(lock, busy);
  }

  release(sha: string): string {
    if (!shaPattern.test(sha)) throw new Error("Expected a full release SHA");
    return join(this.deploy, sha);
  }

  selected(): string {
    if (!inspect(this.current)?.isSymbolicLink()) throw new Error(`Expected a current symlink: ${this.current}`);
    const real = realpathSync(this.current);
    const sha = basename(real);
    if (real !== this.release(sha)) throw new Error("deploy/current must resolve to a direct deploy/<sha> release");
    ownedDir(real);
    return sha;
  }

  select(sha: string): void {
    ownedDir(this.release(sha));
    this.selected(); // Do not replace anything other than the managed symlink.
    const temp = join(this.deploy, `.current-${randomUUID()}`);
    try {
      symlinkSync(sha, temp);
      renameSync(temp, this.current);
      syncPath(this.deploy);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  backup(id: string): string { return this.artifact(id, ".sqlite"); }
  log(id: string): string { return this.artifact(id, ".log"); }

  stage(id: string): string {
    if (!idPattern.test(id)) throw new Error("Invalid upgrade request ID");
    return join(this.deploy, `.stage-${id}`);
  }

  private artifact(id: string, suffix: string): string {
    if (!idPattern.test(id)) throw new Error("Invalid upgrade request ID");
    return join(this.state, id + suffix);
  }

  load(): UpgradeJournal | undefined {
    if (!exists(this.state)) return undefined;
    ownedDir(this.state);
    if (!ownedFile(this.journal, false)) return undefined;
    const j = JSON.parse(readFileSync(this.journal, "utf8")) as UpgradeJournal;
    if (!j || j.version !== 1 || typeof j.id !== "string" || !idPattern.test(j.id)
      || typeof j.old !== "string" || !shaPattern.test(j.old)
      || (j.target !== undefined && (typeof j.target !== "string" || !shaPattern.test(j.target)))
      || !Number.isInteger(j.port) || j.port < 1 || j.port > 65_535 || typeof j.faux !== "boolean"
      || typeof j.legacy !== "boolean" || !phases.includes(j.phase)
      || (j.branch !== undefined && (!Number.isSafeInteger(j.branch) || j.branch < 1 || j.legacy))
      || (j.branch === undefined ? j.requestKey !== undefined : typeof j.requestKey !== "string" || !upgradeRequestKey.test(j.requestKey))
      || !validProcess(j.oldProcess)
      || (j.reason !== undefined && typeof j.reason !== "string")
      || (j.reported !== undefined && (j.phase !== "done" || j.reported !== true))
      || (j.phase === "done" ? !j.result || !outcomes.includes(j.result.kind) : j.result !== undefined)
      || (j.result?.active !== undefined && (typeof j.result.active !== "string" || !shaPattern.test(j.result.active)))
      || (j.result?.reason !== undefined && typeof j.result.reason !== "string")
      || (["stopping", "switching", "restoring", "restored"].includes(j.phase) && (!j.target || j.old === j.target))
      || (j.result?.kind === "upgraded" && (!j.target || j.target === j.old || j.result.active !== j.target))
      || (j.result?.active !== undefined && j.result.kind !== "upgraded" && j.result.active !== j.old)) {
      throw new Error(`Invalid upgrade journal: ${this.journal}`);
    }
    return j;
  }

  save(journal: UpgradeJournal): void {
    atomicFile(this.journal, JSON.stringify(journal, null, 2) + "\n");
  }

  /** Before serving after an observed terminal rename: the previous writer may have died before its fsync. */
  syncJournal(): void {
    syncPath(this.journal);
    syncPath(this.state);
  }
}

export function interruptedStage(paths: UpgradePaths, id: string): string {
  return `Interrupted staging (${id}): retain ${paths.journal} and ${paths.stage(id)}. `
    + `See ${paths.log(id)} and the install runbook before using recover --ack-interrupted-stage ${id}.`;
}

export function sameInstall(j: UpgradeJournal, config: Pick<Config, "port" | "faux">): void {
  if (j.port !== config.port || j.faux !== config.faux) throw new Error("The upgrade journal requires the original port and AIPATTY_FAUX setting");
}

export function resultText(j: UpgradeJournal): string {
  const result = j.result!;
  const status = {
    upgraded: "Upgrade complete", noop: "Upgrade not needed", failed: "Upgrade failed before cutover",
    cancelled: "Upgrade cancelled before cutover", "rolled-back": "Upgrade rolled back",
  }[result.kind];
  const active = result.active ? `Active SHA: ${result.active}.` : "No active server was verified.";
  return `${status} (${j.id}). ${active}${result.reason ? ` ${result.reason}` : ""}`;
}

export function finish(j: UpgradeJournal, result: UpgradeResult): UpgradeJournal {
  return { ...j, phase: "done", result };
}

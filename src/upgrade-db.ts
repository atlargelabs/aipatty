import { randomUUID } from "node:crypto";
import { constants, copyFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { exists, ownedFile, syncPath, type UpgradePaths } from "./upgrade-state.ts";

const sidecars = ["-journal", "-wal", "-shm"];

function check(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || rows[0].quick_check !== "ok") throw new Error("SQLite quick_check failed");
}

function checkFiles(path: string, required = true): void {
  ownedFile(path, required);
  for (const suffix of sidecars) ownedFile(path + suffix, false);
}

/** Only called with the separate conversation owner lock held, after the old server exits. */
export async function backupDb(paths: UpgradePaths, id: string, beforePublish?: () => void): Promise<void> {
  const dest = paths.backup(id);
  checkFiles(paths.db);
  if (exists(dest)) throw new Error(`Backup already exists: ${dest}`);
  const temp = `${dest}.${randomUUID()}.tmp`;
  try {
    // SQLite reads committed WAL frames too; an abrupt stop need not have checkpointed them.
    using source = new DatabaseSync(paths.db, { timeout: 0 });
    writeFileSync(temp, "", { mode: 0o600, flag: "wx" });
    await backup(source, temp);
    {
      using copy = new DatabaseSync(temp, { timeout: 0 });
      if (copy.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode !== "delete") throw new Error("Could not make a standalone SQLite backup");
      check(copy);
    }
    if (sidecars.some(suffix => exists(temp + suffix))) throw new Error("Unexpected backup sidecar");
    syncPath(temp);
    beforePublish?.();
    if (exists(dest)) throw new Error(`Backup already exists: ${dest}`);
    renameSync(temp, dest);
    syncPath(paths.state);
  } finally {
    for (const suffix of ["", ...sidecars]) rmSync(temp + suffix, { force: true });
  }
}

/** Repeatable until the restored phase is synced. Never restore after an old server is permitted to write again. */
export function restoreDb(paths: UpgradePaths, id: string, beforeReplace?: () => void): void {
  const source = paths.backup(id);
  ownedFile(source);
  for (const suffix of sidecars) if (exists(source + suffix)) throw new Error(`Unexpected backup sidecar: ${source + suffix}`);
  checkFiles(paths.db, false);
  {
    using db = new DatabaseSync(source, { timeout: 0, readOnly: true });
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") throw new Error("Backup is not standalone");
    check(db);
  }
  const temp = `${paths.db}.${randomUUID()}.restore`;
  try {
    copyFileSync(source, temp, constants.COPYFILE_EXCL);
    syncPath(temp);
    // Do not give the restored main file the failed candidate's WAL/journal on the next open.
    beforeReplace?.();
    for (const suffix of sidecars) rmSync(paths.db + suffix, { force: true });
    syncPath(paths.data);
    beforeReplace?.();
    renameSync(temp, paths.db);
    syncPath(paths.data);
  } finally {
    rmSync(temp, { force: true });
  }
}
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Hold an exclusive transaction on a separate file, never on the conversation DB.
 * The OS releases the lock when the connection closes or the process dies.
 */
export function ownDataDir(dir: string): () => void {
  return ownSqliteLock(join(dir, "owner.sqlite"), `Another aipatty process owns data directory ${dir}`);
}

export class OwnerBusy extends Error {}

/** An OS-released mutex, independent of the app database and any leftover journal. */
export function ownSqliteLock(path: string, busy: string): () => void {
  const lock = new DatabaseSync(path, { timeout: 0 });
  try {
    lock.exec("BEGIN EXCLUSIVE");
    return () => lock.close();
  } catch (error) {
    lock.close();
    if (error instanceof Error && "errcode" in error && error.errcode === 5 /* SQLITE_BUSY */) {
      throw new OwnerBusy(busy, { cause: error });
    }
    throw error;
  }
}

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Own a data directory until the returned function is called. */
export function ownDataDir(dir: string): () => void {
  return ownLock(join(dir, "owner.sqlite"), `Another aipatty process owns data directory ${dir}`);
}

/**
 * Hold an exclusive transaction on a file of its own, never on the conversation DB.
 * The OS releases the lock when the connection closes or the process dies.
 */
export function ownLock(file: string, busy: string): () => void {
  const lock = new DatabaseSync(file, { timeout: 0 });
  try {
    lock.exec("BEGIN EXCLUSIVE");
    return () => lock.close();
  } catch (error) {
    lock.close();
    if (error instanceof Error && "errcode" in error && error.errcode === 5 /* SQLITE_BUSY */) {
      throw new Error(busy, { cause: error });
    }
    throw error;
  }
}

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Hold an exclusive transaction on a separate file, never on the conversation DB.
 * The OS releases the lock when the connection closes or the process dies.
 */
export function ownDataDir(dir: string): () => void {
  const lock = new DatabaseSync(join(dir, "owner.sqlite"), { timeout: 0 });
  try {
    lock.exec("BEGIN EXCLUSIVE");
    return () => lock.close();
  } catch (error) {
    lock.close();
    if (error instanceof Error && "errcode" in error && error.errcode === 5 /* SQLITE_BUSY */) {
      throw new Error(`Another aipatty process owns data directory ${dir}`, { cause: error });
    }
    throw error;
  }
}

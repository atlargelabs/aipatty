import { DatabaseSync, constants as sqlite, type SQLOutputValue } from "node:sqlite";
import { GymInputError } from "./model.ts";

export const maxSql = 8_000;
export const queryRowLimit = 100;
const tableByteLimit = 32 * 1024;
// Only skip whitespace and complete comments, never a second statement. Block comments end at the first */.
const commentOrSpace = /^(?:\s|--[^\n]*|\/\*(?:[^*]|\*(?!\/))*\*\/)*/;

export function tableRow(values: readonly SQLOutputValue[]) {
  const cells = values.map(value => {
    const text = value === null ? "NULL" : value instanceof Uint8Array ? "0x" + Buffer.from(value).toString("hex") : String(value);
    return text.replace(/[\r\n]+/g, " ").replace(/[\\`*_\[\]<>|&~]/g, "\\$&");
  });
  return "| " + cells.join(" | ") + " |";
}

export function openQuery(path: string) {
  const db = new DatabaseSync(path, {
    readOnly: true, allowExtension: false, readBigInts: true, returnArrays: true,
    limits: { attach: 0, length: 64 * 1024, sqlLength: 4 * maxSql, column: 32 },
  });
  try {
    // Allow reads and built-in functions without a table or function list. Reject all write, attachment and PRAGMA actions.
    db.setAuthorizer(action => action === sqlite.SQLITE_SELECT || action === sqlite.SQLITE_READ
      || action === sqlite.SQLITE_FUNCTION || action === sqlite.SQLITE_RECURSIVE ? sqlite.SQLITE_OK : sqlite.SQLITE_DENY);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    run(input: unknown) {
      if (typeof input !== "string" || !input.trim() || input.length > maxSql || input.includes("\0")) {
        throw new GymInputError(`Enter SQL as a string of 1 to ${maxSql} characters, with no NUL bytes.`);
      }
      const sql = input.trim();
      if (!/^(?:SELECT|WITH)\b/i.test(sql.replace(commentOrSpace, ""))) {
        throw new GymInputError("Run one SELECT or a read-only WITH query.");
      }
      const statement = db.prepare(sql);
      // Node prepares only the first statement; sourceSQL ends exactly where SQLite stopped.
      if (sql.slice(statement.sourceSQL.length).replace(commentOrSpace, "")) {
        throw new GymInputError("Run one SELECT or a read-only WITH query, not multiple statements.");
      }
      const columns = statement.columns().map(column => column.name);
      if (!columns.length) throw new GymInputError("The query must return columns.");
      const lines = [tableRow(columns), tableRow(columns.map(() => "---"))];
      let bytes = Buffer.byteLength(lines.join("\n"));
      if (bytes > tableByteLimit) throw new GymInputError("Column names are too large; use shorter aliases.");
      for (const row of statement.iterate() as unknown as Iterable<SQLOutputValue[]>) {
        if (lines.length === queryRowLimit + 2) {
          lines.push("", `Results truncated after ${queryRowLimit} rows. Use filters or aggregation to narrow the result.`);
          break;
        }
        const line = tableRow(row);
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > tableByteLimit) {
          lines.push("", "Results truncated for size. Select fewer or shorter columns.");
          break;
        }
        lines.push(line);
      }
      if (lines.length === 2) lines.push("", "No rows matched.");
      return lines.join("\n");
    },
    close: () => db.close(),
  };
}

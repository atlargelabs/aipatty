import { DatabaseSync, constants as sqlite, type SQLOutputValue } from "node:sqlite";
import { GymInputError, maxSql, readQuery } from "./model.ts";

export const queryRowLimit = 100;
const queryByteLimit = 32 * 1024;
const gymTables = new Set(["workouts", "sets", "plan"]);
const functions = new Set([
  "count", "sum", "avg", "min", "max", "total", "group_concat", "string_agg",
  "abs", "round", "lower", "upper", "length", "substr", "substring", "instr", "replace",
  "trim", "ltrim", "rtrim", "like", "glob", "coalesce", "ifnull", "nullif", "iif", "typeof",
  "date", "time", "datetime", "julianday", "unixepoch", "strftime", "timediff",
  "row_number", "rank", "dense_rank", "lag", "lead", "first_value", "last_value",
]);

function jsonCell(value: SQLOutputValue) {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (value instanceof Uint8Array) return "0x" + Buffer.from(value).toString("hex");
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

export function openQuery(path: string) {
  const db = new DatabaseSync(path, {
    readOnly: true, allowExtension: false, readBigInts: true, returnArrays: true,
    limits: { attach: 0, length: 64 * 1024, sqlLength: 4 * maxSql, column: 32 },
  });
  try {
    db.setAuthorizer((action, arg1, arg2, database) => {
      if (action === sqlite.SQLITE_SELECT) return sqlite.SQLITE_OK;
      // SQLite omits database and uses an empty column for table-only reads (e.g. COUNT(*)).
      if (action === sqlite.SQLITE_READ && gymTables.has(arg1 ?? "")
        && (database === "main" || (database === null && arg2 === ""))) return sqlite.SQLITE_OK;
      if (action === sqlite.SQLITE_FUNCTION && functions.has(arg2?.toLowerCase() ?? "")) return sqlite.SQLITE_OK;
      return sqlite.SQLITE_DENY;
    });
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    run(input: unknown) {
      const sql = readQuery(input).sql.trim();
      // Node prepares only the first statement; sourceSQL is the prefix SQLite consumed.
      // A trailing semicolon is fine, but comments AFTER it (or any other non-space tail) are rejected.
      try {
        if (!sql || sql.includes("\0")) throw new Error("Enter one SQL query");
        const stmt = db.prepare(sql);
        if (stmt.sourceSQL !== sql) throw new Error("Use one query; remove anything after the final semicolon");
        const columns = stmt.columns().map(column => column.name);
        if (!columns.length) throw new Error("The query must return columns");
        const rows: ReturnType<typeof jsonCell>[][] = [];
        let bytes = Buffer.byteLength(JSON.stringify(columns)) + 64; // envelope, punctuation and truncation flag
        if (bytes > queryByteLimit) throw new Error("Column names are too large; use shorter aliases");
        let truncated = false;
        for (const row of stmt.iterate() as unknown as Iterable<SQLOutputValue[]>) {
          if (rows.length === queryRowLimit) {
            truncated = true;
            break;
          }
          const cells = row.map(jsonCell);
          bytes += Buffer.byteLength(JSON.stringify(cells)) + 1;
          if (bytes > queryByteLimit) {
            truncated = true;
            break;
          }
          rows.push(cells);
        }
        return { columns, rows, truncated };
      } catch (error) {
        throw new GymInputError(`Gym query failed: ${error instanceof Error ? error.message : String(error)}. Run one SELECT on workouts, sets or plan.`);
      }
    },
    close: () => db.close(),
  };
}

import { test, expect } from "bun:test";
import { SQL_COLUMNS } from "@lllogs/shared";
import { SCHEMA_SQL } from "./schema";

// Drift guard: the SQL editor's column reference / autocomplete is driven by
// SQL_COLUMNS in @lllogs/shared. Those names can't be derived from the DDL (it's
// a raw SQL string with no descriptions), so this test keeps the two in lockstep
// — if a column is added/removed/renamed on the `event` table, this fails until
// SQL_COLUMNS is updated to match.

/** Parse the column names declared in the `event` CREATE TABLE block. */
function eventTableColumns(ddl: string): string[] {
  const start = ddl.indexOf("CREATE TABLE IF NOT EXISTS event (");
  expect(start).toBeGreaterThanOrEqual(0);
  const open = ddl.indexOf("(", start);
  // Walk to the matching close paren of the table body.
  let depth = 0;
  let end = -1;
  for (let i = open; i < ddl.length; i++) {
    if (ddl[i] === "(") depth++;
    else if (ddl[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(open);
  const body = ddl.slice(open + 1, end);

  const cols: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/--.*$/, "").trim();
    if (!line) continue;
    const first = line.split(/[\s(]/)[0] ?? "";
    // Skip table constraints (UNIQUE/PRIMARY/FOREIGN/CHECK/CONSTRAINT).
    if (
      /^[a-z_]+$/.test(first) &&
      !["unique", "primary", "foreign", "check", "constraint"].includes(first)
    ) {
      cols.push(first);
    }
  }
  return cols;
}

test("SQL_COLUMNS matches the event-table DDL exactly (name + order)", () => {
  const ddlCols = eventTableColumns(SCHEMA_SQL);
  const manifestCols = SQL_COLUMNS.map((c) => c.name);
  expect(manifestCols).toEqual(ddlCols);
});

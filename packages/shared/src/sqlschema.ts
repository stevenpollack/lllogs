// The query surface exposed to user SQL (POST /api/query).
//
// User SQL runs against a single relation, `events`, which the analytics CTE
// resolves to `SELECT * FROM live.event <facet WHERE>` (see analytics/duck.ts
// buildQuery). So `events` has exactly the snake_case columns of the `event`
// table. This manifest is the machine-readable description of that surface; it
// drives the SQL editor's autocomplete and column reference in the web UI.
//
// DRY note: the column *names/types* duplicate the DDL in
// `@clogdy/ingest`'s schema.ts. They can't be derived from it (the DDL is a raw
// SQL string and carries no human descriptions), so `schema.test.ts` in ingest
// asserts this list stays in sync with the `event` table columns.

export interface SqlColumn {
  /** snake_case column name, exactly as the user's SQL must reference it. */
  name: string;
  /** SQL type label (informational). */
  type: "INTEGER" | "TEXT";
  /** One-line human description shown in autocomplete + the column reference. */
  desc: string;
}

/** The single relation user SQL selects from (the facet-scoped CTE). */
export const SQL_RELATION = "events";

/** Columns of `events`, in DDL order. Single source of truth for editor hints. */
export const SQL_COLUMNS: readonly SqlColumn[] = [
  { name: "id", type: "INTEGER", desc: "Row id (= rowid); the keyset/live cursor." },
  { name: "uuid", type: "TEXT", desc: "Transcript line uuid." },
  { name: "block_idx", type: "INTEGER", desc: "Content-block index within the line." },
  { name: "parent_uuid", type: "TEXT", desc: "uuid of the parent transcript line." },
  { name: "session_id", type: "TEXT", desc: "Claude Code session id." },
  { name: "project", type: "TEXT", desc: "Project slug (denormalized for GROUP BY)." },
  { name: "ts", type: "INTEGER", desc: "Event time, milliseconds since epoch." },
  {
    name: "kind",
    type: "TEXT",
    desc: "Block kind: prompt | text | thinking | tool_use | tool_result.",
  },
  { name: "role", type: "TEXT", desc: "Message author role: user | assistant; NULL if absent." },
  { name: "tool", type: "TEXT", desc: "Tool name on tool_use/tool_result rows; NULL otherwise." },
  { name: "command", type: "TEXT", desc: "Primary tool arg (e.g. the bash command)." },
  { name: "corr", type: "TEXT", desc: "Correlation id linking a tool_use to its tool_result." },
  { name: "is_error", type: "INTEGER", desc: "1 if the tool_result is an error, else 0/NULL." },
  { name: "input_json", type: "TEXT", desc: "Full tool input as compact JSON." },
  { name: "result", type: "TEXT", desc: "tool_result text / Bash stdout." },
  { name: "stderr", type: "TEXT", desc: "Bash stderr." },
  { name: "diff", type: "TEXT", desc: "Unified diff for edit tools." },
  { name: "result_head", type: "TEXT", desc: "One-line result summary." },
  { name: "text", type: "TEXT", desc: "Prompt / assistant text / thinking content." },
  { name: "dur_ms", type: "INTEGER", desc: "Duration ms — always NULL (not backfilled)." },
  { name: "git_branch", type: "TEXT", desc: "Git branch at event time." },
  { name: "raw", type: "TEXT", desc: "Verbatim original JSONL line." },
];

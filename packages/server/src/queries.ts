import type { Database } from "bun:sqlite";
import type { EventFilter, EventRow, FacetBucket, Facets } from "@clogdy/shared";
import { asArray } from "@clogdy/shared";

type SqlValue = string | number | null;

/** A single WHERE condition contributed by one filter dimension. */
interface Cond {
  /** The facet dimension this condition belongs to (so facets can drop their own). */
  dim: "project" | "session" | "tool" | "kind" | "role" | "error" | "other";
  sql: string;
  params: SqlValue[];
}

/** `col = ?` for one value, `col IN (?, …)` for many. Empty array → no condition. */
function inOrEq(col: string, vals: SqlValue[]): { sql: string; params: SqlValue[] } | null {
  if (vals.length === 0) return null;
  if (vals.length === 1) return { sql: `${col} = ?`, params: vals };
  return { sql: `${col} IN (${vals.map(() => "?").join(", ")})`, params: vals };
}

/** Build the list of conditions from a filter (no `afterId`/`limit` — those are query-shaping). */
function buildConds(f: EventFilter): Cond[] {
  const conds: Cond[] = [];
  const add = (dim: Cond["dim"], col: string, vals: SqlValue[]): void => {
    const c = inOrEq(col, vals);
    if (c) conds.push({ dim, ...c });
  };
  add("project", "project", asArray(f.project));
  add("session", "session_id", asArray(f.session));
  add("tool", "tool", asArray(f.tool));
  add("kind", "kind", asArray(f.kind));
  add("role", "role", asArray(f.role));
  add(
    "error",
    "is_error",
    asArray(f.error).map((e) => (e === "error" ? 1 : 0)),
  );
  if (f.corr !== undefined) conds.push({ dim: "other", sql: "corr = ?", params: [f.corr] });
  if (f.since !== undefined) conds.push({ dim: "other", sql: "ts >= ?", params: [f.since] });
  if (f.until !== undefined) conds.push({ dim: "other", sql: "ts < ?", params: [f.until] });
  if (f.q !== undefined) {
    // MVP: no LIKE escaping of % / _ (documented).
    const like = `%${f.q}%`;
    conds.push({
      dim: "other",
      sql: "(command LIKE ? OR text LIKE ? OR result LIKE ?)",
      params: [like, like, like],
    });
  }
  return conds;
}

/** Compose conditions into a `WHERE …` clause + flat params, excluding one dimension. */
function whereFrom(conds: Cond[], exclude?: Cond["dim"]): { clause: string; params: SqlValue[] } {
  const used = exclude ? conds.filter((c) => c.dim !== exclude) : conds;
  if (used.length === 0) return { clause: "", params: [] };
  return {
    clause: "WHERE " + used.map((c) => c.sql).join(" AND "),
    params: used.flatMap((c) => c.params),
  };
}

function rowToEvent(r: Record<string, unknown>): EventRow {
  const isErrRaw = r.is_error as number | null;
  return {
    id: r.id as number,
    uuid: r.uuid as string,
    blockIdx: r.block_idx as number,
    parentUuid: (r.parent_uuid as string | null) ?? null,
    sessionId: r.session_id as string,
    project: r.project as string,
    cwd: (r.cwd as string | null) ?? null,
    ts: r.ts as number,
    kind: r.kind as EventRow["kind"],
    role: (r.role as string | null) ?? null,
    tool: (r.tool as string | null) ?? null,
    command: (r.command as string | null) ?? null,
    corr: (r.corr as string | null) ?? null,
    isError: isErrRaw === null ? null : isErrRaw === 1,
    inputJson: (r.input_json as string | null) ?? null,
    result: (r.result as string | null) ?? null,
    stderr: (r.stderr as string | null) ?? null,
    diff: (r.diff as string | null) ?? null,
    resultHead: (r.result_head as string | null) ?? null,
    text: (r.text as string | null) ?? null,
    durMs: (r.dur_ms as number | null) ?? null,
    gitBranch: (r.git_branch as string | null) ?? null,
    raw: r.raw as string,
  };
}

export function queryEvents(
  db: Database,
  f: EventFilter,
): { rows: EventRow[]; nextAfterId: number | null } {
  const conds = buildConds(f);
  if (f.afterId !== undefined) conds.push({ dim: "other", sql: "id > ?", params: [f.afterId] });
  const { clause, params } = whereFrom(conds);
  const limit = Math.min(f.limit ?? 200, 2000);
  const sql = `SELECT * FROM event ${clause} ORDER BY id ASC LIMIT ?`;
  const dbRows = db.query(sql).all(...params, limit) as Record<string, unknown>[];
  const rows = dbRows.map(rowToEvent);
  const nextAfterId = rows.length === limit && rows.length > 0 ? rows[rows.length - 1]!.id : null;
  return { rows, nextAfterId };
}

/**
 * The most recent `limit` events matching the filter, returned ASCENDING by id
 * (so a live tail can append newer rows after them). `prevBeforeId` is the
 * smallest id returned — the cursor for paging OLDER — or null when fewer than a
 * full page matched. Ignores `afterId` (latest is anchored at the end, not a
 * keyset cursor). The live-monitor TUI uses this for its initial "newest" load.
 */
export function queryLatest(
  db: Database,
  f: EventFilter,
): { rows: EventRow[]; prevBeforeId: number | null } {
  const conds = buildConds(f);
  const { clause, params } = whereFrom(conds);
  const limit = Math.min(f.limit ?? 200, 2000);
  const sql = `SELECT * FROM event ${clause} ORDER BY id DESC LIMIT ?`;
  const dbRows = db.query(sql).all(...params, limit) as Record<string, unknown>[];
  const rows = dbRows.map(rowToEvent).reverse();
  const prevBeforeId = rows.length === limit && rows.length > 0 ? rows[0]!.id : null;
  return { rows, prevBeforeId };
}

const FACET_DIMS = ["project", "session", "tool", "kind", "role", "error"] as const;

export function queryFacets(db: Database, f: EventFilter): Facets {
  const conds = buildConds(f);
  const out: Facets = { project: [], session: [], tool: [], kind: [], role: [], error: [] };

  for (const dim of FACET_DIMS) {
    // The DB column / value expression for this dimension.
    let valueExpr: string;
    let notNullCol: string;
    if (dim === "session") {
      valueExpr = "session_id";
      notNullCol = "session_id";
    } else if (dim === "error") {
      valueExpr = "CASE is_error WHEN 1 THEN 'error' WHEN 0 THEN 'ok' END";
      notNullCol = "is_error";
    } else {
      valueExpr = dim;
      notNullCol = dim;
    }

    const { clause, params } = whereFrom(conds, dim);
    const where = clause
      ? `${clause} AND ${notNullCol} IS NOT NULL`
      : `WHERE ${notNullCol} IS NOT NULL`;
    const sql = `SELECT ${valueExpr} AS value, COUNT(*) AS count FROM event ${where} GROUP BY value ORDER BY count DESC LIMIT 200`;
    const rows = db.query(sql).all(...params) as { value: string; count: number }[];
    out[dim] = rows.map((r): FacetBucket => ({ value: r.value, count: r.count }));
  }

  return out;
}

export function expandSession(db: Database, shortOrFull: string): string | null {
  if (shortOrFull.length >= 32) {
    const hit = db
      .query("SELECT session_id FROM session WHERE session_id = ?")
      .get(shortOrFull) as { session_id: string } | null;
    return hit ? hit.session_id : null;
  }
  const rows = db
    .query("SELECT session_id FROM session WHERE session_id LIKE ? LIMIT 2")
    .all(`${shortOrFull}%`) as { session_id: string }[];
  return rows.length === 1 ? rows[0]!.session_id : null;
}

export function maxEventId(db: Database): number {
  const row = db.query("SELECT COALESCE(MAX(id),0) AS m FROM event").get() as { m: number };
  return row.m;
}

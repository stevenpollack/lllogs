import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Logger } from "pino";
import type { EventFilter } from "@clogdy/shared";
import { asArray, assertSelectOnly, stripSqlComments } from "@clogdy/shared";

/**
 * The value types we bind as DuckDB positional parameters. DuckDB's `run(sql,
 * values)` API accepts `DuckDBValue[] | Record<string,DuckDBValue>` — plain
 * `string | number | null` are valid DuckDBValue members, so this narrower type
 * satisfies the runtime signature without importing the full DuckDBValue union.
 */
type ParamValue = string | number | null;

/**
 * Build a `WHERE …` clause from an EventFilter, column-mapped exactly like the
 * server's queries.ts buildConds.
 *
 * Values are returned as positional DuckDB parameters ($1, $2, …) so no filter
 * value is ever string-concatenated into SQL (defense-in-depth: the q LIKE
 * pattern and string fields like project/session/tool can no longer be injection
 * vectors even if the caller misbehaves).
 *
 * When `alias` is given (e.g. "u"), every column is prefixed: `u.tool = $1`.
 * Ignores afterId/limit (irrelevant to analytics).
 *
 * The returned `params` array is aligned to the $N positions in `sql`; pass
 * both to `conn.runAndReadAll(sql, params)`.
 */
export function buildWhere(f: EventFilter, alias?: string): { sql: string; params: ParamValue[] } {
  const p = alias ? `${alias}.` : "";
  const conds: string[] = [];
  const params: ParamValue[] = [];

  function add(makeCond: (n: number) => string, val: ParamValue): void {
    params.push(val);
    conds.push(makeCond(params.length));
  }

  // One value → `col = $n`; many → `col IN ($a, $b, …)`. Empty → no condition.
  function addIn(col: string, vals: ParamValue[]): void {
    if (vals.length === 0) return;
    const ph = vals.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    conds.push(vals.length === 1 ? `${p}${col} = ${ph[0]}` : `${p}${col} IN (${ph.join(", ")})`);
  }

  addIn("project", asArray(f.project));
  addIn("session_id", asArray(f.session));
  addIn("tool", asArray(f.tool));
  addIn("kind", asArray(f.kind));
  addIn("role", asArray(f.role));
  addIn(
    "is_error",
    asArray(f.error).map((e) => (e === "error" ? 1 : 0)),
  );
  if (f.corr !== undefined) add((n) => `${p}corr = $${n}`, f.corr);
  if (f.since !== undefined) add((n) => `${p}ts >= $${n}`, Number(f.since));
  if (f.until !== undefined) add((n) => `${p}ts < $${n}`, Number(f.until));
  if (f.q !== undefined) {
    // Reference the same $N three times — DuckDB positional params allow
    // repeated use of the same index.
    add(
      (n) => `(${p}command LIKE $${n} OR ${p}text LIKE $${n} OR ${p}result LIKE $${n})`,
      `%${f.q}%`,
    );
  }

  return {
    sql: conds.length === 0 ? "" : `WHERE ${conds.join(" AND ")}`,
    params,
  };
}

/** Append an extra condition to a `WHERE …`/"" clause. */
function and(where: string, cond: string): string {
  return where === "" ? `WHERE ${cond}` : `${where} AND ${cond}`;
}

/** DuckDB COUNT/SUM come back as BigInt; coerce to a JS number. */
function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

/** Single-quote-escape a string for safe inlining into SQL ('… '' …'). */
function sq(v: string): string {
  return v.replace(/'/g, "''");
}

/**
 * Open an in-memory DuckDB, ATTACH the SQLite DB at `dbPath` READ_ONLY as `live`,
 * run `fn(conn)`, then always DETACH and close. READ_ONLY is non-negotiable.
 */
export async function withDuck<T>(
  dbPath: string,
  fn: (conn: DuckDBConnection) => Promise<T>,
  log?: Logger,
): Promise<T> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  let attached = false;
  try {
    await conn.run("INSTALL sqlite; LOAD sqlite;");
    await conn.run(`ATTACH '${sq(dbPath)}' AS live (TYPE sqlite, READ_ONLY);`);
    attached = true;
    // Evidence for ground rule #4 (DuckDB always attaches READ_ONLY).
    log?.debug({ evt: "analytics.attach", readOnly: true });
    // PRIMARY security boundary: after the read-only ATTACH, disable DuckDB's
    // filesystem/network access (read_text/read_csv/glob/parquet, further ATTACH,
    // COPY, INSTALL, httpfs) and lock the config so user SQL cannot re-enable it.
    // Querying the already-attached read-only catalog still works. This makes the
    // assertSelectOnly keyword denylist defense-in-depth rather than load-bearing.
    await conn.run("SET enable_external_access=false;");
    await conn.run("SET lock_configuration=true;");
    return await fn(conn);
  } finally {
    if (attached) {
      try {
        await conn.run("DETACH live;");
      } catch {
        // best-effort detach
      }
    }
    conn.closeSync();
    instance.closeSync();
  }
}

/**
 * Fetch result rows as plain objects (DuckDBValue values; cast at the call site).
 * `params` are positional bound parameters ($1, $2, …) for the SQL statement.
 */
async function rows(
  conn: DuckDBConnection,
  sql: string,
  params?: ParamValue[],
): Promise<Record<string, unknown>[]> {
  const reader = await conn.runAndReadAll(sql, params);
  return reader.getRowObjects();
}

export async function toolCounts(
  conn: DuckDBConnection,
  filter: EventFilter,
): Promise<Array<{ tool: string; count: number }>> {
  const { sql: whereSql, params } = buildWhere(filter);
  const where = and(whereSql, "tool IS NOT NULL");
  const sql = `SELECT tool, COUNT(*) c FROM live.event ${where} GROUP BY tool ORDER BY c DESC`;
  const data = await rows(conn, sql, params);
  return data.map((r) => ({ tool: String(r.tool), count: num(r.c) }));
}

export async function errorRate(
  conn: DuckDBConnection,
  filter: EventFilter,
): Promise<{ total: number; errors: number; rate: number }> {
  const { sql: whereSql, params } = buildWhere(filter);
  const where = and(whereSql, "kind = 'tool_result'");
  const sql = `SELECT COUNT(*) total, COALESCE(SUM(is_error),0) errors FROM live.event ${where}`;
  const [r] = await rows(conn, sql, params);
  const total = num(r?.total);
  const errors = num(r?.errors);
  return { total, errors, rate: total === 0 ? 0 : errors / total };
}

export async function latency(
  conn: DuckDBConnection,
  filter: EventFilter,
): Promise<Array<{ tool: string; p50: number; p95: number; n: number }>> {
  // The join pins both kinds, so a `kind` filter is meaningless here — drop it
  // before building the u-side WHERE (D-3.c).
  const { kind: _kind, ...rest } = filter;
  const { sql: where, params } = buildWhere(rest, "u");
  const sql = `SELECT u.tool tool,
      quantile_cont(r.ts - u.ts, 0.5) p50,
      quantile_cont(r.ts - u.ts, 0.95) p95,
      COUNT(*) n
    FROM live.event u
    JOIN live.event r
      ON r.corr = u.corr AND u.kind = 'tool_use' AND r.kind = 'tool_result'
    ${where}
    GROUP BY u.tool
    ORDER BY n DESC`;
  const data = await rows(conn, sql, params);
  return data.map((r) => ({
    tool: String(r.tool),
    p50: Number(r.p50),
    p95: Number(r.p95),
    n: num(r.n),
  }));
}

export async function projectRollup(
  conn: DuckDBConnection,
  filter: EventFilter,
): Promise<Array<{ project: string; events: number; tool_calls: number; errors: number }>> {
  const { sql: where, params } = buildWhere(filter);
  const sql = `SELECT project,
      COUNT(*) events,
      SUM(CASE WHEN kind = 'tool_use' THEN 1 ELSE 0 END) tool_calls,
      COALESCE(SUM(is_error),0) errors
    FROM live.event ${where}
    GROUP BY project ORDER BY events DESC`;
  const data = await rows(conn, sql, params);
  return data.map((r) => ({
    project: String(r.project),
    events: num(r.events),
    tool_calls: num(r.tool_calls),
    errors: num(r.errors),
  }));
}

export async function timeBuckets(
  conn: DuckDBConnection,
  filter: EventFilter,
): Promise<Array<{ bucket: number; count: number }>> {
  const { sql: where, params } = buildWhere(filter);
  // Integer floor to the hour. NB: DuckDB's `/` is TRUE division (returns DOUBLE,
  // so `(ts/3600000)*3600000` round-trips back to ~ts and does NOT floor). The
  // floor-division operator is `//`, which on BIGINT floors and returns BIGINT.
  const sql = `SELECT (CAST(ts AS BIGINT) // 3600000) * 3600000 AS bucket, COUNT(*) count
    FROM live.event ${where}
    GROUP BY bucket ORDER BY bucket`;
  const data = await rows(conn, sql, params);
  return data.map((r) => ({ bucket: num(r.bucket), count: num(r.count) }));
}

/** The five metric names and their query functions. */
export const METRICS = {
  toolCounts,
  errorRate,
  latency,
  projectRollup,
  timeBuckets,
} as const;

export type MetricName = keyof typeof METRICS;

export function isMetricName(name: string): name is MetricName {
  return name in METRICS;
}

/** Dispatch a metric by name. */
export function runMetric(
  conn: DuckDBConnection,
  name: MetricName,
  filter: EventFilter,
): Promise<unknown> {
  return METRICS[name](conn, filter);
}

/**
 * Build the facet-scoped CTE wrapper around user SQL, as specified in CONTRACTS §6 / PHASE5:
 *
 *   WITH events AS (
 *     SELECT * FROM live.event <buildWhere(filter)>
 *   )
 *   SELECT * FROM ( <USER SQL> )
 *   LIMIT <cap + 1>;
 *
 * The outer LIMIT cap+1 lets the caller detect truncation (Datasette pattern).
 * The user writes FROM events; the CTE resolves it to the facet-filtered set.
 *
 * Returns `{ sql, params }` — pass both to `conn.runAndReadAll(sql, params)` so
 * the positional $N parameters in the WHERE clause are bound, not inlined.
 */
export function buildQuery(
  userSql: string,
  filter: EventFilter,
  cap: number,
): { sql: string; params: ParamValue[] } {
  const { sql: where, params } = buildWhere(filter);
  const cteBody = where ? `SELECT * FROM live.event ${where}` : `SELECT * FROM live.event`;
  // Normalize the user SQL to exactly what is safe to embed in the subquery:
  // strip comments (so a trailing `--`/`/* */` can't swallow the wrapper's
  // closing `)\nLIMIT …`) and drop a trailing `;` (which assertSelectOnly
  // tolerates but which would be a syntax error inside `SELECT * FROM ( … )`).
  const inner = stripSqlComments(userSql).replace(/;\s*$/, "").trim();
  const sql = `WITH events AS (\n  ${cteBody}\n)\nSELECT * FROM (\n  ${inner}\n)\nLIMIT ${cap + 1};`;
  return { sql, params };
}

/**
 * Run a user SQL query through the facet CTE wrapper and return a structured result.
 *
 * - Guards user SQL with assertSelectOnly first (throws on violation).
 * - Wraps it via buildQuery (facet CTE, cap+1 sentinel).
 * - Binds facet-filter values as positional DuckDB parameters ($1, $2, …) so no
 *   filter value is string-concatenated into SQL.
 * - Reads columns from reader.columnNames() (ordered).
 * - Reads rows as JSON-compatible value arrays via reader.getRowsJson().
 * - Sets truncated=true and slices to cap if row count > cap.
 *
 * Takes an open DuckDBConnection (from withDuck); caller is responsible for lifecycle.
 */
export async function runQuery(
  conn: DuckDBConnection,
  userSql: string,
  filter: EventFilter,
  cap: number,
): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
  assertSelectOnly(userSql);
  const { sql, params } = buildQuery(userSql, filter, cap);
  const reader = await conn.runAndReadAll(sql, params);
  const columns = reader.columnNames();
  const rawRows = reader.getRowsJson();
  const truncated = rawRows.length > cap;
  const outRows: unknown[][] = truncated ? rawRows.slice(0, cap) : rawRows;
  return { columns, rows: outRows, truncated };
}

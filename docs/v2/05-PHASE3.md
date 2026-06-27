# Phase 3 — DuckDB analytics

Goal: heavy aggregation (per-tool counts, error rates, latency p50/p95, per-project rollups, time
buckets) via DuckDB attached **read-only** to the live SQLite DB, in a **separate process** the server
shells out to (ground rule #3). Builds on Phase 1/2. Gate: T-3.4 green.

The verified rule (REFERENCE-design.md §1): DuckDB links the real SQLite lib, so `ATTACH … (TYPE
sqlite, READ_ONLY)` reads the live WAL DB concurrently with the ingester writer — **provided** DuckDB is
its own process and attaches READ_ONLY. The server uses `bun:sqlite`; it must **never** load DuckDB.
Hence analytics is a CLI subprocess.

---

## T-3.1 — `@clogdy/analytics`: DuckDB query CLI (PG0, needs 1.1)

**Files:** `packages/analytics/src/duck.ts` (connection + metric queries), `packages/analytics/src/query.ts`
(CLI), `packages/analytics/src/duck.test.ts`.

**Spec:**
- Use `@duckdb/node-api`. `withDuck(dbPath, fn)`: create instance/connection; `INSTALL sqlite; LOAD
  sqlite;`; `ATTACH '<dbPath>' AS live (TYPE sqlite, READ_ONLY);`; run `fn(conn)`; `DETACH live`; close.
  (Single-host, READ_ONLY — never writable.)
- Metric functions, each `(conn, filter: EventFilter) => Promise<data>`. Build a shared SQL `WHERE` from
  the filter (same columns as the server's query layer; reuse the same param semantics — you may port a
  small `buildWhere` into analytics to avoid cross-process coupling). Query `live.event`.
  - `toolCounts` → `[{tool, count}]`: `SELECT tool, COUNT(*) c FROM live.event WHERE tool IS NOT NULL <and filters> GROUP BY tool ORDER BY c DESC`.
  - `errorRate` → `{ total, errors, rate }` over `kind='tool_result'` rows (`errors = SUM(is_error)`).
  - `latency` → `[{tool, p50, p95, n}]`: latency = `result.ts - tooluse.ts` joined on `corr`. SQL: a
    self-join `live.event u JOIN live.event r ON r.corr=u.corr AND u.kind='tool_use' AND r.kind='tool_result'`,
    `latency_ms = r.ts - u.ts`; per `u.tool` compute `quantile_cont(latency_ms, 0.5)` and `0.95`, `COUNT(*)`.
    (DuckDB has `quantile_cont`/`quantile_disc`.) Apply filters to `u`.
  - `projectRollup` → `[{project, events, tool_calls, errors}]`: GROUP BY project.
  - `timeBuckets` → `[{bucket /*ms epoch, hour-floored*/, count}]`: `SELECT (ts // 3600000) * 3600000 AS bucket, COUNT(*) … GROUP BY bucket ORDER BY bucket`. **Use DuckDB floor-division `//`** — DuckDB `/` is true (float) division, so `(ts/3600000)*3600000` round-trips back to ≈ts (one bucket per row). (D-3.d)
- `query.ts` CLI per CONTRACTS §7: `--db <path> --metric <name> [--filters '<json>']` → prints
  `JSON.stringify({metric, data})` to stdout, exit 0; unknown metric / DuckDB error → stderr + exit 1.

**Tests (`duck.test.ts`):** build a small SQLite DB (via ingest `openDb`+writer) with a known set incl. a
tool_use/result pair with known ts gap; run each metric via `withDuck`; assert `toolCounts`/`errorRate`/
`projectRollup` match hand-computed values and `latency` returns the expected p50 for the single pair.
(This test loads DuckDB — that's fine, it's the analytics process; it must NOT import `bun:sqlite` for
the DuckDB side, but the test may use `bun:sqlite` to *build the fixture* in a separate step before
opening DuckDB — keep them sequential, not concurrent handles in the same statement. If even that trips
the double-link warning in-process, build the fixture in a tiny `Bun.spawn`'d helper or via the ingest
CLI, then run DuckDB. Prefer: build fixture by shelling `v2:ingest --backfill` on a temp tree, then run
DuckDB in the test process.)

> **Important for the agent:** if `bun:sqlite` and `@duckdb/node-api` loaded in the *same test process*
> throws the multiple-SQLite-link error, that's ground rule #3 biting in a test. Resolve by generating
> the fixture DB via `Bun.spawnSync(["bun","run","v2:ingest","--backfill","--root",tmpTree,"--db",tmpDb])`
> (separate process) and then only opening DuckDB in the test process. Document which approach you used.

**Acceptance:** `bun test packages/analytics/src/duck.test.ts` green; `bun run check` green; manual:
`bun run v2:analytics -- --db /tmp/clogdy-smoke.db --metric toolCounts` prints JSON.

---

## T-3.2 — server: `/api/stats` proxy → spawn analytics CLI (PG1, needs 3.1, 1.6)

**Files:** edit `packages/server/src/app.ts` (replace 501 stub); add `packages/server/src/stats.test.ts`.

**Spec:** `GET /api/stats?metric=<name>&<filter params>` → validate `metric` ∈ the five names (else 400);
spawn the analytics CLI: `Bun.spawn(["bun","run","v2:analytics","--","--db", dbPath, "--metric", metric, "--filters", JSON.stringify(filter)], {cwd: repoRoot, stdout:"pipe", stderr:"pipe"})`; await; on exit 0
parse stdout JSON and return it; on nonzero return 500 `{error: stderr}`. `dbPath` = the path the server
opened (track it). Add a short timeout (e.g. 20s) → 504 on overrun. **No DuckDB import in the server** —
it only spawns the CLI (ground rule #3).

**Tests (`stats.test.ts`):** against a smoke DB built via the ingest CLI (separate process), call
`app.request("/api/stats?metric=toolCounts")` and assert 200 + the JSON matches a direct
`Bun.spawnSync` of the analytics CLI; assert an unknown metric → 400. (This test process uses
`bun:sqlite` via the server but spawns DuckDB as a child — compliant.)

**Acceptance:** `bun test packages/server/src/stats.test.ts` green; `bun run check` green.

---

## T-3.3 — web: analytics view (PG2, needs 3.2, 1.7)

**Files:** edit `packages/web/src/main.ts`, `api.ts`, `index.html`; add `packages/web/src/charts.ts`.

**Spec:** an **Analytics** tab. `api.ts`: `getStats(metric, filter)`. Render (respecting the active
filter): a tool-counts bar list, an error-rate gauge/number, a latency table (tool, p50, p95, n), a
project rollup table, and a simple time-buckets sparkline/bar (plain SVG or divs — no chart dep).
Keep it dependency-free; tiny SVG helpers in `charts.ts`. Refresh on filter change.

**Acceptance:** `bun run v2:web:build` ok; `bun run check` green; manual: the Analytics tab shows correct
aggregates vs the smoke DB.

---

## T-3.4 — e2e: stats correctness (PG2, needs 3.2)

**Files:** `packages/server/src/e2e-stats.test.ts`.

**Spec:** build a fixture DB (ingest CLI on a known tree, separate process); for each metric, call
`/api/stats` via `app.request` and assert the JSON equals hand-computed expectations (esp. `errorRate`
and a `latency` p50 from a known ts gap).

**Acceptance:** green → **Phase 3 gate** commit `feat(v2): DuckDB analytics — read-only ATTACH stats via CLI proxy`.

### Dispatch: PG0 {T-3.1} → PG1 {T-3.2} → PG2 {T-3.3, T-3.4} ∥.

# Next-iteration architecture: Claude Code tool-usage investigator + monitor

**Status:** design proposal, research only. No repo files changed; nothing committed.
**Date:** 2026-06-25.

---

## 0. Executive summary (the recommendation)

Replace Logdy with a small, self-contained pipeline we own end to end:

1. **Source of truth stays the JSONL transcripts** under `~/.claude/projects`. They are append-only and already durable — we never need our store to *be* the truth, only a fast index.
2. **One ingester process** owns writes. It reuses `follow.ts`'s polling offset-tailer, runs each line through a hardened port of `flatten.ts`, and does **batched INSERTs (every ~250–500 ms or N lines) into a single SQLite database in WAL mode**. One event row per content block.
3. **SQLite WAL is the live store.** It gives us exactly what Logdy couldn't: the full corpus on disk, real indexes, server-side `GROUP BY`, and—crucially—**many concurrent readers alongside the one writer** without blocking.
4. **DuckDB is the analytics engine, used read-only.** For heavy whole-corpus aggregation we either `ATTACH` the SQLite file `(TYPE sqlite, READ_ONLY)` or, for the largest historical sweeps, scan the JSONL tree directly with `read_json_auto`. DuckDB is *not* in the write path and never holds the SQLite lock for writes.
5. **UI = a bespoke small local web app** (Bun/Hono HTTP server + a thin SPA). Two views over the same store: a **filterable past-investigation table** (paged SQL queries with facet sidebars that are now *accurate* because they're computed server-side over the whole corpus) and a **live aggregate dashboard** (per-tool counts, error rate, latency) that **polls `WHERE rowid > :last`** every ~1 s. The existing **`@clogdy/tui` Ink picker** becomes the scope selector (which projects/sessions to load) and an optional terminal-native live view.
6. **MVP slice:** ingester + SQLite schema + one read-only HTTP endpoint + a flat HTML table with facets. That alone beats Logdy on the two things that hurt most (no backlog cap, accurate facets). DuckDB and live dashboards layer on after.

This is more moving parts than "DuckDB scans JSONL on every refresh," and that simpler alternative is genuinely viable for a single-user tool (see §7). The SQLite layer earns its keep only because of **real-time monitoring** (concurrent reader+writer, cheap incremental `rowid` polling) and **indexed point lookups** (jump to one session/correlation). If live monitoring were dropped, I'd drop SQLite too.

---

## 1. Verified linchpin: DuckDB ATTACH over a live SQLite WAL database

This was the central thing to confirm. **The answer is yes, with caveats — and the caveats decide the design.**

**What DuckDB actually does.** DuckDB's SQLite support (`ATTACH 'x.db' (TYPE sqlite)`, formerly the `sqlite_scanner` extension) does **not** reimplement SQLite — it links and calls **the real SQLite library** to read the file. Therefore *SQLite's own concurrency rules apply*, not DuckDB's. From the DuckDB SQLite docs: "DuckDB can read or modify a SQLite database while DuckDB or SQLite reads or modifies the same database from a different thread or a separate process. **Only a single thread or process can write to the database at one time**; multiple can read at the same time." And: "Database locking is handled by the SQLite library, not DuckDB… from different processes, SQLite uses file system locks… the locking mechanisms also depend on SQLite configuration, like WAL mode."

**So the linchpin holds:** because our ingester writes the SQLite file in WAL mode, and DuckDB reads it through the SQLite library, **DuckDB-as-reader does not block the ingester-as-writer and vice versa** — that is precisely the WAL guarantee ("readers do not block writers and a writer does not block readers; reading and writing can proceed concurrently"). DuckDB sees a consistent snapshot as of its read transaction.

**Caveat 1 — open DuckDB's attachment READ_ONLY.** Attached SQLite databases are read/write by default, and a second *writer* will collide with the ingester (SQLITE_BUSY / "attempt to write a readonly database"). Always attach for analytics as:
```sql
ATTACH 'transcripts.db' AS live (TYPE sqlite, READ_ONLY);
```
This guarantees DuckDB only ever takes read locks and can never contend with the ingester for the write lock.

**Caveat 2 — same process is the danger zone, not separate processes.** The documented breakage (duckdb/duckdb-sqlite issue #82: concurrent-access and "attempt to write a readonly database" errors, plus the DuckDB docs' warning that "linking multiple copies of the SQLite library into the same application can lead to application errors") happens when **two copies of the SQLite library live in one process** — e.g. embedding both DuckDB-with-its-SQLite and a separate SQLite driver in the same Node/Bun process. **Our design sidesteps this entirely by keeping the writer (ingester, using Bun's `bun:sqlite`) and the reader (DuckDB) in *separate processes*.** Separate-process access is the well-supported path; same-process double-linking is the one to avoid.

**Caveat 3 — WAL read-only access needs write permission on the *directory*.** A subtle SQLite rule (sqlite.org/wal.html): a read-only connection to a WAL database still must create or read the `-shm` (shared-memory index) and `-wal` files. "The opening process must have write privileges for the `-shm` shared memory file." In practice this is a non-issue for us — the ingester is always running and has already created `-shm`/`-wal`, and everything is one user's `$HOME` — but it means you cannot point DuckDB at a WAL SQLite file on a truly read-only filesystem with no live writer. (If we ever need that, checkpoint + `PRAGMA journal_mode=DELETE` a snapshot copy, or just scan the JSONL.)

**Caveat 4 — WAL is single-host only.** "All processes using a database must be on the same host computer; WAL does not work over a network filesystem" (it relies on shared memory). Fine for a local-only tool; rules out putting the `.db` on NFS/SMB.

**SQLite WAL concurrency, confirmed.** Multiple reader processes + exactly one writer process, concurrently, on one host, with snapshot isolation per reader. Only one writer ever (one WAL file) — irrelevant to us since we deliberately have exactly one ingester. Checkpoint starvation is the one operational watch-item: if a long-lived reader never releases, the WAL grows unbounded; mitigate with periodic `PRAGMA wal_checkpoint(TRUNCATE)` from the ingester and avoid leaving an idle DuckDB read transaction open.

**Net:** the SQLite+DuckDB combo the user likes is sound *as long as* DuckDB attaches `READ_ONLY` from a **separate process** from the writer. That single rule is the whole ballgame.

Sources: [DuckDB SQLite extension](https://duckdb.org/docs/current/core_extensions/sqlite), [DuckDB concurrency](https://duckdb.org/docs/current/connect/concurrency), [duckdb-sqlite #82](https://github.com/duckdb/duckdb-sqlite/issues/82), [SQLite WAL](https://sqlite.org/wal.html), [SQLite file locking](https://sqlite.org/lockingv3.html), [motherduckdb/sqlite_scanner](https://github.com/motherduckdb/sqlite_scanner).

---

## 2. Normalized data model (SQLite schema)

The flatten middleware already defines our event vocabulary; we lift it almost verbatim into columns. One transcript line can carry multiple content blocks (text + tool_use, or several tool_results); the cleanest model is **one row per content block of interest**, plus dimension tables for projects/sessions.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;     -- WAL + NORMAL: durable across app crash, fast
PRAGMA foreign_keys = ON;

-- Dimension: one row per session file ever seen.
CREATE TABLE session (
  session_id   TEXT PRIMARY KEY,        -- transcript sessionId (== filename stem)
  project      TEXT NOT NULL,           -- basename(cwd) or de-slugged dir
  cwd          TEXT,
  path         TEXT NOT NULL,           -- absolute .jsonl path (for re-scan)
  first_ts     INTEGER,                 -- ms epoch
  last_ts      INTEGER,
  git_branch   TEXT
);
CREATE INDEX session_project ON session(project);

-- Fact: one row per content block we care about.
CREATE TABLE event (
  id           INTEGER PRIMARY KEY,     -- == rowid; the live-poll cursor
  uuid         TEXT NOT NULL,           -- transcript line uuid
  block_idx    INTEGER NOT NULL,        -- block position within the line (0..n)
  parent_uuid  TEXT,
  session_id   TEXT NOT NULL REFERENCES session(session_id),
  project      TEXT NOT NULL,           -- denormalized for fast GROUP BY (avoids join)
  ts           INTEGER NOT NULL,        -- ms epoch (order_key)
  kind         TEXT NOT NULL,           -- prompt|text|thinking|tool_use|tool_result
  tool         TEXT,                    -- Bash, Edit, Read, ...
  command      TEXT,                    -- primary arg
  corr         TEXT,                    -- tool id linking tool_use <-> tool_result
  is_error     INTEGER,                 -- 0/1/NULL
  input_json   TEXT,                    -- full tool input (compact JSON)
  result       TEXT,                    -- tool_result text / Bash stdout
  stderr       TEXT,
  diff         TEXT,                    -- unified diff from structuredPatch
  result_head  TEXT,                    -- one-line summary
  text         TEXT,                    -- prompt/assistant/thinking text
  dur_ms       INTEGER,                 -- derived latency (see below)
  raw          TEXT,                    -- the original JSONL line (drawer/debug)
  UNIQUE (uuid, block_idx)              -- idempotency anchor (see §3)
);
CREATE INDEX event_ts        ON event(ts);
CREATE INDEX event_session   ON event(session_id, ts);
CREATE INDEX event_project   ON event(project, ts);
CREATE INDEX event_tool      ON event(tool) WHERE tool IS NOT NULL;
CREATE INDEX event_corr      ON event(corr) WHERE corr IS NOT NULL;
CREATE INDEX event_kind      ON event(kind);

-- Ingest bookkeeping: per-file tail cursor, so restart resumes, not re-reads.
CREATE TABLE ingest_cursor (
  path        TEXT PRIMARY KEY,
  offset      INTEGER NOT NULL,         -- byte offset consumed
  inode       INTEGER,                  -- detect truncate/rotate (recreate -> reset)
  updated_ts  INTEGER
);
```

**Correlation & latency.** `corr` carries the tool id (flatten's `_corr`). A `tool_use` row and its `tool_result` row share it. **Latency** = `result.ts − tool_use.ts` for a given `corr`; compute it cheaply with a self-join or a partial index, and optionally backfill `dur_ms` on the result row when the ingester sees the matching pair (it always sees the `tool_use` first, append-only). If WebFetch/WebSearch already carry `durationMs`, prefer that (flatten surfaces it in `_resultHead`; we'd also store the raw number).

**Why denormalize `project` onto `event`.** The dominant aggregations are per-project / per-tool. Carrying `project` on the fact row turns the hottest queries into single-table index scans, no join. Sessions and projects are low-cardinality; the redundancy is cheap and SQLite-idiomatic.

**Indexing rationale.** `event_ts` for time-range/live tail; `(session_id, ts)` and `(project, ts)` for scoped table views and trends; `tool`/`kind` partial indexes for facet counts; `corr` for "show this call's result." Point lookups (one session, one corr) are exactly what row-oriented SQLite is fast at — this is the half of the workload SQLite owns. Whole-corpus columnar `GROUP BY` is the half we hand to DuckDB (§3).

**Schema drift.** Treat every transcript field as optional (the flatten port already guards). Keep `raw` so any field we didn't model is still recoverable without re-reading the file. Add new derived columns with `ALTER TABLE … ADD COLUMN` (cheap, nullable) and a `schema_version` pragma/table; never assume a block shape.

---

## 3. Ingest pipeline

```
~/.claude/projects/**/*.jsonl
        │  (follow.ts polling offset-tailer: stat + read-delta every 500ms,
        │   detects new session files, resets on truncate/rotate)
        ▼
   parse line JSON  ──►  flatten() port  ──►  0..n event rows + session upsert
        │  (defensive; drop non-message events)
        ▼
   batch buffer (flush every ~250–500ms OR every N≈200 rows)
        ▼
   one transaction:  INSERT OR IGNORE ... ; UPDATE ingest_cursor
        ▼
   SQLite (WAL)  ── periodic PRAGMA wal_checkpoint(TRUNCATE)
```

**Reuse `follow.ts` almost wholesale.** Its tick loop, per-file byte offset map, remainder buffering for partial trailing lines, truncate/rotate detection, and new-file discovery are exactly the tailer we need. The only change: instead of `sink.write(line)` to stdout, hand each complete line to the parse→flatten→buffer stage. `scanSessions`/`makeFileMatcher` from `lib/sessions.ts` drive the initial backfill and any project/session scoping.

**Batching (the DuckDB advice, applied to SQLite).** Never insert per line — wrap a flush in one transaction. SQLite in WAL+`synchronous=NORMAL` does tens of thousands of inserts/sec when batched; per-row autocommit is 100× slower. A 250–500 ms / ~200-row flush keeps live latency imperceptible while amortizing fsyncs. (This is the same "feed batched INSERTs, never per-line" principle the prior assessment gave for DuckDB — it applies to SQLite too, just less severely.)

**Idempotency / dedup on re-read.** Two layers:
- *Byte-offset cursor* (`ingest_cursor`) persisted in the same DB, updated in the same transaction as the inserts — so a crash mid-batch can't advance the cursor past un-committed rows. On restart we resume from the stored offset, not re-read from zero. This also fixes the Logdy "duplicate rows across restarts" pain (that was a per-process localStorage-key artifact; here the cursor is durable and content-keyed).
- *`UNIQUE(uuid, block_idx)` + `INSERT OR IGNORE`* as the backstop. If a file is truncated/rewritten, or we ever re-scan from offset 0, the unique constraint silently drops already-seen blocks. `uuid` is the transcript line id; `block_idx` disambiguates multiple blocks per line. This makes re-ingest idempotent regardless of cursor state.

**New session files.** Handled by the tailer's existing logic: a `.jsonl` appearing after startup is read from offset 0 (it's new), and we upsert its `session` row from the first `cwd`-bearing line. Files present at startup are backfilled once (the `--full` equivalent) or skipped to EOF for live-only mode.

**Ordering.** `ts` (ms epoch from the line's `timestamp`) is the logical order, but it's not monotonic across files or perfectly reliable. The durable physical order is `event.id` (rowid = insertion order). Live tailing and the `rowid` poll cursor key on `id`; analytics that care about wall-clock order `ORDER BY ts`. Don't conflate them.

**Out-of-order tool_result.** Append-only guarantees the `tool_use` is written before its `tool_result` *within a file*, so the `corr` pair resolves naturally; the latency backfill `UPDATE` runs when the result row lands.

---

## 4. Analytics layer (DuckDB)

DuckDB is the columnar engine for aggregations that touch the whole corpus — the thing Logdy fundamentally could not do (no server-side `GROUP BY`, facets only over the ~100 delivered rows). Two read paths, chosen by recency and weight:

**Path A — ATTACH the SQLite file (default for "all data including the last second").** Separate process, read-only:
```sql
INSTALL sqlite; LOAD sqlite;
ATTACH 'transcripts.db' AS live (TYPE sqlite, READ_ONLY);

-- Per-tool counts + error rate, whole corpus
SELECT tool,
       count(*)                                   AS calls,
       sum(is_error)                              AS errors,
       round(100.0*sum(is_error)/count(*), 1)     AS err_pct
FROM live.event
WHERE kind = 'tool_use' OR kind = 'tool_result'
GROUP BY tool ORDER BY calls DESC;

-- Tool latency from corr pairs
SELECT u.tool,
       count(*)                                   AS n,
       median(r.ts - u.ts)                        AS p50_ms,
       quantile_cont(r.ts - u.ts, 0.95)           AS p95_ms
FROM live.event u
JOIN live.event r ON r.corr = u.corr AND r.kind='tool_result'
WHERE u.kind = 'tool_use'
GROUP BY u.tool ORDER BY p95_ms DESC;

-- Per-project / per-session breakdown
SELECT project, session_id, count(*) FILTER (WHERE kind='tool_use') AS tool_calls,
       sum(is_error) AS errors
FROM live.event GROUP BY project, session_id ORDER BY tool_calls DESC;

-- Time-bucketed trend (5-min buckets)
SELECT time_bucket(INTERVAL '5 minutes', to_timestamp(ts/1000)) AS bucket,
       tool, count(*)
FROM live.event WHERE kind='tool_use' GROUP BY bucket, tool ORDER BY bucket;
```
Because the attach is `READ_ONLY` and in its own process, these run concurrently with live ingest and never block it (§1).

**Path B — scan JSONL directly (for big one-off historical sweeps, or if we ever want analytics without the ingester running).** DuckDB reads the tree natively; no SQLite, no ingester needed:
```sql
SELECT cwd, count(*)
FROM read_json_auto('~/.claude/projects/**/*.jsonl', format='newline_delimited', union_by_name=true)
WHERE message IS NOT NULL
GROUP BY cwd;
```
Then `UNNEST(message.content)` to explode blocks. Add `WHERE timestamp > :last` for incremental sweeps. This is heavier per query (re-parses JSON each time) but needs zero standing infrastructure — it's the fallback and the cross-check.

**When to use which.** Path A for anything interactive and live-inclusive (dashboards, facet counts) — it reads pre-parsed, indexed rows. Path B for archival/ad-hoc analysis over months of history where a full columnar scan beats walking SQLite's row store, or for validating that the SQLite index hasn't drifted from the JSONL truth. Most of the time: Path A.

---

## 5. Real-time monitoring

**Mechanism: poll the `rowid` high-water mark.** SQLite has no change feed, but it doesn't need one for a single-user local tool. The UI server keeps a `lastId`; each tick:
```sql
SELECT * FROM event WHERE id > :lastId ORDER BY id LIMIT 1000;
```
`id` is the monotonic insertion cursor (§3). This is an index range scan from a known point — microseconds. Cadence: **~1 s for the live table/dashboard**; the ingester flushes every ~250–500 ms, so worst-case visible latency is ~1.5 s, which reads as "live." A WAL reader never blocks the writer, so polling is free of contention.

**Push to the browser.** The UI server holds the poll loop and pushes deltas over **SSE (Server-Sent Events)** or a WebSocket to connected clients — clients don't each hammer SQLite; the server polls once and fans out. New rows append to the table; aggregate tiles (tool counts, error rate, current session) recompute from a rolling in-memory window or a cheap `GROUP BY` over the last N minutes.

**Live + historical coexist on one store.** The same `event` table serves both. "Live monitor" = `WHERE id > :lastId` streaming tail + dashboard tiles over a recent window. "Investigate past" = arbitrary filtered/paged SQL over the whole table (and DuckDB for aggregates). There's no second store to keep in sync — the live view is just the tail of the historical one. This is the structural win over Logdy, where backlog (~100 rows) and live tail were different, lossy paths.

**Checkpoint hygiene.** The UI's read transactions must be short (read, return, close) so they don't pin the WAL and starve `wal_checkpoint`. Ingester runs `PRAGMA wal_checkpoint(TRUNCATE)` every few seconds / N flushes.

---

## 6. UI: what replaces Logdy

The two jobs — **filterable past-investigation table** and **live aggregate dashboard** — want different surfaces but the same data. Options, with tradeoffs:

| Option | Past table | Live dashboard | Effort | Verdict |
|---|---|---|---|---|
| **Bespoke local web app** (Bun + Hono server, vanilla/Preact SPA, SSE) | Server-side SQL paging + accurate server-computed facets | SSE tail + tiles | Medium | **Recommended.** Total control; fixes every Logdy limitation; ~one server file + one page. |
| Embed Grafana / Metabase / Superset over DuckDB or SQLite | Strong filtered tables | Strong dashboards/alerts | Low-config but heavy | Overkill + a Java/Docker dependency for a single-user CLI tool. Good if multi-user/alerting later. |
| Jupyter / marimo notebook over DuckDB | Ad-hoc, code-driven | Weak live | Low | Great for exploratory analysis, poor as an always-on monitor. Keep as a *companion*, not the product. |
| **Ink TUI** (extend existing `@clogdy/tui`) | Scrolling filtered table in terminal | Live counters in terminal | Low (foundation exists) | **Recommended as the terminal-native live view** and scope picker. |
| Keep Logdy | — | — | — | No: it's the thing we're replacing; backlog cap + facets-over-delivered are unfixable from config. |

**Recommendation: bespoke web app as primary, Ink TUI as companion.** A Bun HTTP server (Hono or bare `Bun.serve`) exposes:
- `GET /api/events?project=&session=&tool=&kind=&error=&q=&before=&limit=` → paged rows (SQL, indexed).
- `GET /api/facets?…` → `{project:[{value,count}], tool:[…], kind:[…]}` computed by `GROUP BY` over the **whole filtered set** — the accurate facets Logdy couldn't give.
- `GET /api/stats?window=` → dashboard tiles (DuckDB Path A or SQLite).
- `GET /api/stream` (SSE) → live row deltas.

The SPA is a filterable table + a facet sidebar + a small tiles strip — deliberately small, no framework required. We reimplement the *good* parts of the audit columns (the command splitter, the diff/stderr coloring, correlation coloring) as plain client-side render functions — and now without Logdy's `innerHTML`-no-sanitization footgun, since we control the renderer (escape or use text nodes).

**Where `@clogdy/tui` fits.** It already scans sessions (`scanSessions`) and picks projects/sessions via Ink. In the new design it becomes (a) the **scope selector** — choose which sessions the ingester backfills/follows — and optionally (b) a **terminal live monitor**: same `WHERE id > :lastId` poll, rendered as a scrolling table + counters in the terminal for users who live in a shell. It and the web app read the same SQLite store; no coordination needed (WAL multi-reader).

---

## 7. Migration path & MVP

**Transfers nearly intact:**
- `scripts/follow.ts` → the ingester's tailer (swap stdout sink for the batch buffer). Highest-value reuse.
- `src/middlewares/flatten.ts` → the parse/normalize function. It stops being a "self-contained Logdy handler" (that constraint dies with Logdy) and becomes an ordinary, testable module producing `event` rows. Drop the inlining gymnastics; share helpers freely.
- `scripts/lib/sessions.ts` (`scanSessions`, `matchesLine`, `makeFileMatcher`, `collapseSelection`) → session discovery + scoping for backfill and the picker.
- `@clogdy/tui` (`picker.tsx`) → scope selector + optional TUI live view.
- All transcript-schema knowledge in `src/transcript.ts` → the row-mapping types.

**New:** SQLite schema + `bun:sqlite` writer with batching/cursor; the DuckDB attach/query layer; the HTTP/SSE server; the SPA. Plus a render-helpers module (command splitter, diff coloring) ported from `audit.ts`.

**Retired:** Logdy itself, `logdy.config.json` + its generator (`build-config.ts`), the `MiddlewareDef`/`ColumnDef`/`LogdyConfig` envelope types, the self-contained-handler constraint, and all the Logdy-specific gotchas (facet double-counting, correlation-paint-by-text-hash, REST-ingest-doesn't-render, localStorage dup rows). `snapshot.ts` is also retired — bounded slicing existed only to dodge Logdy's backlog cap; the new store has no such cap.

**Incremental rollout (each step shippable):**
1. **MVP — investigate past, accurately.** Ingester (backfill mode, no live needed yet) → SQLite. One `GET /api/events` + `GET /api/facets` endpoint → a flat HTML table with a facet sidebar. This already beats Logdy: full corpus, no 100-row cap, correct facet counts, real filtering. Validate the schema and flatten port against real transcripts here.
2. **Live monitor.** Turn on the follow-tailer + batched inserts; add SSE tail + a few dashboard tiles polling `id > :lastId`. Now "monitor current" works.
3. **DuckDB analytics.** Add the read-only ATTACH and the `/api/stats` aggregates (latency p50/p95, error trends, per-project rollups). This is where heavy analysis lands.
4. **Polish.** Port the command splitter / diff coloring / correlation coloring; wire the Ink TUI as scope picker + terminal live view; Path B (JSONL scan) as a validation/archival mode.

---

## 8. Tradeoffs, risks, open questions (be skeptical)

**Where the SQLite+DuckDB combo adds complexity vs. simpler options:**

- **The honest simpler alternative is DuckDB-only over JSONL (Path B).** For a single user investigating *past* usage, `read_json_auto('~/.claude/projects/**/*.jsonl')` with `GROUP BY` answers nearly every analytic question with **zero standing infrastructure, no ingester, no schema, no sync bugs.** If real-time monitoring were not a hard requirement, this would be the recommendation outright. The SQLite layer exists *to serve live monitoring* (concurrent reader+writer; cheap incremental `rowid` polling; sub-ms point lookups). Be clear that that's what we're buying.
- **Two engines = two mental models + a consistency surface.** SQLite is the truth-of-the-index, DuckDB reads it; if the ingester lags or a batch fails, DuckDB sees a slightly stale corpus. Mitigated by `READ_ONLY` snapshot semantics (never inconsistent, just possibly behind) and by Path B as a re-derive-from-JSONL cross-check. Still, it's a thing to reason about.
- **The same-process double-SQLite-link footgun (§1, caveat 2)** is real and would bite if someone later tries to run DuckDB-attach and `bun:sqlite` in one process. Enforce process separation in the architecture (writer process ≠ analytics process) and document it loudly.
- **Checkpoint starvation** if a UI/DuckDB reader holds a long transaction — WAL grows unbounded. Mitigate with short read transactions and periodic `wal_checkpoint(TRUNCATE)`. Watch in practice.
- **DuckDB-over-SQLite reads are slower than DuckDB-over-native-Parquet/DuckDB-storage.** The SQLite reader pulls rows through the SQLite library, not a columnar scan. For the heaviest historical analytics, Path B (JSONL) or a periodic export to a native DuckDB/Parquet snapshot may beat Path A. Measure before optimizing; for corpora of one user's transcripts this likely never matters.

**Open questions to resolve during the MVP:**
- *Granularity:* one row per content block (proposed) vs. one row per line with blocks as JSON. Per-block makes tool aggregation trivial and is recommended; revisit if row counts explode (unlikely at single-user scale).
- *Latency semantics:* is `result.ts − tool_use.ts` meaningful given transcript timestamps are write-times, not execution-times? Cross-check against tools that report their own `durationMs` (WebFetch/WebSearch) to calibrate trust.
- *Retention:* unbounded `event` table, or roll off / partition old data? Single-user corpora are small (MBs–low GBs); probably leave unbounded, revisit if the `.db` grows.
- *Schema-drift detection:* should the ingester log unmapped block types so we notice Claude Code format changes early? Cheap insurance — recommend yes.
- *Do we even need SQLite long-term,* or could a single always-on DuckDB ingester process (owning the write lock, UI polls it read-only via a second connection) replace both? DuckDB's single-writer + dislike-of-tiny-appends + no-concurrent-read-write-of-same-file makes this worse for live ingest than SQLite WAL — which is exactly why the combo exists. Confirmed, not just asserted (§1).

---

### Bottom line
The user's instinct is right: **SQLite (WAL) as the live, concurrently-written event store + DuckDB (read-only, separate process) as the analytic engine** is a sound, verified architecture. The one rule that makes it work is **DuckDB attaches `READ_ONLY` from its own process** — that's what lets it sweep the whole corpus with `GROUP BY` while the ingester keeps writing, blocking neither. Keep JSONL as truth; reuse the tailer and flatten logic; replace Logdy with a small bespoke web app (plus the existing Ink TUI). And stay honest that if live monitoring weren't required, plain DuckDB-over-JSONL would be simpler and sufficient.

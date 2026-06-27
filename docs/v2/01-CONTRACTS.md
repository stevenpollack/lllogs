# v2 Frozen Contracts

Everything here is **frozen**: types, schema, API, and module boundaries. Tasks implement against these
verbatim. If a change is ever needed, the orchestrator updates this file first, records why in
`DECISIONS.md`, then re-dispatches affected tasks. Subagents never change a contract on their own.

Pinned dependency versions (use exactly these in each package's `package.json`):

| package | dep | version |
| --- | --- | --- |
| (built-in) | `bun:sqlite` | bundled with Bun (no entry needed) |
| @clogdy/server | `hono` | `^4.6.0` |
| @clogdy/analytics | `@duckdb/node-api` | `1.4.5-r.1` (EXACT pin, no caret) |
| @clogdy/web (Phase 5) | `react`, `react-dom` | `^19.2.7` (MATCH the tui's react — avoid a duplicate React) |
| @clogdy/web (Phase 5) | `@tanstack/react-table` | `^8.20.0` |
| @clogdy/web (Phase 5) | `@tanstack/react-virtual` | `^3.10.0` |
| @clogdy/web (Phase 5) | `@uiw/react-codemirror`, `@codemirror/lang-sql` | `^4.23.0` / `^6.8.0` (CodeMirror SQL editor; `<textarea>` is the zero-dep fallback) |
| @clogdy/web (Phase 5, dev) | `@types/react`, `@types/react-dom` | `^19.2.17` / `^19.2.0` |
| (root, Phase 5, dev) | `@playwright/test` | `^1.48.0` (UI-evidence harness; `bunx playwright install chromium` once; ships nothing) |
| @clogdy/shared (+ server, ingest, analytics, web) | `pino` | `^10.3.1` (structured logging; node sink lives behind the `@clogdy/shared/node` subpath, never the barrel) |
| (root, dev) | `pino-pretty` | `^13.1.3` (dev-only out-of-process pretty pipe; **never** an in-process transport) |

> ⚠️ `@duckdb/node-api` ships with `-r.N` build-tag versions (e.g. `1.4.5-r.1`) and the only `1.2.x`
> releases are `-alpha.*`. A caret range like `^1.2.0` resolves to **nothing** and hard-fails
> `bun install`. Pin the exact `1.4.5-r.1` (a native binding; builds on Linux/macOS). Bump only to
> another concrete `-r.N` tag, never a caret range.
| all | `@types/bun` (dev) | `^1.3.14` (match root) |

Default ports / paths (override via env shown):
- Server HTTP port: **7331** (`CLOGDY_PORT`).
- DB path: **`$XDG_DATA_HOME/clogdy/clogdy.db`**, falling back to **`~/.local/share/clogdy/clogdy.db`**
  (`CLOGDY_DB`). The ingester creates the parent dir (`mkdir -p`) on open.
- Transcript root: **`~/.claude/projects`** (`CLOGDY_ROOT` or a positional CLI arg).
- Log level: **`info`** (`CLOGDY_LOG_LEVEL` ∈ `debug|info|warn|error|silent`; an unknown value falls back to
  `info`, never throws at logger construction).
- Log dir: unset → stderr, **silent for analytics** (`CLOGDY_LOG_DIR`); when set each process writes its own
  `<proc>[-<pid>].jsonl` (analytics is per-pid — spawned per request, concurrent).

**Logging invariant:** structured logs go to **stderr or a file, never stdout**. The **analytics** process
logs to a **file only** (never stdout *or* stderr) — its stdout is the JSON-result wire the server
`JSON.parse`s and its stderr is the error-string wire the server forwards to the user; both are reserved.
Without `CLOGDY_LOG_DIR` analytics is silent and the server narrates it.

---

## 1. `@clogdy/shared` — TS types (file: `packages/shared/src/types.ts`)

```ts
/** A normalized tool-usage event: one row per content block of interest. */
export interface FlatEvent {
  uuid: string;            // transcript line uuid (fallback: `${sessionId}:${lineIndex}` if absent)
  blockIdx: number;        // 0-based index of the block within the line (prompt → 0)
  parentUuid: string | null;
  sessionId: string;
  project: string;         // basename(cwd); "" if no cwd seen on the line
  cwd: string | null;
  ts: number;              // ms epoch (Date.parse(timestamp)); 0 if unparseable
  kind: EventKind;
  role: string | null;     // message.role envelope (user/assistant); null if absent — orthogonal to kind
  tool: string | null;     // tool_use name
  command: string | null;  // primary arg of a tool call
  corr: string | null;     // tool id linking tool_use <-> tool_result
  isError: boolean | null; // tool_result: false (ok) or true (error); null for every non-tool_result kind
  inputJson: string | null;// full tool input, compact JSON
  result: string | null;   // tool_result text / Bash stdout
  stderr: string | null;   // Bash stderr
  diff: string | null;     // unified-diff text from structuredPatch
  resultHead: string | null;// one-line result summary
  text: string | null;     // prompt / assistant text / thinking
  durMs: number | null;    // tool latency; null at insert (computed later/queries)
  gitBranch: string | null;
  raw: string;             // the original JSONL line (verbatim)
}

export type EventKind = "prompt" | "text" | "thinking" | "tool_use" | "tool_result";

/** Filters accepted by the query layer and the HTTP API (all optional / AND-combined). */
export interface EventFilter {
  // Facet dimensions accept one value or many (OR within a dimension → SQL IN).
  // A bare string stays valid (backward compatible); see D-5.m.
  project?: string | string[];        // exact project name(s)
  session?: string | string[];        // exact full sessionId(s) (UI may pass short → server expands; see API)
  tool?: string | string[];           // exact tool name(s)
  kind?: EventKind | EventKind[];
  role?: string | string[];           // exact message.role(s) (user/assistant)
  error?: ("error" | "ok") | ("error" | "ok")[];  // maps to isError = 1 / 0
  corr?: string;           // exact correlation id
  since?: number;          // ts >= since (ms epoch)
  until?: number;          // ts <  until (ms epoch)
  q?: string;              // substring match over (command, text, result) — LIKE %q%
  afterId?: number;        // id > afterId (keyset pagination / live cursor)
  limit?: number;          // default 200, max 2000
}
// Repeated query params carry multiple values (`?kind=tool_use&kind=tool_result`);
// the POST /api/query body may pass an array directly. `asArray()` (shared)
// normalizes single|array|absent → flat array for the IN builders.

/** A row as returned to the API (FlatEvent + the DB id). */
export interface EventRow extends FlatEvent {
  id: number;              // event.id (== rowid), the live/pagination cursor
  // NB: `cwd` is inherited from FlatEvent but is ALWAYS null on read — the `event` table omits cwd
  // (only `session` has it). Use `project` (denormalized on event) or join `session` for cwd.
}

export interface FacetBucket { value: string; count: number }
export interface Facets {
  project: FacetBucket[];
  session: FacetBucket[];
  tool: FacetBucket[];
  kind: FacetBucket[];
  role: FacetBucket[];
  error: FacetBucket[];
}
```

The `EventKind` set is closed. The flatten port maps blocks to exactly these five kinds; any other block
type is **skipped** (not emitted) and counted via `onSkip` (see §3).

---

## 2. SQLite schema (file: `packages/ingest/src/schema.ts`, exported as `SCHEMA_SQL: string`)

Exactly this DDL. `event.id` is the autoincrement rowid and the only cursor anyone uses.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- holds schema_version, etc.

CREATE TABLE IF NOT EXISTS session (
  session_id TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  cwd        TEXT,
  path       TEXT NOT NULL,
  first_ts   INTEGER,
  last_ts    INTEGER,
  git_branch TEXT
);
CREATE INDEX IF NOT EXISTS session_project ON session(project);

CREATE TABLE IF NOT EXISTS event (
  id          INTEGER PRIMARY KEY,         -- == rowid; the cursor
  uuid        TEXT NOT NULL,
  block_idx   INTEGER NOT NULL,
  parent_uuid TEXT,
  session_id  TEXT NOT NULL,
  project     TEXT NOT NULL,               -- denormalized for fast GROUP BY
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  role        TEXT,                    -- message.role (user/assistant); NULL if absent
  tool        TEXT,
  command     TEXT,
  corr        TEXT,
  is_error    INTEGER,                     -- 0/1/NULL
  input_json  TEXT,
  result      TEXT,
  stderr      TEXT,
  diff        TEXT,
  result_head TEXT,
  text        TEXT,
  dur_ms      INTEGER,
  git_branch  TEXT,
  raw         TEXT NOT NULL,
  UNIQUE (uuid, block_idx)                 -- idempotency anchor
);
CREATE INDEX IF NOT EXISTS event_ts      ON event(ts);
CREATE INDEX IF NOT EXISTS event_session ON event(session_id, ts);
CREATE INDEX IF NOT EXISTS event_project ON event(project, ts);
CREATE INDEX IF NOT EXISTS event_tool    ON event(tool) WHERE tool IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_corr    ON event(corr) WHERE corr IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_kind    ON event(kind);
CREATE INDEX IF NOT EXISTS event_role    ON event(role) WHERE role IS NOT NULL;

CREATE TABLE IF NOT EXISTS ingest_cursor (
  path       TEXT PRIMARY KEY,
  offset     INTEGER NOT NULL,             -- bytes consumed
  inode      INTEGER,                      -- detect truncate/rotate
  updated_ts INTEGER
);
```

`SCHEMA_VERSION = 2` is written to `meta('schema_version', …)` on first open. Migrations are additive
(`ALTER TABLE … ADD COLUMN`): `openDb` adds any missing column (`role`, added in v2) **before** applying
SCHEMA_SQL, so an existing DB upgrades in place (the new `event_role` index then builds against the
present column). Existing rows are NOT backfilled by re-ingest (idempotent `INSERT OR IGNORE` skips
them) — run `--reset` to rebuild with the new derived column.

**Column ↔ FlatEvent mapping** (writer must map exactly): `block_idx←blockIdx`, `parent_uuid←parentUuid`,
`session_id←sessionId`, `is_error←isError?1:0` (or NULL), `input_json←inputJson`, `result_head←resultHead`,
`dur_ms←durMs`, `git_branch←gitBranch`; the rest are same-name snake↔camel. Booleans store as 0/1/NULL.

---

## 3. The flatten port (file: `packages/shared/src/flatten.ts`)

A pure, dependency-free port of `src/middlewares/flatten.ts` (v1), **changed to emit one event per
content block** instead of only the primary block.

```ts
import type { FlatEvent } from "./types";

export interface FlattenOptions {
  /** Called once per skipped/unknown block type (schema-drift signal). */
  onSkip?: (blockType: string) => void;
}

/**
 * Parse one raw JSONL line into 0..n FlatEvents.
 * - Returns [] (drops the line) if it isn't valid JSON or has no `message`.
 * - `message.content` as a string → one event {kind:"prompt", text:content, blockIdx:0}.
 * - `message.content` as an array → one event per block, in array order:
 *     tool_use     → {kind:"tool_use",   tool, command, inputJson, corr:id}
 *     tool_result  → {kind:"tool_result",isError, result, corr:tool_use_id, + enrichment}
 *     text         → {kind:"text",       text}
 *     thinking     → {kind:"thinking",   text:thinking}
 *     anything else→ skipped; onSkip(block.type) called.
 * - tool_result enrichment reads the line-level `toolUseResult` (NOT per-block); identical rules to v1:
 *     structuredPatch[] → diff = hunks.flatMap(h=>h.lines).join("\n")
 *     stdout/stderr     → result=stdout; stderr=stderr(if nonempty); resultHead="⚠ interrupted" if interrupted
 *     url+bytes         → resultHead = [code, size, dur].filter(Boolean).join(" · ")  (size/dur formatting per v1)
 *     results[]/searchCount → resultHead = `${n} results` + (query ? ` · "${query.slice(0,60)}"` : "")
 * - Every event carries: uuid (line.uuid, or `${sessionId||"?"}:${lineIndex}` when absent — lineIndex is
 *   the 2nd arg), blockIdx, parentUuid, sessionId, project=basename(cwd), cwd, ts=Date.parse(timestamp)||0,
 *   gitBranch, role=message.role (string|null; user/assistant), raw=rawLine. command primary-arg precedence (v1): input.command ?? file_path ?? url ??
 *   query ?? path ?? pattern ?? (keys? JSON.stringify(input) : "").
 *
 * EVERY emitted FlatEvent populates ALL fields: a field not derived for the event's kind is set to
 *   `null` (never undefined — the `: T | null` types and the writer's column mapping depend on it).
 *   `durMs` is ALWAYS null at flatten time. Build events through one factory that defaults every field
 *   to null, then overwrites the kind-relevant ones.
 * `inputJson = JSON.stringify(input)` for tool_use only (so `{}` → "{}"); `null` for every other kind.
 * `isError`: tool_result → `block.is_error === true` (so a non-error tool_result is `false`, never null);
 *   `null` for every non-tool_result kind.
 * If a line carries >1 tool_result block, apply the line-level `toolUseResult` enrichment to EACH
 *   tool_result block (lines carry at most one in practice; this keeps the rule total).
 */
export function flattenLine(rawLine: string, lineIndex: number, opts?: FlattenOptions): FlatEvent[];

/** basename of a cwd path (v1's rule): cwd.replace(/\/+$/,"").split("/").pop() || cwd. "" if no cwd. */
export function projectFromCwd(cwd: string | undefined | null): string;
```

`flattenLine` must be **pure** (no I/O, no globals) so it is trivially unit-testable. The v1 derivation
logic for `_tool/_command/_input/_corr/_isError/_result/_diff/_stderr/_resultHead` is reproduced
verbatim (see `src/middlewares/flatten.ts` lines 40–94 for the exact precedence and formatting); the
only structural change is iterating all blocks and emitting per block.

---

## 4. `@clogdy/shared` — config util (file: `packages/shared/src/config.ts`)

```ts
export interface Paths { db: string; root: string }
/** Resolve DB + transcript-root paths from env/args, expanding ~ and creating no dirs (callers mkdir). */
export function resolvePaths(argv?: { db?: string; root?: string }): Paths;
export function defaultDbPath(): string;   // $XDG_DATA_HOME/clogdy/clogdy.db || ~/.local/share/clogdy/clogdy.db
export function defaultRoot(): string;     // CLOGDY_ROOT || ~/.claude/projects
```

### `@clogdy/shared` — structured logging (files: `packages/shared/src/log.ts`, `log-node.ts`)

The **isomorphic core** ships in the barrel (`@clogdy/shared`) and is browser-safe — it only
`import type { LoggerOptions } from "pino"`, which is erased at build:
- `SCHEMA_OPTS: LoggerOptions` — the shared `messageKey:"msg"` / `formatters.level` (string label) /
  `timestamp` (`,"ts":"<ISO>"`) so the node and browser loggers emit **one** evidence schema.
- types `LogLevel` (`debug|info|warn|error|silent`) and `LogEntry`.
- evidence helpers `parseLogLines(text): LogEntry[]` (split `\n`, `JSON.parse`, skip blank/non-JSON) and
  `selectEvents(entries, { evt?, level? }): LogEntry[]` — the assertion primitives shared by `bun:test`
  and Playwright.

The **node-only sink** lives behind the **subpath** `@clogdy/shared/node` (deliberately NOT re-exported by
the barrel, so `pino`'s `node:fs`/`sonic-boom` stay out of the browser bundle):
- `nodeLogger(proc: string): Logger`. Sink precedence: `CLOGDY_LOG_DIR` set → `<dir>/<proc>[-<pid>].jsonl`
  (sync; analytics per-pid); else proc `analytics` → **silent** (its wires are reserved); else → stderr
  (fd 2, sync). Level from `CLOGDY_LOG_LEVEL` (default `info`, validated). `base:{proc,pid}` replaces pino's
  default `{pid,hostname}` → **no hostname leak** in committed artifacts.

One emitted line (schema both processes share):
```json
{"level":"info","ts":"2026-06-27T12:00:00.000Z","proc":"server","pid":4242,"evt":"req.end","status":200}
```

---

## 5. `@clogdy/ingest` — public surface

```ts
// packages/ingest/src/db.ts
import { Database } from "bun:sqlite";
export function openDb(path: string): Database;   // mkdir -p parent; exec SCHEMA_SQL; set schema_version
// packages/ingest/src/writer.ts
export interface Writer {
  /** Buffer events; flushes at batchSize or flush(). Returns inserted count (post OR IGNORE). */
  add(events: FlatEvent[]): void;
  flush(): number;
  /** upsert session dims + advance a file's ingest_cursor in the same txn as the flush. */
  setCursor(path: string, offset: number, inode: number | null): void;
  upsertSession(s: { sessionId: string; project: string; cwd: string | null; path: string; ts: number; gitBranch: string | null }): void;
  close(): void;
}
export function makeWriter(db: Database, batchSize?: number /* default 200 */): Writer;
// packages/ingest/src/tailer.ts  — ported from scripts/follow.ts, sink as callback
export interface TailerOptions { root: string; full: boolean; intervalMs?: number /* 500 */;
  /** initial cursors so a restart resumes instead of re-reading (path → byte offset). */
  cursors?: Map<string, number>;
}
/** Calls sink(path, line) for every complete JSONL line; watches the tree. `once` resolves after one
 *  full pass (for backfill); omit to watch forever. */
export function tail(opts: TailerOptions, sink: (path: string, line: string) => void, once?: boolean): Promise<void>;
```

CLI (file `packages/ingest/src/cli.ts`, exposed as root script `v2:ingest`):
`--backfill` (one pass over existing files, then exit) | `--watch` (backfill then keep tailing) |
`--db <path>` `--root <dir>` `--reset` (delete+recreate DB). Prints progress to stderr
(`ingested N events from M files`).

---

## 6. `@clogdy/server` — query layer + HTTP API

Query layer (file `packages/server/src/queries.ts`), pure functions over a `bun:sqlite` `Database`:

```ts
export function queryEvents(db: Database, f: EventFilter): { rows: EventRow[]; nextAfterId: number | null };
export function queryFacets(db: Database, f: EventFilter): Facets;
export function expandSession(db: Database, shortOrFull: string): string | null; // 8-char prefix → full id
export function maxEventId(db: Database): number;   // for SSE cursor init
// Phase 2: the extracted poller the SSE handler calls (also exported for the live e2e). Returns events
// with id > cursor (keyset), newest cursor advances. NB: the SSE query param is `lastId` (stream cursor),
// distinct from the REST `afterId` pagination key — do not conflate them.
export function pollNewEvents(db: Database, cursor: number, f: EventFilter): { rows: EventRow[]; lastId: number };
```

`queryEvents`: `WHERE` built from `f` (parameterized, never string-interpolated), `ORDER BY id ASC`,
`LIMIT min(f.limit ?? 200, 2000)`, keyset by `id > afterId`. `nextAfterId` = last row's id if a full page
returned, else null.

`queryFacets` — **faceted-search semantics**: each dimension's buckets are computed with **all filters
EXCEPT that dimension's own** applied (so sibling counts stay visible). For dimension D:
`SELECT <valueExpr> AS value, COUNT(*) AS count FROM event WHERE <filters minus D> AND <col> IS NOT NULL GROUP BY value ORDER BY count DESC LIMIT 200`.
**Group by the `value` alias, not `<D>`** — for `error` the value is a `CASE is_error WHEN 1 THEN 'error'
WHEN 0 THEN 'ok' END` expression and for `session` it's `session_id`; `GROUP BY <rawColumn>` is wrong/
invalid for those. The `IS NOT NULL` guard uses the underlying **column** (`is_error`, `session_id`,
`tool`, `kind`, `role`, `project`), not the alias. This server-side GROUP BY over the full filtered
set is the core Logdy-beating behavior — counts are exact, not "over delivered rows".

HTTP API (file `packages/server/src/app.ts`, a Hono app; `serve.ts` boots it on `CLOGDY_PORT`):

| method · path | query | 200 response |
| --- | --- | --- |
| `GET /healthz` | — | `{ ok: true, dbPath, events: <count>, maxId }` |
| `GET /api/events` | EventFilter fields as query params (`since`/`until`/`afterId`/`limit` numeric; `session` may be 8-char short → expanded) | `{ events: EventRow[], nextAfterId: number\|null }` |
| `GET /api/facets` | same filter params | `Facets` |
| `GET /api/events/stream` | same filter params + `lastId` | **SSE**: `event: append` `data: {events:EventRow[], lastId}` every ~1s when new rows exist; `event: ping` heartbeat (Phase 2) |
| `GET /api/stats` | `metric` ∈ {`toolCounts`,`errorRate`,`latency`,`projectRollup`,`timeBuckets`} + filter params (Phase 3) | `{ metric, data: <shape per metric, see Phase 3> }` |
| `POST /api/query` (Phase 5) | JSON body `{ sql: string, filter?: EventFilter, limit?: number }` | `{ columns: string[], rows: unknown[][], truncated: boolean }` |
| `GET /*` (else) | — | static web assets from `@clogdy/web` build dir; `/` → `index.html` |

All API responses are JSON, `Content-Type: application/json`. Errors → `{ error: string }` with 400 (bad
param) or 500. The server opens the DB **read-only** (`new Database(path, { readonly: true })`).

**`POST /api/query` (Phase 5 — facet + SQL "atop the faceted data", the Datasette model).** The user's
`sql` is read-only SQL written against the relation **`events`**, which the analytics CLI rewrites to a
**facet-scoped CTE** so `events` resolves to the `filter`-selected subset:

```sql
WITH events AS (SELECT * FROM live.event <buildWhere(filter)>)
SELECT * FROM ( <user sql> ) LIMIT <cap + 1>   -- cap+1 → detect truncation
```

Behavior: parse `filter` (reuse the server's `EventFilter` parse; expand a short 8-char `session` like
`/api/events`); **guard** `sql` with `assertSelectOnly` from `@clogdy/shared` (single statement;
`^\s*(WITH|SELECT)\b`; block `ATTACH/DETACH/PRAGMA/INSTALL/LOAD/COPY/EXPORT/IMPORT/INSERT/UPDATE/UPSERT/
DELETE/DROP/CREATE/ALTER/REPLACE/TRUNCATE/CALL/GRANT/REVOKE/VACUUM/CHECKPOINT`, comment-stripped first;
reject a user CTE named `events`) → **400** `{error}` *before spawning*. Then **spawn the analytics CLI
in `--query` mode** (§7), `cwd: repoRoot` (D-3.a), `cap = min(limit ?? 1000, 5000)`, with a **10 s
kill-deadline** (`proc.kill()` → **504** `{error:"query timed out"}`, mirroring `/api/stats`). On exit 0,
return the CLI's `{columns, rows, truncated}`; nonzero exit → **500** `{error: <stderr>}`. **The server
imports NO DuckDB** (ground rule #3) — it only spawns the CLI; the read-only guarantee is the CLI's
`ATTACH … READ_ONLY`. `rows` are value-arrays aligned to `columns` (compact for wide results). The frozen
`/api/events`, `/api/facets`, `/api/events/stream` are **unchanged**; this overlay is strictly additive,
and while it is active the web pauses SSE + keyset paging (facet **counts** still come from
`/api/facets` over the `EventFilter`, never from the SELECT).

---

## 7. `@clogdy/analytics` — DuckDB CLI contract (Phase 3)

A **standalone process**, DuckDB-only (never imports `bun:sqlite`). File `packages/analytics/src/query.ts`,
root script `v2:analytics`:

```
bun run v2:analytics -- --db <sqlite-path> --metric <name> [--filters '<json EventFilter>']
→ prints a single JSON object {metric, data} to stdout and exits 0; errors → stderr + exit 1.
```

It connects DuckDB, `INSTALL sqlite; LOAD sqlite;`, `ATTACH '<db>' AS live (TYPE sqlite, READ_ONLY);`,
runs the metric query against `live.event`, prints JSON, detaches, exits. The **server shells out to
this CLI** for `/api/stats` (ground rule #3 — no DuckDB in the server process). Metric data shapes are
defined in `04-PHASE3-DUCKDB.md`.

**`--query` mode (Phase 5).** A second mode of the same DuckDB-only CLI (the `--metric` mode is
unchanged):

```
bun run v2:analytics -- --db <sqlite> --query --sql '<SELECT…>' [--filters '<json EventFilter>'] [--limit <n>]
→ prints a single JSON object { columns: string[], rows: unknown[][], truncated: boolean } to stdout, exit 0;
  guard rejection / DuckDB error → stderr + exit 1.
```

It calls `assertSelectOnly(sql)` (from `@clogdy/shared`), wraps the SQL in the **facet CTE** via
`buildWhere(filter)` (the exact rewriting in §6 / `07-PHASE5.md`), runs it via the same READ_ONLY
`withDuck` ATTACH, reads `columns` from the result schema and `rows` as value-arrays, and sets
`truncated` when the result exceeded `cap = min(limit ?? 1000, 5000)` (queried as `LIMIT cap+1`, sliced
to `cap`). Same DuckDB-only process; **never imports `bun:sqlite`**. The full Phase 5 spec is in
`07-PHASE5.md`.

---

## 8. `@clogdy/web` — build + integration contract

- Source TS in `packages/web/src/`, bundled by `Bun.build({ entrypoints:['src/main.ts'], outdir:'dist', target:'browser', minify:true })` via `packages/web/build.ts` (root script `v2:web:build`).
- `packages/web/index.html` references `/dist/main.js`. The **server serves `packages/web/`** (index.html
  at `/`, `/dist/*` assets). No framework in Phases 1–4 (vanilla TS + DOM); Phase 4 added rich rendering
  helpers from `@clogdy/shared`.
- **Phase 5** migrates this package to **React 19 + `@tanstack/react-table`/`react-virtual`** (+ a
  CodeMirror SQL editor), still bundled by the **same `Bun.build`** (Bun transpiles JSX natively): the
  entrypoint becomes `src/main.tsx`, `tsconfig.json` gains `"jsx": "react-jsx"`, `index.html` keeps a
  `<div id="root">` + `/dist/main.js`. The build contract (still `Bun.build`, `target:'browser'`, served
  by `@clogdy/server` from `packages/web/`) is unchanged. **Security: never `dangerouslySetInnerHTML`
  with event data** — React's default escaping replaces v1/T-4.2's hand-escaping; the structured
  `splitBashCommand`/`resultLines` helpers render as JSX elements, never HTML strings.
- The web app talks to the API in §6 only. It must never assume row ordering beyond `id ASC`.

---

## 9. Root wiring (touched only by T-0.1, and incrementally by the package-adding tasks)

Root `package.json` gains:
```jsonc
"workspaces": ["tui", "packages/*"],
"scripts": {
  // … existing v1 scripts unchanged …
  "v2:ingest":     "bun run packages/ingest/src/cli.ts",
  "v2:serve":      "bun run packages/server/src/serve.ts",
  "v2:analytics":  "bun run packages/analytics/src/query.ts",
  "v2:web:build":  "bun run packages/web/build.ts",
  "check":         "tsc --noEmit && bun run --filter '@clogdy/*' check"   // the glob covers @clogdy/tui too — don't also list it explicitly (double-runs)
}
```
Each package has its own `tsconfig.json` extending root, and a `check` script (`tsc --noEmit`). Server
must `v2:web:build` before serving in production; in dev it may build on boot.

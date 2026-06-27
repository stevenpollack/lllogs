# Phase 1 — MVP: investigate past, accurately

Goal: a working `ingest --backfill` that fills the SQLite DB from `~/.claude/projects`, and a
`serve` that exposes a filterable table with **accurate server-side facet counts over the full
corpus** — beating Logdy's ~100-row cap immediately. Read `01-CONTRACTS.md` §2/§5/§6/§8 first. Every
task uses the subagent template from `00-ORCHESTRATION.md`; ground rules #3 and #8 are absolute.

---

## T-1.1 — ingest: schema + DB open/migrate (PG0)

**Files:** `packages/ingest/src/schema.ts`, `packages/ingest/src/db.ts`, `packages/ingest/src/db.test.ts`,
and `packages/ingest/src/index.ts` (re-export every ingest module — `schema`, `db`, and `tailer`/
`writer`/`ingest` as T-1.2–1.4 add them; `@lllogs/ingest`'s consumers — the server and the e2e test —
import `openDb`/`makeWriter`/`runIngest` from here, so they must be exported). **Wiring:** the server and
e2e tests that import `@lllogs/ingest` need `"@lllogs/ingest": "file:../ingest"` in `packages/server/package.json`
`devDependencies` (add it when you reach T-1.5/T-1.8) and a `bun install` afterward.

**Spec:**
- `schema.ts`: `export const SCHEMA_SQL = \`…\`` containing the DDL from CONTRACTS §2 **verbatim**; and
  `export const SCHEMA_VERSION = 1;`.
- `db.ts`: `export function openDb(path: string): Database` —
  - `mkdir -p` the parent dir (`node:fs` `mkdirSync(dirname(path), {recursive:true})`).
  - `const db = new Database(path)`; `db.exec(SCHEMA_SQL)` (idempotent — all `IF NOT EXISTS`).
  - Set `meta('schema_version', String(SCHEMA_VERSION))` via `INSERT … ON CONFLICT(key) DO NOTHING`.
  - Return `db`. (WAL pragma is in SCHEMA_SQL; bun:sqlite honors `PRAGMA` via `exec`.)
- `import { Database } from "bun:sqlite";`

**Tests (`db.test.ts`):** open a temp-path DB (use `mkdtempSync`), assert: tables `event`,`session`,
`ingest_cursor`,`meta` exist (`SELECT name FROM sqlite_master`); `meta` has `schema_version='1'`;
`PRAGMA journal_mode` returns `wal`; calling `openDb` twice on the same path doesn't throw (idempotent).
Clean up the temp dir in `afterAll`.

**Acceptance:** `bun test packages/ingest/src/db.test.ts` green; `bun run check` green.

---

## T-1.2 — ingest: tailer ported from `scripts/follow.ts` (PG0)

**Goal:** a reusable tail function with a callback sink (CONTRACTS §5 `tail`). This is a near-direct port
of `scripts/follow.ts` (read it — the offset/remainder/glob/tick logic is the reference).

**Files:** `packages/ingest/src/tailer.ts`, `packages/ingest/src/tailer.test.ts`.

**Spec (`tail`):**
- Signature: `tail(opts: TailerOptions, sink: (path: string, line: string) => void, once?: boolean): Promise<void>`.
- Reuse v1 follow.ts mechanics exactly: per-file byte `offset` + `remainder` (partial trailing line)
  maps; `new Bun.Glob("**/*.jsonl").scan({cwd:root, absolute:true})`; on each complete line call
  `sink(path, line)` (instead of writing stdout). A shrunk file (size < offset) resets to 0.
- `opts.cursors` (path→offset) seeds the `offset` map at start (resume). `opts.full`: when false, files
  present at the first pass are skipped to EOF (history); a file appearing later is read from 0. (Same
  rule as follow.ts.) For backfill we pass `full:true` + `once:true`.
- `once:true` → perform exactly **one** full pass over the tree, flush each file's complete lines, then
  resolve the promise (no polling loop). `once` falsey → poll every `intervalMs` (default 500) forever
  (used by Phase 2 watch).
- No stdout writing. No process.exit. Pure-ish (touches fs only).

**Tests (`tailer.test.ts`):** create a temp dir with two `*.jsonl` files (multi-line, including one with
a trailing partial line i.e. no final `\n`); run `tail({root, full:true}, sink, true)`; assert sink
received exactly the complete lines (partial trailing line NOT delivered), across both files, and that
the function resolved. Add a case: seed `cursors` to mid-file and assert only the suffix is delivered.

**Acceptance:** `bun test packages/ingest/src/tailer.test.ts` green; `bun run check` green.

---

## T-1.3 — ingest: writer (batched, idempotent) + cursor/session (PG1, needs 1.1)

**Files:** `packages/ingest/src/writer.ts`, `packages/ingest/src/writer.test.ts`.

**Spec (`makeWriter(db, batchSize=200): Writer`):** implement the `Writer` interface from CONTRACTS §5.
- Prepare ONE INSERT statement: `INSERT OR IGNORE INTO event (uuid,block_idx,parent_uuid,session_id,project,ts,kind,tool,command,corr,is_error,input_json,result,stderr,diff,result_head,text,dur_ms,git_branch,raw) VALUES (?,?,…)` — column order fixed; map FlatEvent per CONTRACTS §2 mapping; `is_error` → `e.isError===null? null : (e.isError?1:0)`.
- `add(events)`: push into an internal buffer; if `buffer.length >= batchSize`, `flush()`.
- `flush(): number`: run all buffered inserts inside a single `db.transaction(...)`; return the count
  actually inserted — compute as the sum of `db.run/.changes` per insert (bun:sqlite `stmt.run()`
  returns `{changes}`); `OR IGNORE` makes a duplicate `changes:0`. Clear the buffer.
- `setCursor(path, offset, inode)`: `INSERT INTO ingest_cursor(path,offset,inode,updated_ts) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset, inode=excluded.inode, updated_ts=excluded.updated_ts`. `updated_ts = Date.now()`.
- `upsertSession({sessionId,project,cwd,path,ts,gitBranch})`: `INSERT INTO session(...) VALUES(...) ON CONFLICT(session_id) DO UPDATE SET project=excluded.project, cwd=COALESCE(excluded.cwd, session.cwd), path=excluded.path, last_ts=MAX(COALESCE(session.last_ts,0), excluded.last_ts), first_ts=MIN(COALESCE(session.first_ts, excluded.last_ts), excluded.last_ts), git_branch=COALESCE(excluded.git_branch, session.git_branch)`. **On the INSERT, bind `ts` to BOTH
  `first_ts` AND `last_ts`** (the ON CONFLICT MIN/MAX then maintains the window).
- `close()`: `flush()` then nothing else (caller owns `db`).
- All statements prepared once in `makeWriter` (don't re-prepare per call).

**Tests (`writer.test.ts`):** open an in-test temp DB via `openDb`; build a few `FlatEvent`s; `add` +
`flush`, assert `event` row count and a couple of column values; **idempotency:** flush the same events
again → inserted count 0, total rows unchanged (the `UNIQUE(uuid,block_idx)` + `OR IGNORE`); `setCursor`
upserts (insert then update changes offset); `upsertSession` updates `last_ts` to the max.

**Acceptance:** `bun test packages/ingest/src/writer.test.ts` green; `bun run check` green.

---

## T-1.4 — ingest: backfill CLI wiring (PG2, needs 1.2, 1.3, 0.2)

**Goal:** the `ingest` CLI: tail → flatten → write, idempotent, resumable.

**Files:** `packages/ingest/src/ingest.ts` (the orchestration fn), `packages/ingest/src/cli.ts` (arg
parse + main), `packages/ingest/src/ingest.test.ts`.

**Spec:**
- `runIngest({ db: Database, root: string, mode: "backfill"|"watch", onProgress?: (n:number)=>void }): Promise<void>`:
  - Load existing cursors: `SELECT path, offset FROM ingest_cursor` → `Map`.
  - `writer = makeWriter(db)`.
  - Track per-file: current byte offset (from the tailer — but the tailer owns offsets internally; for
    cursor persistence, the sink also needs the file's new offset). **Simplest correct approach:** the
    sink receives `(path, line)`; maintain a `lineIndex` per path (reset on new path) for uuid fallback;
    accumulate events via `writer.add(flattenLine(line, lineIdx, {onSkip}))` and `writer.upsertSession(...)`
    derived from the first event of a line that has a sessionId. Persist cursors by, after the pass,
    reading each file's size and `setCursor(path, size, inode)`. (Backfill reads whole files once;
    setting the cursor to file size lets a later `--watch` resume at EOF.)
    - To get inode + size: `statSync(path)` (`node:fs`), `.ino`, `.size`.
  - `mode:"backfill"` → `await tail({root, full:true, cursors}, sink, true)`; then `writer.flush()`; then
    persist all touched files' cursors (size+inode) in one transaction; `onProgress(totalInserted)`.
  - `mode:"watch"` → first do a backfill pass (full:true, once:true) to catch up, persisting cursors,
    then call `tail({root, full:false, cursors}, sink)` (no `once`) to poll forever, flushing the writer
    on an interval (e.g. every 500ms via `setInterval`) and after each file's lines; persist that file's
    cursor after flushing. (Phase 2 hardens watch; for Phase 1 implement backfill fully and leave a
    `watch` path that at least compiles and runs.)
  - **Schema-drift counting:** keep a `Map<string,number>` of skipped block types via `onSkip`; print a
    summary to stderr at the end (`skipped block types: image=3, …`).
- `cli.ts`: parse `--backfill|--watch`, `--db <path>`, `--root <dir>`, `--reset`. Resolve paths via
  `resolvePaths` (shared). `--reset` → `rmSync(db, {force:true})` + the `-wal`/`-shm` siblings before
  open. `openDb(path)`. Run `runIngest`. Print `ingested N events from M files` to stderr. Exit 0.

**Tests (`ingest.test.ts`):** build a temp transcript tree (2 sessions, a few real-shaped lines each
incl. a tool_use+tool_result pair and a non-message line); `openDb(tmpDb)`; `runIngest({mode:"backfill"})`;
assert: `event` count equals the number of emitted blocks (compute expected from the fixtures), a
tool_use row has the right `tool`/`command`/`corr`, a tool_result row shares that `corr`; running
`runIngest` again inserts 0 new rows (idempotent); `session` table has 2 rows with correct `project`.

**Acceptance:** `bun test packages/ingest/src/ingest.test.ts` green; `bun run check` green; manual:
`bun run ingest -- --backfill --db /tmp/lllogs-smoke.db` exits 0 and prints a sane count (orchestrator
runs this against the real `~/.claude/projects`, then `sqlite3 /tmp/lllogs-smoke.db 'select count(*) from event'` > 0 — or via a tiny `bun -e` using bun:sqlite).

---

## T-1.5 — server: query layer (events + faceted counts) (PG1, needs 1.1)

**Files:** `packages/server/src/queries.ts`, `packages/server/src/queries.test.ts`.

**Spec:** implement `queryEvents`, `queryFacets`, `expandSession`, `maxEventId` (CONTRACTS §6) as pure
functions over a `bun:sqlite` `Database` opened read-only by the caller.
- Build the WHERE clause with a parameter array; map filters: `project`→`project = ?`; `session`→
  `session_id = ?`; `tool`→`tool = ?`; `kind`→`kind = ?`; `error`→`is_error = ?` (1/0); `corr`→`corr = ?`;
  `since`→`ts >= ?`; `until`→`ts < ?`; `q`→`(command LIKE ? OR text LIKE ? OR result LIKE ?)` with
  `%q%` (escape `%`/`_`? for MVP, no escaping — document it); `afterId`→`id > ?`.
- `queryEvents`: `SELECT * FROM event <where> ORDER BY id ASC LIMIT ?` with `limit=min(f.limit??200,2000)`.
  Map each DB row → `EventRow` (snake→camel; `is_error`→`isError` 1/0/null→true/false/null). `nextAfterId`
  = last row id if rows.length === limit else null.
- `queryFacets`: for each of `project, session, tool, kind, error`, run a GROUP BY with the WHERE built
  from **all filters except that dimension's own** (faceted-search rule, CONTRACTS §6). `session` facet
  groups by `session_id` (value = full id; the UI shortens). `error` facet:
  `SELECT CASE is_error WHEN 1 THEN 'error' WHEN 0 THEN 'ok' END AS value, COUNT(*) … WHERE is_error IS NOT NULL …`.
  Each: `… AND <dim> IS NOT NULL GROUP BY value ORDER BY count DESC LIMIT 200`.
- `expandSession(db, s)`: if `s.length>=32` return `s` if it exists else null; else
  `SELECT session_id FROM session WHERE session_id LIKE ? LIMIT 2` with `s+'%'`; return the id iff
  exactly one match, else (0 or ambiguous) return null.
- `maxEventId(db)`: `SELECT COALESCE(MAX(id),0) AS m FROM event`.
- Parameterize everything (`db.query(sql).all(...params)`); never string-concat user values.

**Tests (`queries.test.ts`):** seed a temp DB (via ingest's `openDb` + direct inserts, or import the
writer) with a known set (e.g. 5 events across 2 projects, 2 tools, one error); assert: `queryEvents`
filters by project/tool/kind/error and paginates by `afterId`; `queryFacets` returns correct counts and
that a facet dimension is **not** narrowed by its own active filter but IS by others; `expandSession`
resolves an 8-char prefix and returns null on ambiguity; `maxEventId` correct.

**Acceptance:** `bun test packages/server/src/queries.test.ts` green; `bun run check` green.

---

## T-1.6 — server: Hono app + static serving (PG2, needs 1.5)

**Files:** `packages/server/src/app.ts` (returns a configured `Hono` instance given `{db, webDir}`),
`packages/server/src/serve.ts` (boots it), `packages/server/src/app.test.ts`.

**Spec:**
- `createApp({ db: Database, webDir: string }): Hono` with routes per CONTRACTS §6:
  - `GET /healthz` → `{ ok:true, dbPath?: optional, events: <count>, maxId: maxEventId(db) }` (events count =
    `SELECT COUNT(*) FROM event`).
  - `GET /api/events` → parse query into `EventFilter` (numbers via `Number()`, guard NaN→undefined; if
    `session` present and length<32, `expandSession`; if it resolves to null, return `{events:[],nextAfterId:null}`);
    `queryEvents`; return JSON.
  - `GET /api/facets` → same parse; `queryFacets`; JSON.
  - `GET /api/events/stream` → **Phase 2** (T-2.2). For Phase 1, register a stub returning 501
    `{error:"not implemented"}` so the route exists.
  - `GET /api/stats` → **Phase 3**. Stub 501 for now.
  - Static: anything else → serve from `webDir` (`index.html` at `/`, files under `/dist/*`). Small
    handler, no static-middleware dep: `normalize` the path and **guard traversal** (reject/403 a path
    that escapes `webDir` after resolving `..`); `const f = Bun.file(join(webDir, path))`; if
    `await f.exists()` return `new Response(f)`, else 404; `/` → `index.html`.
  - On a thrown error in a handler → 500 `{error: String(err)}`; bad numeric param → 400.
- `serve.ts`: `resolvePaths`; open DB **readonly** (`new Database(paths.db, {readonly:true})`); `webDir =
  resolve(import.meta.dir, "../../web")`; build web if `dist/main.js` missing (call `Bun.build` or
  instruct to run `web:build` — for Phase 1, if missing, log a hint and still serve index.html);
  `Bun.serve({ port: Number(process.env.LLLOGS_PORT ?? 7331), fetch: createApp({db,webDir}).fetch })`;
  print `lllogs v2 → http://localhost:<port>`.

**Tests (`app.test.ts`):** seed a temp DB; `const app = createApp({db, webDir: <a temp dir with an index.html>})`;
use `app.request("/healthz")`, `app.request("/api/events?tool=Bash")`, `app.request("/api/facets")` and
assert status 200 + JSON shapes/counts (cast each body: `(await res.json()) as any` — it's `unknown`
under strict TS and fails `bun run check` otherwise); assert `/api/events/stream` → 501; assert `/` returns the
index.html bytes and a missing asset → 404.

**Acceptance:** `bun test packages/server/src/app.test.ts` green; `bun run check` green; manual:
against the smoke DB from T-1.4, `LLLOGS_DB=/tmp/lllogs-smoke.db bun run serve` boots and
`curl localhost:7331/healthz` returns events>0 and `curl 'localhost:7331/api/facets'` returns non-empty
`tool` buckets.

---

## T-1.7 — web: MVP table + facet sidebar (PG2, needs 0.1; codes to the §6 API)

**Files:** `packages/web/index.html`, `packages/web/src/main.ts`, `packages/web/src/api.ts`,
`packages/web/build.ts`. (Vanilla TS + DOM; no framework; no tests required — verified via the e2e
T-1.8 and manual.)

**Spec:**
- `build.ts`: `await Bun.build({ entrypoints:["packages/web/src/main.ts"], outdir:"packages/web/dist", target:"browser", minify:true })`; exit nonzero on failure.
- `index.html`: minimal doc, a two-pane layout — left `<aside id="facets">`, right `<main>` with a
  filter bar (`<input id="q">`, active-filter chips) and a `<table id="events">` (thead with the columns
  PROJECT, SESSION, TIME, KIND, TOOL, COMMAND, ERROR, RESULT, TEXT). `<script type="module" src="/dist/main.js">`.
- `api.ts`: typed fetch wrappers importing types from `@lllogs/shared`:
  `getEvents(filter): Promise<{events:EventRow[], nextAfterId:number|null}>`, `getFacets(filter): Promise<Facets>`.
  Build query strings from a filter object (skip undefined).
- `main.ts`: a tiny app state `{ filter: EventFilter }`. On load and on any filter change:
  `Promise.all([getEvents(filter), getFacets(filter)])` → render. Render:
  - facet sidebar: for each dimension, list `value (count)` rows; clicking sets `filter[dim]=value`
    (toggle off if already set) and re-renders; show the active value highlighted.
  - table: one `<tr>` per event; cells from the row fields (time = `new Date(ts).toLocaleString()`,
    command/result/text truncated to ~200 chars in Phase 1 — rich rendering is Phase 4). Error rows: red
    ERROR cell. Append `nextAfterId` "Load more" button that fetches the next keyset page and appends.
  - the `q` input (debounced ~250ms) sets `filter.q`.
  - Keep it dependency-free; ~200–300 lines of plain DOM is expected. No virtualization needed for MVP
    (cap the table at the fetched page(s)).

**Acceptance:** `bun run web:build` produces `packages/web/dist/main.js`; `bun run check` green (web
tsconfig has DOM lib). Visual correctness is checked in T-1.8 / by the user.

---

## T-1.8 — e2e smoke: fixture tree → ingest → server → assert (PG3, needs 1.4, 1.6, 1.7)

**Files:** `packages/server/src/e2e.test.ts` (or `packages/ingest/test/e2e.test.ts` — keep it in one
place that imports both ingest and server).

**Spec:** in one `bun:test`:
1. Make a temp transcript tree with **known** content: 2 projects, 3 sessions, a deterministic set of
   lines including ≥2 Bash tool_use+result pairs (one an error), a WebFetch result, a prompt, assistant
   text. Compute the expected event count and per-tool / per-kind / per-error counts **by hand in the
   test** (constants).
2. `openDb(tmpDb)`; `runIngest({mode:"backfill", root, db})`.
3. Open a **readonly** Database on `tmpDb`; `createApp({db, webDir})`; via `app.request(...)`:
   - `/healthz` events === expected total.
   - `/api/facets` → `tool` buckets, `kind` buckets, `error` buckets match the hand-computed counts
     **exactly** (this is the headline: accurate server-side facets, no cap).
   - `/api/events?tool=Bash&error=error` returns exactly the expected error rows.
   - `/api/events` paginates: `limit=1` then follow `nextAfterId` reconstructs the full ordered set.
4. Idempotency: `runIngest` again → `/healthz` events unchanged.

**Acceptance:** `bun test <e2e file>` green. This is the **Phase 1 gate** — when green, commit
`feat(v2): MVP ingest+server+web — accurate full-corpus facets` and update the ledger.

---

### Phase 1 dispatch order (for the orchestrator)
PG0: **T-1.1, T-1.2** in parallel. → verify+commit.
PG1: **T-1.3, T-1.5** in parallel (1.3 needs 1.1; 1.5 needs 1.1). → verify+commit.
PG2: **T-1.4, T-1.6, T-1.7** in parallel (distinct files). → verify+commit.
PG3: **T-1.8**. → phase gate commit.

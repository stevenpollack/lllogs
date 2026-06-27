# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Purpose

**clogdy** is a local tool to **investigate past** and **monitor current** Claude Code tool usage. It
ingests Claude Code transcripts (JSONL under `~/.claude/projects`) into a local SQLite database and
serves a React web app over them, with DuckDB for heavy analytics.

**The authoritative v2 spec is [`docs/v2/`](./docs/v2/)** — read it before non-trivial work:

| file | what it is |
| --- | --- |
| `docs/v2/00-ORCHESTRATION.md` | the build plan: DAG, the 9 non-negotiable ground rules, task ledger |
| `docs/v2/01-CONTRACTS.md` | **frozen** interfaces: TS types, the SQLite schema (DDL), the HTTP/SSE API, deps |
| `docs/v2/02-PHASE0.md … 07-PHASE5.md` | per-phase task specs |
| `docs/v2/DECISIONS.md` | every non-obvious decision + verified-gap notes (D-3.*, D-5.*) |
| `docs/v2/REFERENCE-design.md` | architecture rationale (the SQLite/DuckDB concurrency rule) |

## Architecture

```
~/.claude/projects/**/*.jsonl   (source of truth, append-only JSONL)
        │
        ▼  @clogdy/ingest  — bun:sqlite WAL WRITER (the only writer)
   SQLite live store  ($XDG_DATA_HOME/clogdy/clogdy.db)
        │
        ├─▶ @clogdy/server    — Hono HTTP + SSE, bun:sqlite READ-ONLY reader ──▶ @clogdy/web (React)
        │
        └─▶ @clogdy/analytics — DuckDB READ-ONLY ATTACH, separate process the server shells out to
```

Flow is **parse-once, read-many**: `@clogdy/shared`'s `flattenLine` turns each JSONL line into 0..n
`FlatEvent`s (one per content block: prompt / text / thinking / tool_use / tool_result, with derived
`tool`/`command`/`corr`/`isError`/`diff`/`result`/… fields); the ingester writes them idempotently; the
server queries them; the web renders them.

## Non-negotiable ground rules

These are sacred (full list in `docs/v2/00-ORCHESTRATION.md`). A change that violates one is wrong:

1. **Runtime is Bun**, never npm/node. SQLite is the built-in `bun:sqlite`. Tests are `bun:test`,
   co-located `*.test.ts` (Playwright specs use `*.pw.ts` so `bun test` ignores them — see `D-5.i`).
2. **Strict TypeScript.** `bun run check` (typechecks every workspace) must pass — no new `tsc` errors.
3. **SQLite is linked once per process.** A process using `bun:sqlite` must **never** also load DuckDB's
   sqlite extension. So: the ingester writes via `bun:sqlite`; the server reads via `bun:sqlite`; the
   **analytics process uses DuckDB only** and runs as a separate short-lived child the server spawns.
   The server **never imports DuckDB**. (This is what lets DuckDB `ATTACH … READ_ONLY` read the live WAL
   DB while the ingester writes.) **Wire purity:** structured logs go to **stderr or a file, never
   stdout**; the analytics child logs to a **file only** — its stdout (JSON result) and stderr (error
   string) are reserved wires the server reads/forwards.
4. **DuckDB always attaches `READ_ONLY`.** Never open the DB writable from DuckDB.
5. **One writer.** Only the ingester writes the SQLite DB.
6. **JSONL stays source of truth.** The DB is a rebuildable cache; idempotency is enforced by
   `UNIQUE(uuid, block_idx)` + `INSERT OR IGNORE`.
7. **Defensive parsing.** Every transcript field is optional; a malformed line is skipped, not fatal.
8. **Web: never `dangerouslySetInnerHTML` with event data.** React's default escaping is the XSS
   guarantee; render structured data (e.g. `splitBashCommand`/`resultLines`) as JSX elements.
9. **No network** for ingest/server/analytics — local files + localhost HTTP only.

## Toolchain

```bash
bun install                      # install all workspaces; activates lefthook (prepare → lefthook install)
bun start                        # THE entry point: build (if needed) + ingest + watch + serve, one command
                                 #   (packages/server/src/start.ts; flags --dev/--reset/--no-watch/--build/--help)
bun run v2:dev                   # like `bun start` but rebuilds the web bundle on source change (then refresh)
bun run check                    # tsc --noEmit across every workspace
bun test                         # all unit + e2e tests
# Individual stages that `bun start` orchestrates as isolated child processes:
bun run v2:ingest -- --backfill  # build the DB from ~/.claude/projects (--watch to keep tailing; --reset to rebuild)
bun run v2:web:build             # Bun.build the React app → packages/web/dist (--watch to rebuild on change)
bun run v2:serve                 # start the server → http://localhost:7331 (CLOGDY_PORT)
bun run v2:analytics -- --db <path> --metric <name>   # or --query --sql '<SELECT…>'
```

The lefthook pre-commit hook runs `bun run check` + `bun test` and blocks red commits — never
`--no-verify`. Env: `CLOGDY_DB`, `CLOGDY_ROOT`, `CLOGDY_PORT`, `CLOGDY_LOG_LEVEL`, `CLOGDY_LOG_DIR`.

## Logging

Structured JSONL logs (pino, sync-fd — no worker transports) make a run auditable as **evidence**
(asserted on by `bun:test` + Playwright). Quiet by default at `info` on stderr; enable with two env vars,
inherited by every spawned child:
- `CLOGDY_LOG_LEVEL` = `debug|info|warn|error|silent` (default `info`; `debug` for Playwright/CI).
- `CLOGDY_LOG_DIR` = a directory; each process writes its own `<proc>[-<pid>].jsonl` (unset → stderr).

**Logs never go to stdout** (stderr or a file only). The **analytics** child logs to a **file only**
(never stdout/stderr) — its stdout is the JSON-result wire the server parses and its stderr the error wire
it forwards; without `CLOGDY_LOG_DIR` it is silent and the server narrates it. The node sink is
`nodeLogger(proc)` from the **`@clogdy/shared/node`** subpath (kept out of the web bundle); the isomorphic
core (`SCHEMA_OPTS`, `LogEntry`, `parseLogLines`, `selectEvents`) lives in the `@clogdy/shared` barrel.
Dev pretty-printing is an out-of-process pipe: `… 2>&1 | bunx pino-pretty` (never an in-process transport).
In the browser the React app logs to the console; raise the level with `/?log=debug` (→
`localStorage["clogdy:log"]`, default `warn`). **`bun test` is silent by default** (`bunfig.toml` →
`bun-test-setup.ts` defaults `CLOGDY_LOG_LEVEL=silent`; override with `CLOGDY_LOG_LEVEL=debug` — tests that
assert on logs, e.g. analytics log-purity, set their own level). Full reference: `docs/v2/08-LOGGING.md`.

## The v2 packages

- **`@clogdy/shared`** (`packages/shared/`) — no sqlite/http. Types (`FlatEvent`, `EventFilter`,
  `EventRow`, `Facets`), the pure `flattenLine` port, `resolvePaths`, render helpers
  (`splitBashCommand`, `resultLines`), and the SQL guard `assertSelectOnly`. Imported by every package;
  **run `bun install` after changing its export surface** (a `file:` workspace dep is cached — a new
  export otherwise fails to resolve cross-package).
- **`@clogdy/ingest`** (`packages/ingest/`) — `schema.ts` (DDL, `event`/`session`/`ingest_cursor`),
  `tailer.ts` (polls the tree, tails appends, picks up new sessions), batched idempotent `writer.ts`,
  and the `v2:ingest` CLI (`--backfill`/`--watch`/`--db`/`--root`/`--reset`). The **writer** process.
- **`@clogdy/server`** (`packages/server/`) — `queries.ts` (pure functions over a read-only
  `bun:sqlite` handle; `queryEvents` keyset-paginates, `queryFacets` does the exclude-own-dimension
  GROUP BY), `app.ts` (Hono routes incl. SSE and the `Bun.spawn` proxies to the analytics CLI for
  `/api/stats` and `/api/query`), `serve.ts`. Opens the DB `readonly:true`; **imports no DuckDB**.
- **`@clogdy/analytics`** (`packages/analytics/`) — DuckDB-only CLI. `withDuck` does `INSTALL/LOAD
  sqlite` + `ATTACH … READ_ONLY`; `--metric` runs the five metrics; `--query` wraps user SQL in the
  facet CTE `WITH events AS (SELECT * FROM live.event <buildWhere(filter)>) SELECT * FROM (<sql>) LIMIT
  cap+1` and returns `{columns, rows, truncated}`. `buildWhere` binds values as DuckDB params.
- **`@clogdy/web`** (`packages/web/`) — React 19 + `@tanstack/react-table`/`react-virtual` +
  CodeMirror (`@uiw/react-codemirror`), bundled by `Bun.build` (`build.ts`, entry `src/main.tsx`),
  served by `@clogdy/server` from `packages/web/`. Components in `src/components/`. The query layer is
  **facets + read-only SQL atop the faceted data** (the Datasette model): facet selections build an
  `EventFilter`; SQL runs over the facet-scoped CTE via `POST /api/query`. SSE + keyset pause in SQL
  mode; facet counts always come from `/api/facets`, never from the arbitrary SELECT.

## Gotchas (verified during the build)

- **SQL guard is the security boundary**, but the read-only ATTACH is load-bearing: even a guard miss
  can't mutate. `assertSelectOnly` is SELECT/WITH-only, single-statement (string-literal-aware `;` scan
  + comment stripping), blocks `COPY`/`INSTALL`/`LOAD`/DDL.
- **DuckDB crashes on a self-join of the `events` CTE** over the sqlite scanner (upstream bug, `D-5.g`);
  single-scan aggregates/windows are fine.
- **DuckDB returns INTEGER/BIGINT cells as JSON strings** (`D-5.f`) — `COUNT(*)` comes back `"123"`; the
  grid renders text, tests `Number()`-normalize.
- **Build analytics/server test fixtures by spawning the ingest CLI** (separate process), never by
  importing `bun:sqlite` into a file that also loads DuckDB (`D-3.b`). Synthetic JSONL fixtures must end
  with a trailing `\n` (`D-3.e`).
- **UI changes need recorded Playwright evidence** (video + screenshots under
  `docs/v2/artifacts/phase5/`); see `07-PHASE5.md` "Evidence protocol".

## What we're parsing: Claude transcript format

JSONL, one event per line, under `~/.claude/projects/<project-slug>/<session-id>.jsonl`. Fields:
`type` (`user`/`assistant`/`summary`/…), `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`,
`gitBranch`, and a nested `message` (role + `content` blocks — text / `tool_use` / `tool_result`).
tool_result enrichment reads the line-level `toolUseResult` (stdout/stderr, `structuredPatch` for
diffs). **Treat the schema as unstable across Claude Code versions** — inspect a real transcript before
relying on a field and guard for missing keys.

## Conventions

- Edit logic in `packages/*/src/`; `packages/web/dist/main.js` is a committed build artifact —
  regenerate with `bun run v2:web:build`, don't hand-edit.
- Code against the **frozen contracts** (`docs/v2/01-CONTRACTS.md`). If a contract must change, update
  that file first and record why in `docs/v2/DECISIONS.md`.
- Conventional commits scoped to v2 (`feat(v2):`, `fix(v2):`, `chore(v2):`), co-authored.

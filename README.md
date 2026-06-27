# lllogs

A local tool to **investigate past** and **monitor current** Claude Code tool usage — every `Bash`,
`Edit`, `Read`, `WebFetch`, … call Claude makes, its result, latency, and the turn-by-turn flow — in a
fast, filterable web UI with accurate facets and an in-browser SQL query layer.

It reads your transcripts under `~/.claude/projects` (JSONL, the source of truth), ingests them into a
local SQLite database, and serves a React web app over them. Heavy analytics run through DuckDB.

## Architecture

```
~/.claude/projects/**/*.jsonl   (source of truth, append-only)
        │
        ▼  ingester  — bun:sqlite WAL WRITER (the only writer)
   SQLite live store
        │
        ├─▶ server   — Hono HTTP + SSE, bun:sqlite READ-ONLY reader ──▶ React 19 web app
        │
        └─▶ analytics — DuckDB READ-ONLY ATTACH, separate short-lived process (shelled out by server)
```

Invariants (load-bearing — see `docs/v2/`):

- **One writer.** Only the ingester writes the DB; the server and analytics are read-only.
- **SQLite is linked once per process.** The server uses `bun:sqlite`; DuckDB runs as its **own**
  subprocess (`ATTACH … READ_ONLY`) the server spawns — the server never loads DuckDB. (This is the
  concurrency rule that lets DuckDB read the live WAL DB while the ingester writes.)
- **JSONL stays the source of truth.** The DB is a derived cache, fully rebuildable by deleting it and
  re-running backfill. Re-reading a file inserts nothing new (`UNIQUE(uuid, block_idx)` + `INSERT OR
  IGNORE`).

## Prerequisites

- [Bun](https://bun.sh) — runtime, package manager, test runner (not npm).
- No external binaries: SQLite is built into Bun; DuckDB ships as the `@duckdb/node-api` dependency.

## Quick start

```bash
bun install     # install all workspaces; activates the lefthook pre-commit hook
bun start       # build assets if needed, ingest, tail for live updates, and serve
```

Open <http://localhost:7331>. `bun start` is the one command you need: it builds the web bundle when
missing, backfills the DB from `~/.claude/projects`, keeps tailing for new transcripts (live monitoring),
and serves the app — then shuts everything down cleanly on Ctrl-C. Flags: `--dev` (rebuild the bundle on
source changes — then refresh the browser), `--reset` (rebuild the DB), `--no-watch` (serve a static
snapshot), `--build` (force-rebuild the bundle), `--help`. `bun run dev` is shorthand for `--dev`.

<details>
<summary>Run the stages individually</summary>

```bash
bun run ingest -- --backfill   # one-time: build the DB from ~/.claude/projects
bun run web:build              # bundle the React app (Bun.build → packages/web/dist)
bun run serve                  # start the server → http://localhost:7331
bun run ingest -- --watch      # (separate terminal) backfill, then tail continuously
```

</details>

Paths and ports (override via env):

- DB: `$XDG_DATA_HOME/lllogs/lllogs.db` (else `~/.local/share/lllogs/lllogs.db`) — `LLLOGS_DB`.
- Transcript root: `~/.claude/projects` — `LLLOGS_ROOT` (or a positional arg to `ingest`).
- Server port: `7331` — `LLLOGS_PORT`.
- Logging: `LLLOGS_LOG_LEVEL` (default `info`), `LLLOGS_LOG_DIR` (per-process JSONL files) — see [Logging](#logging) below.

## What you get

- **Full-corpus, exact facets.** `project` / `session` / `tool` / `kind` / `error` facets are computed
  server-side with a `GROUP BY` over the *entire* filtered set — counts are exact, not "over the rows
  the browser happened to load." Click to filter; sibling counts stay visible.
- **Virtualized events table.** The grid windows the DOM (`@tanstack/react-virtual`), so a 56k-event
  corpus renders ~20–30 rows in the DOM at a time and scrolls smoothly. Keyset pagination (`afterId`)
  loads more on scroll.
- **Facets + read-only SQL (the Datasette model).** Toggle **ƒx SQL** to query with real SQL that runs
  *atop the faceted data*: your `SELECT … FROM events` is wrapped in a facet-scoped CTE, so SQL sees
  only the rows your facets selected. Powered by the read-only DuckDB subprocess (window functions,
  `quantile_cont`, …). A CodeMirror editor with example queries; results render in a dynamic-column
  grid. Read-only, single-statement, SELECT/WITH-only, capped, with a kill-deadline timeout.
- **Live monitor.** A live toggle streams new events over SSE (`/api/events/stream`) as Claude works,
  with dashboard tiles (total, last-5-min, error rate, top tool).
- **Analytics.** A tab with per-tool counts, error rate, latency p50/p95, per-project rollups, and a
  time-bucket sparkline — computed by the DuckDB CLI.
- **Rich rendering.** Composite Bash commands split into a table (one row per sub-command); Edit/Write
  results as colored unified diffs; a row drawer with the full raw JSON. All rendered via React (no
  `innerHTML` with event data).

## HTTP API (served by `@lllogs/server`)

| method · path | purpose |
| --- | --- |
| `GET /api/events` | filtered, keyset-paginated event rows |
| `GET /api/facets` | exact facet counts (GROUP BY, exclude-own-dimension) |
| `GET /api/events/stream` | SSE live append (`lastId` cursor) |
| `GET /api/stats?metric=…` | analytics metrics (proxies the DuckDB CLI) |
| `POST /api/query` | read-only SQL over the facet-scoped CTE → `{ columns, rows, truncated }` |
| `GET /healthz` | `{ ok, dbPath, events, maxId }` |

See `docs/v2/01-CONTRACTS.md` for the frozen types/schema/API.

## Monorepo layout

A Bun workspaces monorepo. The v2 app is five packages under `packages/`:

| package | role |
| --- | --- |
| `@lllogs/shared` | shared TS types, the flatten port (JSONL line → `FlatEvent`s), config + SQL-guard utils |
| `@lllogs/ingest` | tailer + batched idempotent SQLite writer + schema + CLI (the **writer** process) |
| `@lllogs/server` | Hono HTTP/SSE API + static web serving (the **read-only reader** process) |
| `@lllogs/analytics` | DuckDB read-only query CLI (DuckDB-only process; shelled out by the server) |
| `@lllogs/web` | React 19 + TanStack + CodeMirror SPA, bundled with `Bun.build`, served by `@lllogs/server` |

## Development

| command | what it does |
| --- | --- |
| `bun run check` | `tsc --noEmit` across every workspace |
| `bun test` | unit + e2e tests (`bun:test`) for all packages |
| `bun run ingest -- --backfill\|--watch` | build / live-update the DB |
| `bun run web:build` | bundle the React app |
| `bun run serve` | start the server |
| `bun run analytics -- --metric <name> --db <path>` | run an analytics metric directly |
| `bunx playwright test` (in `packages/web`) | recorded UI tests (video + screenshots) |

A **lefthook** pre-commit hook runs `bun run check` + `bun test`, blocking commits that don't type-check
or pass tests.

**The full build plan, frozen contracts, and design decisions live in [`docs/v2/`](./docs/v2/)** —
start at `00-ORCHESTRATION.md`. See [CLAUDE.md](./CLAUDE.md) for architecture guidance.

## Logging

Every process emits **structured JSONL** (via [pino](https://getpino.io) in sync-fd mode — no
worker-thread transports) so a run is auditable as evidence, not just by its output. Quiet by default;
enable with two env vars, inherited by every spawned child:

- `LLLOGS_LOG_LEVEL` = `silent|error|warn|info|debug` (default `info`; `debug` adds per-request, SSE, and
  analytics-subprocess detail).
- `LLLOGS_LOG_DIR` = a directory; each process writes its own `<proc>[-<pid>].jsonl` (unset → stderr).

```bash
LLLOGS_LOG_LEVEL=debug bun start 2>&1 | bunx pino-pretty   # human-readable logs (pretty is out-of-process)
LLLOGS_LOG_DIR=./logs LLLOGS_LOG_LEVEL=debug bun start     # JSONL → ./logs/{server,ingest,…}.jsonl
```

**Logs never go to stdout** — stderr or a file only. The analytics subprocess's stdout is the JSON
result wire the server parses, so it logs to a **file only** (silent without `LLLOGS_LOG_DIR`). In the
browser, raise the level with `/?log=debug` (the React app logs to the console). `bun test` is silent by
default (`bunfig.toml` → `bun-test-setup.ts`; override with `LLLOGS_LOG_LEVEL=debug`).

`docs/v2/08-LOGGING.md` has the full schema, the `parseLogLines`/`selectEvents` test helpers, and the
Playwright evidence harness that asserts correctness from `server.jsonl` + the analytics file + the
browser console alongside the recorded video.

# Structured logging — the evidence layer

clogdy v2 emits **one structured JSONL schema across every process** so a reviewer (or a Playwright
assertion) can read what the server / analytics child / browser actually *did* and confirm correctness
from the logs, not just the DOM. Implemented with **pino** in sync-fd mode (node) and `pino/browser`
(web) — no worker-thread transports. This is the "evidence layer"; the friendly `clogdy ▸` /
`→ http://localhost` banners stay the "UX layer".

## Architecture — process → sink → level

| proc | sink (default) | sink (`CLOGDY_LOG_DIR` set) |
| --- | --- | --- |
| `server` | stderr (fd 2) | `<dir>/server.jsonl` |
| `ingest` | stderr (fd 2) | `<dir>/ingest.jsonl` |
| `analytics` | **silent** | `<dir>/analytics-<pid>.jsonl` (per-pid: spawned per request, concurrent) |
| `web` | `console.log` | n/a — Playwright captures it via `page.on("console")` + trace |

**Node sink** — `nodeLogger(proc)` from the **`@clogdy/shared/node`** subpath (NOT the barrel — it
touches `fs`/`process`/`pino` and must never enter the browser bundle). Writes
`<CLOGDY_LOG_DIR>/<proc>[-<pid>].jsonl` with `pino.destination({ sync: true })`, so a line is on disk the
moment a request resolves — a spec can read it immediately with no flush race.

**Browser sink** — `packages/web/src/log.ts` (`pino/browser`). pino/browser ignores
`formatters`/`timestamp`/`base`, so a `write` hook re-shapes each record to the node schema (ISO `ts`,
string `level`, `proc:"web"`) and emits a **pure JSON line** via `console.log`. Level resolves from the
**`?log=`** query param → `localStorage["clogdy:log"]` → default `warn`. Navigate with **`/?log=debug`**
to capture client debug events.

### The stdout / stderr / file wire rules (do not break)

1. **Analytics stdout is the data wire** — the server does `JSON.parse(stdout)` over the child's output.
   A stray byte corrupts it, so the analytics logger **never** writes stdout (fd 1).
2. **Analytics stderr is the error wire** — on non-zero exit the server forwards `stderr.trim()` to the
   user. So analytics logs go to a **file only**; without `CLOGDY_LOG_DIR` analytics is **silent** (its
   destination is pinned to fd 2 and forced `silent`, so it can never reach fd 1 even if misused).
3. **Browser-bundle purity** — the node sink lives behind `@clogdy/shared/node`; the web import graph
   never pulls in `pino`'s node build / `fs` / `process`.

### Env

- **`CLOGDY_LOG_LEVEL`** = `silent|error|warn|info|debug` (default `info`; an unknown value does not
  throw — it falls back to `info`/`warn`). `bun start` stays quiet at `info`; Playwright/CI run `debug`.
- **`CLOGDY_LOG_DIR`** = a directory; each process writes its own `<proc>[-<pid>].jsonl`. Every
  `Bun.spawn` inherits `process.env`, so a server started with these two vars set propagates them to the
  analytics children automatically.

Levels: `debug` = `req.start`/`req.end`, `sse.append`, `analytics.attach`; `info` = `server.boot`,
`sse.open`/`close`, `analytics.spawn`/`exit`/`run`/`done`, `web.boot`, `query.submit`/`result`,
`mode.switch`; `warn` = `analytics.timeout`/`failed`, `query.rejected`/`query.error`; `error` =
`sse.poll_failed`, `render.boundary`.

## Evidence schema + helpers

One line, both node and browser:

```json
{"level":"info","ts":"2026-06-27T00:51:58.659Z","proc":"server","pid":650695,"reqId":"be8b8595","evt":"sse.open","cursor":21,"filters":[]}
```

`evt` is the assertable key. Correlation reuses identifiers already threaded through the code: the server
middleware mints a per-request **`reqId`** and binds it on a `log.child`, so every line of one request
(`req.start` → `analytics.spawn` → `analytics.exit` → `req.end`) shares it. `base:{proc,pid}` *replaces*
pino's default `{pid,hostname}`, so committed artifacts leak **no hostname**.

Two pure helpers ship in the **`@clogdy/shared`** barrel (`packages/shared/src/log.ts`), used by both
`bun:test` and Playwright:

- `parseLogLines(text): LogEntry[]` — split on `\n`, `JSON.parse` each, skip blank / non-JSON lines (a
  stray banner or unrelated console noise is ignored).
- `selectEvents(entries, { evt?, level? }): LogEntry[]` — the assertion primitive.

## Evidence protocol (Phase 6)

`packages/web/e2e/logging.pw.ts` is the **log-as-proof** spec. It drives the real UI over a fixture DB,
then asserts the server, the analytics child, and the browser logs line up.

**Wiring (`packages/web/playwright.config.ts`):** `webServer.env` adds `CLOGDY_LOG_DIR` +
`CLOGDY_LOG_LEVEL: "debug"`. The path is defined once in **`e2e/logenv.ts`** as
`packages/web/test-results/clogdy-logs/` — i.e. **under Playwright's `outputDir`**, on purpose (see the
lifecycle gotcha below). `SERVER_LOG = <LOG_DIR>/server.jsonl`.

**What the spec captures and asserts:**

- **server.jsonl** (`readFileSync` → `parseLogLines`): `server.boot` ≥1; a `req.end` with `status:200`;
  `sse.open` ≥1; an `analytics.spawn{mode:"query"}` paired with an `analytics.exit{code:0}` **by
  `reqId`**.
- **analytics-`<pid>`.jsonl** (glob `LOG_DIR`): `analytics.run` ≥1 and `analytics.attach{readOnly:true}`
  ≥1 — end-to-end proof of ground rule #4 (DuckDB attaches READ_ONLY) through the real server→child spawn.
- **browser console** (`page.on("console")` → `parseLogLines` → filter `proc==="web"`): `web.boot`,
  `sse.open`, `mode.switch{to:"sql"}`, `query.submit`, `query.result{rows≥1}`, and `query.error` (the
  invalid `DROP TABLE events` — rejected by the **client** preflight `assertSelectOnly` *before* any POST,
  so it surfaces as a browser `query.error`, **not** a server `query.rejected`).

Assertions are **tolerant** (`.length ≥ N`, not exact) — they are evidence, not exact-count tests.

**Lifecycle gotcha (verified in the playwright 1.61 runner — `createGlobalSetupTasks`):** the task order
is **clear-output → webServer boot → globalSetup**, and the server opens its sync pino fd at boot. So a
`rmSync` in `globalSetup` would unlink `server.jsonl` *out from under the server's open fd* and the spec
would read an empty file. Stale logs are instead cleared by Playwright's own pre-webServer "clear output"
task, which wipes `outputDir` — hence `LOG_DIR` lives under it. `e2e/global-setup.ts` therefore only
`mkdirSync`s the dir; it never clears.

**The fixture** is a known SQLite DB the orchestrator builds by **ingesting a synthetic transcript tree
with the ingest CLI** (a separate process — ground rule #3), then pointing the server at it:

```bash
bun run v2:ingest -- --backfill --root <synthetic-tree> --db <fixture.db>
# then the Playwright webServer runs:  CLOGDY_DB=<fixture.db> bun run v2:serve
```

Run the spec (the DuckDB child can take several seconds — keep generous timeouts):

```bash
cd packages/web
CLOGDY_FIXTURE_DB=<fixture.db> bunx playwright test logging.pw.ts
```

**Artifacts:**

- **Screenshots** (committed, durable): `docs/v2/artifacts/phase6/logging-sql-result.png`,
  `docs/v2/artifacts/phase6/logging-error.png`.
- **Video + trace** (gitignored, delivered to the user):
  `packages/web/test-results/<spec-dir>/video.webm` and `trace.zip`.
- The spec also prints an `[evidence] …` summary (the captured event names per proc) to the run log.

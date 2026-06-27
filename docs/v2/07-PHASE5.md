# Phase 5 — Web framework migration + virtualization + facet/SQL query

Goal: replace the vanilla-TS web SPA with **React 19 + TypeScript** (bundled by the existing `Bun.build`),
**virtualize** the events table so the DOM stays O(visible) on the 56k-event corpus, and add a
**facets + real read-only SQL** query layer (the **Datasette model**) — SQL runs *atop the faceted
data*. The proven JSONL → SQLite(WAL) → DuckDB(read-only) backend is **frozen**; Phase 5 adds exactly
**one** server endpoint (`POST /api/query`) and **one** analytics-CLI mode (`--query`). Per-task gate;
**T-5.7 is the Phase 5 gate**.

This phase is a **user interface**. Correctness is proven by **recorded Playwright artifacts (video +
screenshots)**, not by self-report — see "Evidence protocol" below. It is **mandatory** and load-bearing.

---

## Settled design — DO NOT re-litigate (the user signed off on these calls)

These were researched (`docs/v2/DECISIONS.md` Phase 5 section records them) and **approved**. A subagent
must not reopen them.

1. **No DSL.** The earlier proposal's breser-style query DSL is **dropped**. The query layer is
   **(facets) + (real read-only SQL over the facet-filtered relation)**.
2. **Composition = a facet-scoped CTE.** Facet selections build an `EventFilter` exactly as today. When
   the user runs SQL, the server/CLI wraps it so the user writes `FROM events` and that name resolves to
   the **facet-filtered set** (the exact rewriting is below). SQL composes *on top of* facets, never
   replacing them.
3. **Engine = DuckDB read-only via the existing analytics-CLI subprocess** — **not** `bun:sqlite`
   in the server process. Reuses `withDuck` (READ_ONLY ATTACH) + the `/api/stats` spawn+kill-deadline
   proxy. Ground rule #3 holds: **no DuckDB in the server process.**
4. **Framework = React 19 + `@tanstack/react-table` (headless) + `@tanstack/react-virtual`**, bundled by
   `Bun.build` (Bun transpiles JSX natively — no webpack/vite/babel). React is already a repo dep (the
   Ink TUI runs React 19). DuckDB-Wasm in the browser is **rejected** (multi-MB + corpus shipping).
5. **Editor = CodeMirror 6 + `@codemirror/lang-sql`** (via `@uiw/react-codemirror`). Monaco rejected
   (multi-MB). **Ship CodeMirror unconditionally — no bundle budget, no textarea fallback** (user
   directive D-5.k: bundle size is not a constraint here; the better editing UX is worth the weight).
6. **Facets describe the *input* set; SQL is the *lens*.** While custom SQL is active: **SSE pauses**,
   **keyset paging is replaced by a hard row cap** (a projection may drop `id`), and facet **counts keep
   coming from `/api/facets` over the `EventFilter`** — they are *not* recomputed from the arbitrary
   SELECT (you cannot facet an arbitrary projection; Datasette doesn't either). The facet sidebar stays
   **live and editable** — editing a facet re-runs the wrapped query with a new CTE body. Clearing the
   SQL box returns to the live faceted `/api/events` + SSE path.

These keep the frozen `/api/events`, `/api/facets`, `/api/events/stream` contracts **untouched** — the
default faceted view is byte-for-byte today's behavior; the SQL overlay is strictly additive.

### The exact CTE rewriting (verbatim — the analytics `--query` mode and the e2e assert this)

The user writes SQL against the relation **`events`** (plural — "the events the facets selected"). The
physical table is `event` (singular); the user never names it. The CLI builds:

```sql
WITH events AS (
  SELECT * FROM live.event
  <WHERE built from the EventFilter, exactly like analytics buildWhere()>
)
SELECT * FROM ( <USER SQL> )      -- user SQL references `events`
LIMIT <cap + 1>;                  -- cap+1 so the server can detect truncation (Datasette pattern)
```

- `events` is a CTE, so **every** reference in the user SQL (joins, subqueries, window frames,
  aggregates) sees only the faceted subset — "atop the faceted data" is structurally guaranteed.
- The faceting predicate is built by the **existing** `buildWhere(filter)` in
  `packages/analytics/src/duck.ts`. (T-5.6 hardens it to parameterized binding.)
- The outer `SELECT * FROM (<user sql>) LIMIT cap+1` enforces the cap regardless of the user's own
  `LIMIT`, and is the single place to read `columns[]` and decide `truncated`.
- A user wanting the **raw events** of the faceted set just writes `SELECT * FROM events` — exactly
  today's `/api/events` result, now SQL-addressable.
- **MVP exposes one relation: `events`.** (DuckDB's `live` ATTACH also sees `live.session`; do not expose
  it in MVP unless a task explicitly adds it.)

---

## Evidence protocol — MANDATORY for every UI-touching task (T-5.2, T-5.3, T-5.5, T-5.7)

The deliverable for any UI task includes **recorded Playwright artifacts**, captured by the orchestrator
during verification, **stored on disk**, and **surfaced to the user**. Self-report ("it renders fine") is
**not** acceptance. Concretely:

- **Harness:** add `@playwright/test` as a **root devDependency**; install the browser once
  (`bunx playwright install chromium`). Author specs under `packages/web/e2e/*.pw.ts` (the **`.pw.ts`**
  suffix is mandatory — NOT `.spec.ts`/`.test.ts` — so the lefthook `bun test` gate doesn't discover and
  crash on them; see DECISIONS D-5.i) with a
  `packages/web/playwright.config.ts` setting `use: { video: 'on', screenshot: 'on', trace: 'on' }` and a
  `webServer` (or a manual boot) that serves a **known fixture DB** via `serve` (ingest a fixture tree
  with the ingest CLI first — separate process, ground rule #3). Run with `bunx playwright test`.
  - Note: `@playwright/test` and the Playwright **MCP** are different things; the MCP is fine for ad-hoc
    poking, but the **recorded** video/screenshot artifacts MUST come from `@playwright/test` runs (the
    MCP does not record video). This devDep is a verification harness only — it ships nothing to users.
- **Where artifacts go:** Playwright writes video/trace under `test-results/`. The orchestrator copies the
  **screenshots** for each task into `docs/v2/artifacts/phase5/<T-ID>-<shot>.png` (PNGs are small —
  committed as durable evidence) and keeps the **video(s)** in the scratchpad
  (`/tmp/claude-1000/.../scratchpad/phase5-<T-ID>.webm` — too large to commit) to **deliver to the user**
  via the file-send path. Add `test-results/` and `packages/web/playwright-report/` to `.gitignore`.
- **What each UI task must capture** is listed in that task's Acceptance. At minimum every UI task records
  one **video** of the key interaction and the named **screenshots**.
- The **orchestrator delivers** the captured video(s) + screenshots to the user at each UI-task gate and
  at the Phase 5 gate — the user explicitly asked for this evidence.

---

## Task ledger note

**T-5.0 is already applied by the meta-orchestrator**: `01-CONTRACTS.md` §6 (`POST /api/query`), §7
(analytics `--query` mode), §8 (React/TanStack/CodeMirror), the pinned-deps table (web deps), and the
`docs/v2/DECISIONS.md` Phase 5 section are **in place**. The sub-orchestrator's first action is to
**verify they are present** (read those sections), then dispatch PG0. Do not edit a contract; if one is
wrong, stop and report (contract-change protocol).

---

## T-5.1 — analytics: `--query` mode (read-only DuckDB, facet CTE, cap) + shared SQL guard (PG0, needs 3.1)

**Files:** add `packages/shared/src/sqlguard.ts` + export it from `packages/shared/src/index.ts` (pure,
no I/O — usable by both the analytics CLI and the server); edit `packages/analytics/src/duck.ts` (add
`buildQuery` + `runQuery`); edit `packages/analytics/src/query.ts` (CLI `--query` mode); add
`packages/shared/src/sqlguard.test.ts` and `packages/analytics/src/query.test.ts`.

> **Wiring / gotcha:** `sqlguard.ts` changes `@lllogs/shared`'s export surface → run **`bun install`**
> after adding the export, or a cross-package `import { assertSelectOnly } from "@lllogs/shared"` fails
> with a phantom `Export named … not found` (see 00-ORCHESTRATION "Known gotchas").

**Spec:**
- **`packages/shared/src/sqlguard.ts`** — pure functions, the authoritative SELECT-only guard:
  - `stripSqlComments(sql: string): string` — remove `/* … */` block comments and `-- … <EOL>` line
    comments (so comment-smuggled `;` / keywords can't slip past). Be string-literal-aware enough not to
    strip a `--` inside a `'…'` string (MVP: a simple state machine over single-quoted strings; document
    the limit).
  - `assertSelectOnly(sql: string): void` — throw `Error` with a clear message unless ALL hold (after
    `stripSqlComments` + trimming one trailing `;`): (1) no remaining `;` (single statement); (2) matches
    `/^\s*(WITH|SELECT)\b/i`; (3) contains **none** of the blocked tokens, word-boundary,
    case-insensitive: `ATTACH DETACH PRAGMA INSTALL LOAD COPY EXPORT IMPORT INSERT UPDATE UPSERT DELETE
    DROP CREATE ALTER REPLACE TRUNCATE CALL GRANT REVOKE VACUUM CHECKPOINT` (DuckDB can write files via
    `COPY … TO` and load extensions via `INSTALL`/`LOAD`, so these matter more than in SQLite); (4) the
    user SQL does not itself define a CTE named `events` (shadows the wrapper) — reject `WITH events`
    (case-insensitive) at the start of the user SQL.
- **`packages/analytics/src/duck.ts`**:
  - `buildQuery(userSql: string, filter: EventFilter, cap: number): string` — returns the wrapped CTE SQL
    exactly as in "The exact CTE rewriting" above, using the existing `buildWhere(filter)` for the CTE
    predicate and `LIMIT cap + 1`.
  - `runQuery(conn, userSql, filter, cap): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }>`
    — call `assertSelectOnly(userSql)` first; run `buildQuery(...)` via the DuckDB connection inside
    `withDuck`; read `columns` from the result reader's schema (column names in order); collect rows as
    **arrays of values aligned to `columns`** (compact — avoids per-row key repetition). If the result has
    `> cap` rows, set `truncated = true` and slice to `cap`; else `truncated = false`. (Use the
    existing `withDuck(dbPath, fn)` READ_ONLY ATTACH — never writable.)
- **`packages/analytics/src/query.ts`** CLI — add a `--query` mode alongside the existing `--metric` mode
  (do not break `--metric`):
  `bun run analytics -- --db <path> --query --sql '<SELECT…>' [--filters '<json>'] [--limit <n>]`
  → `cap = min(limit ?? 1000, 5000)`; on success print `JSON.stringify({columns, rows, truncated})` to
  stdout, exit 0; on guard rejection / DuckDB error → message to stderr, exit 1.

**Tests:**
- `sqlguard.test.ts` (pure): accepts `SELECT …`, `WITH x AS (…) SELECT …`; rejects `DROP TABLE event`,
  `SELECT 1; DELETE FROM event`, a comment-smuggled `SELECT 1 /* */; DROP …` and `SELECT 1 -- x\n; DROP`,
  `COPY events TO 'f'`, `INSTALL httpfs`, `PRAGMA …`, a non-SELECT (`VALUES (1)`), and a shadowing
  `WITH events AS (SELECT 1) SELECT * FROM events`. Assert the thrown message names the violation.
- `query.test.ts` (analytics, DuckDB process — **build the fixture DB by spawning the ingest CLI**, then
  open DuckDB; never import `bun:sqlite` here — D-3.b; fixture lines end with `\n` — D-3.e): run
  `runQuery` for (a) a GROUP BY (`SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY
  tool`) and assert columns `["tool","n"]` + hand-computed counts; (b) a **window/quantile** query
  (`SELECT tool, quantile_cont(dur_ms,0.5) p50 FROM events WHERE dur_ms IS NOT NULL GROUP BY tool`) to
  prove DuckDB analytical SQL works; (c) **facet scoping** — pass `filter={project:'X'}` and assert the
  aggregate counts the X subset only, not the whole corpus; (d) **cap+truncated** — a `SELECT * FROM
  events` with `cap=2` over a >2-row fixture returns 2 rows + `truncated:true`.

**Acceptance:** `bun test packages/shared/src/sqlguard.test.ts packages/analytics/src/query.test.ts`
green; `bun run check` green; manual:
`bun run analytics -- --db /tmp/lllogs-smoke.db --query --sql "SELECT tool, COUNT(*) n FROM events GROUP BY tool ORDER BY n DESC"`
prints `{columns,rows,truncated}`.

---

## T-5.2 — web: React 19 + TanStack scaffold migration (no behavior change) (PG0, needs 1.7, 4.2)

**Files:** `packages/web/package.json` (deps), `packages/web/tsconfig.json` (jsx), `packages/web/build.ts`
(entry → `src/main.tsx`), `packages/web/index.html` (root div; keep the dark-theme CSS), and the
`packages/web/src/` rewrite: `src/main.tsx` + a `src/components/` tree; **port unchanged** the pure
modules `src/api.ts`, `src/live.ts`, `src/charts.ts`, `src/cells.ts` (the structured render helpers).

**Spec:** a **strict feature-parity** migration — same behavior, new framework. No new features.
- Deps: `react`, `react-dom` (pin to the tui's `^19.2.7`), `@tanstack/react-table`, `@types/react`,
  `@types/react-dom`. (TanStack **Virtual** is added in T-5.3; CodeMirror in T-5.5.)
- `tsconfig.json`: add `"jsx": "react-jsx"` (mirror `tui/tsconfig.json`).
- `build.ts`: `Bun.build({ entrypoints:['src/main.tsx'], outdir:'dist', target:'browser', minify:true })`
  — only the entry extension changes; CONTRACTS §8 build contract still holds (still `Bun.build`, still
  served by `@lllogs/server` from `packages/web/`).
- `index.html`: keep `<div id="root">` + `/dist/main.js`; reuse the existing CSS.
- Re-express as components, behavior-identical: the **events table** (use a headless
  `@tanstack/react-table` column model — fixed `EventRow` columns, the same colgroup widths), the **facet
  sidebar** (counts from `/api/facets`, active-state, click-to-toggle), **filter chips**, **dashboard
  tiles**, the **Events/Analytics tabs**, the **`q` search box**, the **Live toggle** (SSE via
  `live.ts`), the **row drawer** (raw JSON + full result/text; `corr` click filters), and the
  **Analytics view** (`charts.ts` SVG/divs). Move module-level state into React state/reducer
  (`filter`, `rows`, `nextAfterId`, `liveOn`, `view`, `drawer`).
- **Security:** all event-derived content renders via JSX `{value}` (React escapes by default).
  **NEVER `dangerouslySetInnerHTML` with event data** — this strictly removes the manual-escaping burden
  the v1/T-4.2 note called out. Composite-Bash command tables and colored result/diff lines render from
  the structured `splitBashCommand`/`resultLines` data as JSX elements (one `<tr>`/`<div>` per item),
  never as HTML strings.
- Keep `applyUrlFilter()` (D-4.b): parse `project/session/tool/kind/error/corr/q` from `location.search`
  into the initial filter; reflect `q` into the box.

**Tests:** parity is verified by Playwright (below), not new unit tests; keep all existing
`bun test` green. `bun run check` must pass with the new JSX tsconfig.

**Acceptance:** `bun run web:build` ok; `bun run check` green; existing `bun test` green.
**Evidence (mandatory):** Playwright spec over a known fixture serving via `serve`:
- **Video:** click a `tool` facet → table filters + a chip appears → switch to Analytics tab → switch
  back → open a row drawer → close it. (Proves parity of the core flows.)
- **Screenshots** → `docs/v2/artifacts/phase5/T-5.2-events.png`, `…-facet-active.png`,
  `…-analytics.png`, `…-drawer.png`. Orchestrator delivers the video + shots to the user.

---

## T-5.3 — web: virtualized events table via `@tanstack/react-virtual` (PG1, needs 5.2)

**Files:** edit the events-table component + row store in `packages/web/src/`; `package.json`
(`+@tanstack/react-virtual`).

**Spec:** replace the full-render `<tbody>` with a **windowed virtualizer**.
- `useVirtualizer` over the loaded row buffer; `estimateSize` ≈ 28 px (collapsed row); `measureElement`
  for **true measured heights** (rows are variable — multi-line result cells, composite-command tables);
  reasonable `overscan`. Only the visible window + overscan is in the DOM.
- **Append-on-scroll keyset paging:** when the last rendered index nears the buffer end (e.g. within ~50
  rows of `rows.length`), fetch `getEvents({...filter, afterId: nextAfterId})` and **append** to the row
  store (today's `loadMore` *replaces* — change it to **append**, which virtualization needs). Keyset
  (`id > afterId`, `ORDER BY id ASC`) is already the contract; no server change.
- **Coexist with SSE:** `mergeAppend` (dedupe by id, already in `live.ts`) into the row store; the
  virtualizer renders only the window. Preserve **stick-to-bottom**: check the scroll offset *before*
  append; call `scrollToIndex(last)` *after* **only if** the user was pinned to the bottom.
- The drawer is a separate fixed panel (unchanged) — it does not affect row measurement.

**Tests:** keep `bun test` green (no new units required; the virtualizer is verified by Playwright).
`bun run check` green.

**Acceptance:** `bun run web:build` + `bun run check` green.
**Evidence (mandatory) — this is the headline perf proof:** Playwright over a **56k-event fixture**
(reuse/regenerate the demo DB):
- Assert the **DOM node count / accessibility-tree size is bounded** (low hundreds, **not** O(total) —
  the pre-virtualization demo produced a ~3,145-line a11y tree on ~200 rich rows). Capture the measured
  node count in the test output.
- **Video:** scroll from top through ~10k rows (smooth; DOM stays windowed). **Screenshots** →
  `docs/v2/artifacts/phase5/T-5.3-top.png`, `…-scrolled.png`. Append a live row while pinned to bottom
  and show it stick. Orchestrator delivers video + shots + the node-count number to the user.

---

## T-5.4 — server: `POST /api/query` proxy (guard, facet CTE, cap, kill-timeout) (PG1, needs 5.0, 5.1)

**Files:** edit `packages/server/src/app.ts` (add the route; reuse the `/api/stats` spawn+timeout
pattern, `AppOptions.repoRoot` — D-3.a); add `packages/server/src/query.test.ts`.

**Spec:** `POST /api/query` with JSON body `{ sql: string, filter?: EventFilter, limit?: number }`.
- Parse `filter` from the body (reuse the server's existing `EventFilter` parsing; **expand a short
  8-char `session`** like `/api/events` via `expandSession`).
- **Guard** `sql` with `assertSelectOnly` imported from `@lllogs/shared` (the same authoritative guard
  T-5.1 added) → on throw return **400** `{ error }` *before* spawning (instant feedback, no subprocess).
- Spawn the analytics CLI in **`--query` mode**, mirroring `/api/stats`:
  `Bun.spawn(["bun","run","analytics","--","--db", dbPath, "--query", "--sql", sql, "--filters",
  JSON.stringify(filter ?? {}), "--limit", String(limit ?? 1000)], { cwd: repoRoot, stdout:"pipe",
  stderr:"pipe" })`. **No DuckDB import in the server** (ground rule #3) — it only spawns the CLI.
- **Kill-deadline timeout (10 s):** `Promise.race` the process exit against a 10 s deadline; on overrun
  `proc.kill()` → **504** `{ error: "query timed out" }`. (The only reliable DuckDB timeout — no
  in-process option; this is exactly the proven `/api/stats` mechanism.)
- On exit 0: parse stdout JSON `{ columns, rows, truncated }` and return it (200). On nonzero exit →
  **500** `{ error: <stderr> }`.

**Tests (`query.test.ts`):** drive via `app.request(...)` against a fixture DB built by **spawning the
ingest CLI** (separate process; the server test uses `bun:sqlite` + spawns DuckDB as a child —
compliant). Assert: (1) a valid `SELECT tool, COUNT(*) n FROM events GROUP BY tool` → 200 with
`columns`/`rows` matching a direct `Bun.spawnSync` of the analytics `--query` CLI (compare
order-insensitively for tie-prone aggregates — D-3.f); (2) **facet scoping** — `{sql, filter:{project:X}}`
counts the X subset only; (3) guard rejections → **400** for `DROP …`, multi-statement, `COPY … TO`;
(4) cap respected + `truncated` surfaced. (Timeout → 504 is mechanism-identical to `/api/stats`; verify
manually or with a deliberately heavy cross-join — note which you did.) Cast `(await res.json()) as any`
in tests (TS18046).

**Acceptance:** `bun test packages/server/src/query.test.ts` green; `bun run check` green.

---

## T-5.5 — web: SQL editor + generic result grid wired to facets + `/api/query` (PG2, needs 5.1, 5.2, 5.3, 5.4)

**Files:** edit `packages/web/src/` (add an SQL-editor component, a generic/dynamic-column result grid,
`api.ts` `postQuery`); `package.json` (`+@uiw/react-codemirror`, `+@codemirror/lang-sql`).

**Spec:**
- A **"ƒx SQL" toggle** in the query bar reveals a **CodeMirror 6** SQL editor (`@uiw/react-codemirror`
  with `@codemirror/lang-sql`; SQL highlighting + bracket matching; optionally seed autocomplete with the
  `events` columns from `@lllogs/shared` types). **Ship CodeMirror unconditionally — there is NO bundle
  budget and NO textarea fallback** (user directive, D-5.k: bundle size is not a constraint; CodeMirror's
  UX is worth the weight). Report the final bundle size as informational only.
- **Run** is explicit (**Cmd/Ctrl-Enter** or a Run button — never per-keystroke). On run → `postQuery({
  sql, filter: <current EventFilter>, limit })` → `POST /api/query`. Render the result in the **SAME
  virtualizer** from T-5.3 but with a **dynamic column model** derived from the response `columns[]`
  (`accessorKey: col`; generic cell via JSX `{value}` — React-escaped; never `dangerouslySetInnerHTML`).
- **Banner** above the grid in SQL mode: `Querying N faceted events · live paused · rows capped at C`
  (and `· truncated` when the response `truncated` is true). `N` = the faceted count (from
  `/api/facets`/`/healthz` over the EventFilter).
- **Facet sidebar stays live:** editing a facet changes the EventFilter → **re-runs** the wrapped query
  (new CTE body) **and** refreshes facet counts from `/api/facets`. Facet counts are **never** computed
  from the SELECT (settled design #6).
- **SSE paused** while SQL is active (the banner says so). **Keyset paging disabled** in SQL mode (hard
  cap + truncation banner). The **drawer** is available only when the result has an `id`/`uuid` column
  (gate on its presence).
- **Example-query dropdown** (Datasette's canned-query pattern) — seeds the editor, all written against
  `events`, doubling as docs for the `events` contract, e.g.:
  - `SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool ORDER BY n DESC`
  - `SELECT tool, quantile_cont(dur_ms,0.5) p50, quantile_cont(dur_ms,0.95) p95 FROM events WHERE dur_ms IS NOT NULL GROUP BY tool`
  - `SELECT date_trunc('hour', make_timestamp(ts*1000)) hr, COUNT(*) FROM events GROUP BY hr ORDER BY hr`
- **Deep-linking:** URL carries scope **and** lens — reuse the existing EventFilter query-param names
  **plus** `sql=<encodeURIComponent(...)>`. Presence of `sql` puts the UI in SQL mode on load. A link
  without `sql` is just a filtered event view (back-compatible).
- **Errors:** a query/engine error (the CLI's stderr surfaced as the 400/500 `{error}`) shows inline,
  red, under the editor; the grid keeps the last good result. A client-side `^\s*(WITH|SELECT)` pre-check
  rejects obvious non-SELECT before the round-trip.
- **Clearing the SQL box** returns to the live faceted `/api/events` + SSE view (SSE resumes).

**Tests:** keep `bun test` green; `bun run check` green. (Behavior verified by Playwright.)

**Acceptance:** `bun run web:build` + `bun run check` green; report the **bundle size delta** vs the
T-5.2 baseline (informational only — CodeMirror ships regardless; no budget gate per D-5.k).
**Evidence (mandatory):** Playwright over a fixture:
- **Video:** click a facet → toggle **ƒx SQL** → pick/type a **window-fn query** (`quantile_cont`) →
  run → the **dynamic-column grid** renders → the banner shows `live paused` → edit a facet → the query
  re-runs scoped → clear the SQL box → live faceted view resumes.
- **Screenshots** → `docs/v2/artifacts/phase5/T-5.5-sql-result.png`, `…-error.png` (an invalid query),
  `…-examples.png` (the dropdown open). Orchestrator delivers video + shots to the user.

---

## T-5.6 — hardening: parameterize the facet-CTE `buildWhere` + guard fuzz (PG2, needs 5.1)

**Files:** edit `packages/analytics/src/duck.ts` (`buildWhere` → bound params for the CTE path); extend
`packages/shared/src/sqlguard.test.ts`. *(May be folded into T-5.1 if scheduling prefers; kept separate
so it doesn't block PG0.)*

**Spec:**
- Move `buildWhere` off inline single-quote escaping to **DuckDB bound parameters** for the facet CTE so
  no facet value is ever string-concatenated into SQL. (Facet values originate from our own enum-ish
  filter params, so this is defense-in-depth — but it closes the last inline string-build.)
- **Fuzz the SELECT-guard:** add cases for comment-smuggling (`/* */`, `--`, nested), case/whitespace
  variants (`DrOp`, tab/newline between tokens), `;`-in-string-literal (must NOT be treated as a
  statement separator), and confirm DuckDB-specific `COPY … TO` / `INSTALL` / `LOAD` are blocked.
  Document whether DuckDB itself rejects multi-statement in a single `run` (belt-and-suspenders).

**Acceptance:** `bun test` (shared + analytics) green; `bun run check` green.

---

## T-5.7 — e2e: facet+SQL correctness + virtualization (Phase 5 gate) (PG3, needs 5.3, 5.4, 5.5)

**Files:** `packages/server/src/e2e-query.test.ts`; the Playwright specs under `packages/web/e2e/`
(`phase5.pw.ts` — `.pw.ts` suffix per D-5.i) + `packages/web/playwright.config.ts`.

**Spec:**
- **(a) Facet-scoping correctness (server):** build a fixture DB (ingest CLI on a known tree, separate
  process); `POST /api/query` `SELECT tool, COUNT(*) n FROM events GROUP BY tool` with a facet
  `filter` → assert the counts equal the **faceted subset**, hand-computed — explicitly **different** from
  the same query with no filter (proves "atop the faceted data", not the whole corpus). Include a
  window/`quantile_cont` query returning expected `columns` + a hand-computed p50 from a known `dur_ms`.
- **(b) Guard + cap (server):** `POST /api/query` rejects `COPY … TO`, a `DROP`, and a multi-statement
  (incl. comment-smuggled) → 400; a `SELECT * FROM events` with a small `limit` returns the capped row
  count with `truncated:true`.
- **(c) UI (Playwright, recorded) over a 56k fixture:** facet → toggle SQL → run a window-fn query → the
  dynamic grid renders; the banner shows **live paused**; assert **bounded DOM node count** (the headline
  perf assertion); then clear SQL and confirm the live faceted view + SSE resume. **Record video +
  screenshots** → screenshots to `docs/v2/artifacts/phase5/T-5.7-*.png` (committed), video to scratchpad
  (delivered to the user). Capture the measured node count in the test output.

**Acceptance:** `bun test packages/server/src/e2e-query.test.ts` green; `bunx playwright test` green with
artifacts written; `bun run check` + full `bun test` green → **Phase 5 gate** commit
`feat(v2): Phase 5 — React/TanStack web, virtualized table, facet+SQL query (DuckDB read-only)`.
The orchestrator **delivers the full artifact set (videos + screenshots) to the user** at this gate.

---

### Dispatch / parallelism

```
PG0 {T-5.1 (analytics+shared guard), T-5.2 (web scaffold)}   — disjoint packages
PG1 {T-5.3 (web virtualize, needs 5.2), T-5.4 (server proxy, needs 5.1)}   — disjoint packages
PG2 {T-5.5 (web SQL UI, needs 5.1/5.2/5.3/5.4), T-5.6 (analytics hardening, needs 5.1)}   — disjoint packages
PG3 {T-5.7 e2e + Playwright gate}
```

**File-disjointness:** 5.1/5.6 in `packages/analytics` (+5.1 adds `packages/shared/src/sqlguard.ts`);
5.2/5.3/5.5 in `packages/web` (5.2 scaffolds first → 5.3/5.5 build on it in later PGs); 5.4 in
`packages/server`. Same-PG tasks never share a package. T-5.5 and T-5.6 are disjoint (web vs analytics).

**MVP cut line:** `T-5.1?`→`T-5.2`→`T-5.3` ships the **perf fix + framework migration** with the
**unchanged live faceted view** (the urgent demo problem) — a valid early stop. `T-5.1`→`T-5.4`→`T-5.5`
adds **facet + SQL**, a strictly additive overlay that never blocks the perf fix.

---

## Closing note for the Phase 5 orchestrator

This is the first **UI-centric** phase. Two non-negotiables beyond the usual protocol:
1. **Recorded Playwright artifacts (video + screenshots) are part of acceptance** for every UI task —
   capture, store, and **deliver them to the user**. No artifact, no done.
2. **Never `dangerouslySetInnerHTML` with event data.** React's default escaping is the XSS guarantee
   that replaces v1's hand-escaping; the structured `splitBashCommand`/`resultLines` helpers render as
   JSX elements, never HTML strings.

Backend stays frozen except the two additive surfaces (`POST /api/query`, analytics `--query`). If
anything forces a contract change, stop and report — do not edit `01-CONTRACTS.md` yourself.

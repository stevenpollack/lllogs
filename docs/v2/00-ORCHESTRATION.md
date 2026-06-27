# v2 Orchestration Plan — READ THIS FIRST

You are an **Opus orchestrator**. Your job is to build **lllogs v2**: a local tool to
**investigate past** and **monitor current** Claude Code tool usage, replacing the Logdy proof of
concept. You will do this by spawning **Sonnet implementation subagents**, one task at a time per the
DAG below, verifying each, and committing on green. **Do not write feature code yourself** — your role
is orchestration, integration, verification, and commits. You *may* make tiny glue fixes if a verify
step fails and the fix is unambiguous; otherwise re-dispatch to a subagent with the failure attached.

This plan is self-contained. Everything a subagent needs is in these files. Subagents should **not**
make architectural decisions — every interface, type, SQL statement, file path, and acceptance test is
specified. If a subagent hits a genuine ambiguity not covered here, it must stop and report to you, and
you decide (and record the decision in `docs/v2/DECISIONS.md`, creating it if absent).

## The documents

| file | what it is |
| --- | --- |
| `00-ORCHESTRATION.md` (this) | how to run the build: DAG, conventions, spawn/verify/commit protocol, subagent prompt template, task ledger |
| `01-CONTRACTS.md` | **frozen** interfaces: TS types, the SQLite schema (DDL), the HTTP/SSE API, module boundaries. Every task codes against these. Read before any task. |
| `02-PHASE0.md` · `03-PHASE1.md` · `04-PHASE2.md` · `05-PHASE3.md` · `06-PHASE4.md` · `07-PHASE5.md` | per-phase task specs (T-IDs), each with exact files, signatures, behavior, tests, acceptance, and a ready-to-paste subagent prompt |
| `REFERENCE-design.md` | the architecture rationale (why SQLite+DuckDB, the verified concurrency rule). Background; the contracts already encode its conclusions. |

## Non-negotiable ground rules (tell every subagent)

1. **Runtime is Bun.** Use `bun`, never `npm`/`node`. SQLite access is the built-in `bun:sqlite` (no
   dependency). Tests are `bun:test`, co-located as `*.test.ts`.
2. **TypeScript, strict.** `bun run check` (root) must pass: it typechecks every workspace. No `any`
   leaking across module boundaries (internal `any` with a comment is fine where transcripts are
   genuinely untyped). No new `tsc` errors, ever.
3. **The SQLite-double-link rule is sacred** (see `REFERENCE-design.md` §1). In a single OS process you
   may link SQLite **once**. Concretely: a process that uses `bun:sqlite` must **never** also load
   DuckDB's sqlite extension. Therefore: the **ingester** process writes via `bun:sqlite`; the
   **server** process reads via `bun:sqlite`; the **analytics** process uses **DuckDB only** and runs
   as a **separate short-lived child** the server shells out to. Never mix `bun:sqlite` and DuckDB in
   one process. A task that violates this is rejected.
4. **DuckDB always attaches `READ_ONLY`** (`ATTACH '<db>' AS live (TYPE sqlite, READ_ONLY)`). Never let
   DuckDB open the DB writable.
5. **One writer.** Exactly one process ever writes the SQLite DB: the ingester. The server and
   analytics are read-only. Don't add a second writer.
6. **JSONL stays source of truth.** The DB is a derived cache; it must be fully rebuildable from
   `~/.claude/projects` by deleting it and re-running backfill. Idempotency (re-reading a file inserts
   nothing new) is a hard requirement, enforced by `UNIQUE(uuid, block_idx)` + `INSERT OR IGNORE`.
7. **Defensive parsing.** Treat every transcript field as optional. A malformed line is skipped, never
   fatal. Unknown content-block types are skipped but counted (schema-drift signal).
8. **Don't touch v1.** Leave the existing Logdy config, `src/`, `tui/`, `scripts/follow.ts`,
   `scripts/snapshot.ts`, `logdy.config.json`, and their tests **untouched and passing**. v2 is new
   workspace packages that *reuse logic by porting/copying*, not by mutating v1. v1 is retired only in
   Phase 4 (T-4.4), and only after v2 reaches parity — that task is gated on the user's explicit OK.
9. **No network for ingest/server/analytics.** Everything is local files + localhost HTTP.

## Known gotchas (put these in EVERY subagent prompt — verified during dry-runs)

- **Run `bun install` after changing any `packages/*/src/index.ts` export surface another package
  imports.** Bun resolves `file:` workspace deps through a cached copy under `node_modules/.bun/…` that
  does NOT live-reflect source edits — a cross-package import of a just-added export fails with
  `SyntaxError: Export named 'X' not found` until you re-`bun install`. (Looks like a missing export; it
  isn't.)
- **A package is only importable as `@lllogs/<name>` if its `package.json` declares an entry point.**
  Packages imported by other packages (currently `@lllogs/shared`, `@lllogs/ingest`) MUST have
  `"exports": { ".": "./src/index.ts" }` plus `"module"`/`"types"` pointing at `src/index.ts`. Relative
  intra-package imports work without it, which is why a package can pass its own tests yet be unusable
  cross-package — verify with a real `import { X } from "@lllogs/shared"` from another package.
- **`await res.json()` is typed `unknown` under strict TS.** `bun test` runs fine but `bun run check`
  (the gate) errors `TS18046`. In tests, cast: `const body = (await res.json()) as any`.

## Target layout (v2 packages added to the existing Bun-workspaces monorepo)

The repo root is the `lllogs` (core) workspace; `tui/` is `@lllogs/tui`. Add these workspace packages
(root `package.json` `workspaces` array gains each new dir):

```
packages/
  shared/      @lllogs/shared     — v2 shared TS types + the flatten port + small utils (NO sqlite/http)
  ingest/      @lllogs/ingest     — tailer + sqlite writer + schema + CLI (bun:sqlite WRITER process)
  server/      @lllogs/server     — Hono HTTP+SSE API + static web serving (bun:sqlite READER process)
  analytics/   @lllogs/analytics  — DuckDB read-only query CLI (DuckDB-only process; shelled out by server)
  web/         @lllogs/web         — browser SPA assets, bundled with Bun.build, served by @lllogs/server
```

> Why `packages/` (not root like v1's core): v2 is a clean multi-package app; nesting under `packages/`
> keeps it visually separate from the v1 core that still lives at root. Root `package.json`
> `workspaces` becomes `["tui", "packages/*"]`.

Each new package depends on `@lllogs/shared` via `"@lllogs/shared": "file:../shared"` and on nothing
from v1 core except by **porting** (copying + adapting) — no runtime import of `lllogs` (the Logdy core)
from v2.

## The DAG (build order + parallelism)

Phases are sequential gates (finish + verify + commit a phase before starting the next). **Within** a
phase, tasks marked the same **Parallel Group (PG)** can run concurrently (spawn them in one batch);
tasks in a later PG of the same phase depend on earlier PGs of that phase.

```
PHASE 0 — Scaffolding & contracts        (foundation; everything depends on it)
  T-0.1  monorepo scaffolding (packages, tsconfig, deps, workspaces)         [PG0, solo]
  T-0.2  @lllogs/shared types + flatten port + tests                         [PG1]
  T-0.3  data-dir + config resolution util (@lllogs/shared)                  [PG1]

PHASE 1 — MVP: investigate past, accurately
  T-1.1  @lllogs/ingest: schema module + DB open/migrate                     [PG0]
  T-1.2  @lllogs/ingest: tailer (port follow.ts) → callback sink             [PG0]
  T-1.3  @lllogs/ingest: writer (batched INSERT OR IGNORE) + cursor          [PG1, needs 1.1]
  T-1.4  @lllogs/ingest: backfill CLI wiring (tailer→flatten→writer)         [PG2, needs 1.2,1.3,0.2]
  T-1.5  @lllogs/server: query layer (events + faceted counts) over bun:sqlite [PG1, needs 1.1]
  T-1.6  @lllogs/server: Hono app /api/events /api/facets /healthz + static  [PG2, needs 1.5]
  T-1.7  @lllogs/web: MVP table + facet sidebar (vanilla TS, Bun.build)       [PG2, needs 0.1; integrates 1.6 contract]
  T-1.8  end-to-end smoke: backfill a fixture tree → server → assert facets  [PG3, needs 1.4,1.6,1.7]

PHASE 2 — Live monitor
  T-2.1  ingest: live/follow mode (continuous tail + batched flush)          [PG0, needs 1.4]
  T-2.2  server: SSE /api/events/stream (poll id>lastId, push)               [PG0, needs 1.6]
  T-2.3  web: live tail toggle + dashboard tiles (counts, error rate)        [PG1, needs 2.2,1.7]
  T-2.4  e2e: append to a live fixture, assert SSE delivers it               [PG2, needs 2.1,2.2]

PHASE 3 — DuckDB analytics
  T-3.1  @lllogs/analytics: DuckDB query CLI (read-only ATTACH) + queries    [PG0, needs 1.1]
  T-3.2  server: /api/stats proxy → spawn analytics CLI                      [PG1, needs 3.1,1.6]
  T-3.3  web: analytics view (latency p50/p95, error trends, rollups)        [PG2, needs 3.2,1.7]
  T-3.4  e2e: stats endpoint correctness vs known fixture                    [PG2, needs 3.2]

PHASE 4 — Polish & retire v1
  T-4.1  shared: render helpers port (command splitter, diff/result render)  [PG0, needs 0.2]
  T-4.2  web: rich rendering using 4.1 (composite cmd table, colored diff)   [PG1, needs 4.1,1.7]
  T-4.3  tui integration: @lllogs/tui can launch v2 (server) for a selection [PG1, needs 1.6]
  T-4.4  retire v1 (Logdy) — GATED on explicit user OK                       [PG2, needs parity]

PHASE 5 — React/TanStack web + virtualization + facet/SQL query (UI phase; recorded Playwright evidence)
  T-5.0  CONTRACTS §6/§7/§8 + DECISIONS Phase 5 — ALREADY APPLIED by meta-orchestrator (verify, don't edit)
  T-5.1  analytics: --query mode (read-only DuckDB facet CTE) + shared SQL guard [PG0, needs 3.1]
  T-5.2  web: React 19 + TanStack scaffold migration (strict parity)         [PG0, needs 1.7,4.2]
  T-5.3  web: virtualized events table (@tanstack/react-virtual)             [PG1, needs 5.2]
  T-5.4  server: POST /api/query proxy (guard, facet CTE, cap, kill-timeout) [PG1, needs 5.0,5.1]
  T-5.5  web: SQL editor + generic result grid wired to facets + /api/query  [PG2, needs 5.1,5.2,5.3,5.4]
  T-5.6  hardening: parameterize facet-CTE buildWhere + guard fuzz           [PG2, needs 5.1]
  T-5.7  e2e: facet+SQL correctness + virtualization (Playwright artifacts)  [PG3, needs 5.3,5.4,5.5]
```

## Orchestration protocol (do this for every task)

1. **Pre-flight (once per phase):** ensure the previous phase is committed and `bun run check` +
   `bun test` are green at root. Read the phase file.
2. **Dispatch a PG:** for each task in the current parallel group, spawn one Sonnet subagent using the
   **prompt template** below, with `mode: "auto"` (so it can edit/run without stalling) and
   `subagent_type` of your general implementation agent. Spawn an entire PG in **one message** (multiple
   tool calls) so they run concurrently. Tasks that write the **same files** must never share a PG — the
   DAG above already guarantees this; if you ever deviate, give each its own git worktree
   (`isolation: "worktree"`).
3. **Collect + verify:** when a subagent returns, run that task's **Acceptance** commands yourself
   (don't trust the agent's self-report). All of: `bun run check` (root), the task's `bun test` files,
   and any task-specific verify command must pass.
4. **On failure:** re-dispatch a Sonnet agent with the exact failing output and the task spec; do not
   hand-fix unless it's a one-line obvious glue error. Never mark a task done on a red verify.
5. **On success:** update the **Task Ledger** below (flip `[ ]`→`[x]`), and **commit** at task or PG
   granularity with a conventional message (see Commit protocol). Then proceed.
6. **Phase gate:** after the last PG of a phase, run the phase's **e2e** task, then commit a phase tag
   line in the ledger. Only then start the next phase.

### Subagent prompt template (fill the `<…>`)

```
You are implementing ONE task in the lllogs v2 build. Do exactly what this spec says and nothing more.
Make no architectural choices; everything is specified. Use Bun (never npm/node). Strict TypeScript.

READ FIRST (required, in the repo at /home/steven/repos/lllogs):
- docs/v2/00-ORCHESTRATION.md  → "Non-negotiable ground rules" (all 9) and "Target layout"
- docs/v2/01-CONTRACTS.md      → the frozen types/schema/API your code must match EXACTLY
- docs/v2/<PHASE FILE>          → your task: <T-ID> <title>

YOUR TASK: <T-ID> — paste the full task spec block from the phase file here.

HARD REQUIREMENTS:
- Create only the files listed under "Files" in the spec. Match every signature/type/SQL verbatim.
- Write the tests listed under "Tests" and make them pass with `bun test <files>`.
- `bun run check` (from repo root) must pass with zero new errors.
- Obey ground rule #3 (SQLite single-link) and #8 (don't touch v1) absolutely.
- Do NOT commit. Do NOT modify files outside your task's "Files" list (except adding your package to
  root package.json `workspaces`/deps ONLY if your spec's "Wiring" section says to).

WHEN DONE, report: the files you created, the exact `bun test`/`bun run check` output tails proving
acceptance, and any deviation or ambiguity you hit (if you had to guess, say so loudly).
```

## Commit protocol

- Branch: work on `main` is fine (this is a solo personal repo and the user pushes from here); if the
  user later asks for a feature branch, create `v2` and target it.
- Conventional commits, scoped to v2: `feat(v2): …`, `chore(v2): …`, `test(v2): …`. One commit per task
  (or per PG when tasks are tightly coupled). Body: what landed + which T-ID(s).
- Co-author trailer on every commit:
  `Co-Authored-By: Claude <noreply@anthropic.com>`
- The lefthook pre-commit hook runs `bun run check` + `bun test` and will block a red commit — that's
  your safety net; never `--no-verify`.
- Do **not** push unless the user says so.

## Validation status

**Phases 0 and 1 were dry-run-validated** (Opus agents, isolated worktrees) and both build fully green —
root `bun run check` passes all packages; `bun test` = 60 v1 + 27 Phase-0 + 36 Phase-1 = 123, 0 fail; no
v1 file touched; the **T-1.8 e2e** asserts facet/error/pagination counts match a hand-computed fixture
exactly. All findings are folded in: Phase 0's 10 (DuckDB exact-pin, per-block enrichment, null-fill,
`isError`/`inputJson`/`resolvePaths`, `check`-dedup, `type:module`, web `target`) and Phase 1's
(the F1 package-entry-point blocker → see the gotchas above + PHASE0 T-0.1; the `GROUP BY value` facet
SQL; `first_ts`/`last_ts` upsert binding; ingest `index.ts` exports + server devDep; static-handler
traversal guard; `EventRow.cwd` always null). The bun:sqlite and facet-SQL assumptions were verified
correct against real Bun. **Phase 2 was orchestrated for real** (an Opus orchestrator dispatching Sonnet
subagents per the DAG, nesting works in this env): green, 142 tests, the T-2.4 live e2e + a live SSE
`curl` smoke both pass; its 4 findings are folded in (the `signal?: AbortSignal` watch-stop, the
`lastId`-vs-`afterId` stream-cursor distinction, `pollNewEvents` in §6, the no-match session sentinel).
**Phases 3–4 are NOT yet validated** — record gaps in `DECISIONS.md`. **Phase 5 is NOT dry-run-validated**
— its design (facets + real SQL atop a facet-scoped CTE, DuckDB-subprocess engine, React/TanStack/
CodeMirror, no DSL) was researched and **user-approved** (DECISIONS.md Phase 5; full spec `07-PHASE5.md`).
Phase 5 is the first **UI-centric** phase: **recorded Playwright artifacts (video + screenshots) are part
of acceptance** for every UI task and must be delivered to the user — see `07-PHASE5.md` "Evidence
protocol". Biggest unknowns to prove early: (1) the analytics `--query` mode returns a clean
`{columns,rows,truncated}` for window/quantile SQL over the facet CTE (T-5.1); (2) the kill-deadline
timeout fires (T-5.4, mirrors `/api/stats`); (3) virtualization bounds the DOM on the 56k corpus (T-5.3).

## Task Ledger (update as you go)

Phase 0 — Scaffolding & contracts  ✅ built & on `v2` (de541b3)
- [x] T-0.1 monorepo scaffolding
- [x] T-0.2 @lllogs/shared types + flatten port
- [x] T-0.3 config/data-dir util

Phase 1 — MVP  ✅ built green (123 tests, e2e facets exact); harvested onto `v2`
- [x] T-1.1 ingest schema + DB open/migrate
- [x] T-1.2 ingest tailer (port follow.ts)
- [x] T-1.3 ingest writer (batched, idempotent)
- [x] T-1.4 ingest backfill CLI
- [x] T-1.5 server query layer (events + facets)
- [x] T-1.6 server Hono app + static
- [x] T-1.7 web MVP table + facets
- [x] T-1.8 e2e smoke

Phase 2 — Live monitor  ✅ orchestrated (Sonnet subagents), green (142 tests, live e2e + SSE smoke)
- [x] T-2.1 ingest live mode
- [x] T-2.2 server SSE stream
- [x] T-2.3 web live tail + tiles
- [x] T-2.4 e2e live

Phase 3 — DuckDB analytics  ✅ orchestrated (Sonnet subagents), green (160 tests); DuckDB READ_ONLY-over-live-WAL proven
- [x] T-3.1 analytics DuckDB CLI
- [x] T-3.2 server /api/stats proxy
- [x] T-3.3 web analytics view
- [x] T-3.4 e2e stats

Phase 4 — Polish & retire  ✅ T-4.1–4.3 orchestrated (Sonnet subagents), green (180 tests); T-4.4 awaits user OK
- [x] T-4.1 render helpers port
- [x] T-4.2 web rich rendering
- [x] T-4.3 tui → v2 integration
- [ ] T-4.4 retire v1 (GATED on user OK — NOT done; v1 intact)

Phase 5 — React/TanStack web + virtualization + facet/SQL query  ✅ built green (233 tests; recorded Playwright evidence T-5.2/5.3/5.5/5.7)
- [x] T-5.0 contracts §6/§7/§8 + DECISIONS Phase 5 (applied by meta-orchestrator)
- [x] T-5.1 analytics --query mode + shared SQL guard
- [x] T-5.2 web React/TanStack scaffold migration (parity)
- [x] T-5.3 web virtualized events table (56k corpus → 20 DOM rows top / 31 after scroll)
- [x] T-5.4 server POST /api/query proxy
- [x] T-5.5 web SQL editor (CodeMirror) + generic result grid (facet-scoped SQL)
- [x] T-5.6 hardening (parameterize buildWhere + guard fuzz)
- [x] T-5.7 e2e facet+SQL + virtualization (Playwright video+screenshot artifacts)

## What "done" looks like (acceptance for the whole build)

A user runs (from the repo root):
```
bun run ingest -- --backfill           # one-time: build the DB from ~/.claude/projects
bun run serve                          # starts the server; prints http://localhost:7331
# opens the URL: a filterable table over the FULL corpus, accurate facet counts, no 100-row cap;
# a live tab that updates as Claude works; an analytics tab with per-tool/error/latency rollups.
bun run ingest -- --watch              # (separately) keeps the DB live
```
All `bun run check` + `bun test` green; v1 still works until T-4.4 retires it.

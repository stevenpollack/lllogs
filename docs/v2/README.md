# clogdy v2 — build plan

Next iteration: a local tool to **investigate past** and **monitor current** Claude Code tool usage,
replacing the Logdy proof of concept. Architecture: JSONL (source of truth) → one ingester → **SQLite
(WAL)** live store → **DuckDB (read-only, separate process)** analytics → a small local web UI.

**To build it:** open **[`00-ORCHESTRATION.md`](./00-ORCHESTRATION.md)** — it's the entry point for an
Opus orchestrator driving Sonnet implementation agents. It links the frozen contracts
([`01-CONTRACTS.md`](./01-CONTRACTS.md)) and the per-phase task specs (`02-PHASE0.md` … `07-PHASE5.md`).
Background/rationale is in [`REFERENCE-design.md`](./REFERENCE-design.md); settled cross-cutting calls are
logged in [`DECISIONS.md`](./DECISIONS.md). Phases 0–4 are built (on the `v2` branch); **Phase 5**
(React/TanStack web, virtualized table, facets + read-only SQL) is designed/user-approved and ready to
orchestrate — it requires **recorded Playwright artifacts** as UI evidence (`07-PHASE5.md`).

Hand `00-ORCHESTRATION.md` to a fresh Opus instance and tell it to execute the plan — no extra prompting
needed.

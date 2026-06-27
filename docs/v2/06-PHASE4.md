# Phase 4 — Polish & retire v1

Goal: port the v1 render quality (composite-command tables, colored diffs/results) into the v2 web app,
wire the existing Ink TUI as a scope launcher for v2, and — only on the user's explicit OK — retire the
Logdy v1 stack. Gate per task; T-4.4 is **human-gated**.

---

## T-4.1 — shared: render-helpers port (PG0, needs 0.2)

**Files:** `packages/shared/src/render.ts`, `packages/shared/src/render.test.ts`; export from
`packages/shared/src/index.ts`.

**Spec:** pure functions ported from `src/columns/audit.ts` (v1), but returning **structured data** the
web renders to DOM safely (so we do NOT ship raw-innerHTML strings; the web builds elements). Port:
- `splitBashCommand(cmd: string): string[]` — the exact quote/escape/comment-aware splitter from
  `commandColumn` (v1 lines 116–162): top-level `;`/newline split, `&&`/`||`/`|` keep joined incl.
  trailing-operator continuation, quotes/escapes/`#`-comments respected. Returns the trimmed non-empty
  segments. (No HTML — the web makes one `<tr>` per segment via `textContent`, so no XSS surface.)
- `resultLines(e: { resultHead?, diff?, result?, stderr? }): Array<{ text: string; color?: "add"|"del"|"head"|"err" }>`
  — the `resultColumn` logic (v1 lines 199–240): head (color "head"), diff (+→"add", -→"del", else none),
  else result lines then stderr ("err"); capped at 14 with a synthesized `"… N more lines"` final entry;
  each text clipped to 200. Return data, not HTML.
- Keep these dependency-free and unit-test them with the **same cases** v1's `audit.test.ts` covers
  (read it; reproduce the command-splitter cases: `echo "a;b"`, `find … -exec … \;`, quoted newlines,
  `#` comments with apostrophes, `&&`/`|` joins, trailing-operator continuation).

**Tests (`render.test.ts`):** the command-splitter cases above (assert segment arrays); `resultLines`
for a diff, for stdout+stderr, for the 14-line cap, for a lone plain line.

**Acceptance:** `bun test packages/shared/src/render.test.ts` green; `bun run check` green.

---

## T-4.2 — web: rich rendering using 4.1 (PG1, needs 4.1, 1.7)

**Files:** edit `packages/web/src/main.ts` (+ a `packages/web/src/cells.ts`).

**Spec:** replace the Phase-1 truncated command/result cells with:
- COMMAND cell: if `tool==="Bash"` and `splitBashCommand(command).length>1`, render a nested one-column
  table (one `<tr><td>` per segment, via `textContent` — never innerHTML); else plain text.
- RESULT cell: render `resultLines(event)` as colored lines (CSS classes `add`/`del`/`head`/`err` →
  green/red/grey/red), built with DOM `textContent` (no innerHTML). 
- A row drawer: clicking a row opens a panel showing the full `raw` JSON (pretty-printed) and the full
  untruncated result/text. Correlation: clicking a `corr` filters to that `corr` (shows the call+result).
- **Security:** all cell content goes through `textContent`/DOM construction — never `innerHTML` with
  event data. (v1 had to hand-escape because Logdy used innerHTML; we avoid the whole class of bug.)

**Acceptance:** `bun run web:build` ok; `bun run check` green; manual: composite Bash commands and
diffs render like v1 (or better).

---

## T-4.3 — TUI → v2 integration (PG1, needs 1.6)

**Files:** edit `tui/picker.tsx` (add an opt-in path; **keep the existing Logdy path** until T-4.4).

**Spec:** add a `--v2` flag to the picker. When set, on `enter` the handoff: ensure a v2 server is
running (spawn `bun run serve` from coreRoot if `GET /healthz` on the port fails), then build a URL
with the selection encoded as filter query params (`?project=…` or repeated `session=…` — the picker
already has `collapseSelection`; map it to `project`/`session` filter params, noting the API takes a
single `project`/`session` — for multi-select, prefer opening the project filter, or open the table
unfiltered scoped by the first selection and document the limitation). Print the URL. Do **not** remove
the Logdy default; `--v2` is additive until v1 is retired.

**Acceptance:** `bun run check` green; manual: `bun run picker -- --v2`, select, enter → opens the v2 UI
scoped to the selection.

> Note: the current multi-select → single-`project`/`session`-filter mismatch is a real limitation. If
> multi-session scoping matters, the orchestrator may extend the API to accept repeated `session=`
> params (OR-combined) as a small follow-up task — record it in DECISIONS.md before doing so.

---

## T-4.4 — Retire v1 (Logdy) — HUMAN-GATED (PG2)

**Do not run without the user's explicit go-ahead.** Parity checklist first (orchestrator confirms): v2
covers browse+filter (T-1.x), live monitor (T-2.x), analytics (T-3.x), rich rendering (T-4.2), TUI
launch (T-4.3); the user has used v2 and signed off.

**On approval, in one `chore(v2): retire Logdy v1` commit:**
- Remove: `src/` (Logdy handlers/types), `scripts/build-config.ts`, `scripts/follow.ts`,
  `scripts/snapshot.ts`, `logdy.config.json`, `config.base.json`, the `tui` Logdy handoff path (make
  `--v2` the default / only path), and the v1-only root scripts (`build`, `follow`, `snapshot`,
  `picker`'s Logdy branch). Keep `scripts/lib/sessions.ts` only if still used by the TUI; otherwise port
  it into `@lllogs/shared` and remove.
- Update `CLAUDE.md` + `README.md` to describe v2 as the tool (archive the Logdy sections or move them to
  `docs/v1-logdy-archive.md`).
- Ensure `bun run check` + `bun test` green with v1 gone; update the root `check` script (drop the v1
  pieces). Renumber/clean the `bun run` scripts so `v2:*` become the primary verbs (consider dropping
  the `v2:` prefix once v1 is gone — record the rename in DECISIONS.md).

**Acceptance:** green build with v1 removed; docs updated; user confirms v2 is the tool.

### Dispatch: PG0 {T-4.1} → PG1 {T-4.2, T-4.3} ∥ → PG2 {T-4.4 — gated}.

---

## Closing note for the orchestrator
After Phase 3 (before Phase 4), lllogs v2 already **beats Logdy** on every axis the user cared about:
full-corpus accurate facets, live monitoring without the backlog cap, and server-side analytics. Phase 4
is quality + decommissioning. If the user wants to stop at "v2 works, keep v1 around," that's a valid
endpoint — Phase 4.4 is explicitly optional and gated.

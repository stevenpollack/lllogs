# Evidence — `role` dimension, re-arrangeable columns, full-row drawer

Branch `v2-role-cols-drawer` (off `v2`). Runtime verification via Playwright (MCP) against a server on
`:7399` over a freshly `--reset` ingested scratch DB (63,307 events, `role` backfilled). See `D-5.n`
(DECISIONS) and the contract diffs in `01-CONTRACTS.md`.

Only console message is the benign `favicon.ico` 404 (no favicon shipped; `D-3.h`). `bun run check`
(6 workspaces) + `bun test` (276 pass / 0 fail) green.

## 1. `role` column — `role-01-initial.png`
The events grid gains a `ROLE` column (between `KIND` and `TOOL`). The data shows `role` is **orthogonal
to `kind`**: a `text` block authored by `user`, alongside `prompt`/`tool_result`→`user` and
`thinking`/`tool_use`→`assistant`. `kind` alone cannot reconstruct this.

## 2. `role` facet + filter — `role-02-filter-user.png`
Clicking `role = user` (sidebar) filters the grid (chip `role: user ✕`, URL `?role=user`). Proves:
- the **facet** lists `assistant 38732 / user 24575`, and stays full-count under the
  exclude-own-dimension rule even with `role=user` active (Datasette semantics);
- **orthogonality again**: the `KIND` facet collapses to exactly the user-authored kinds —
  `tool_result 21995`, `prompt 2365`, `text 215` (no `tool_use`/`thinking`). That `text 215` is the
  user-authored-text population that `kind=text` otherwise hides among 11,587 assistant-text events.

## 3. Re-arrangeable columns — `role-03-reordered.png`
Dragging the `ROLE` header onto `PROJECT` moves it: order becomes `ROLE, PROJECT, SESSION, TIME, KIND,
TOOL, …`, data cells following. Native HTML5 DnD (no new dependency); order persists to
`localStorage["clogdy.eventsColOrder.v1"]`. Resizing/sorting still work; the SQL-result grid (which omits
the `onReorder` prop) is unaffected.

## 4. Full-row drawer — `role-04-drawer-zoom.png`
Clicking a row opens the drawer with a metadata grid of **every present scalar** `EventRow` field —
`id, project, session` (full id), `ts, kind, role, isError, corr` (click-to-filter), `parentUuid,
blockIdx, gitBranch` — so the drawer is the whole row regardless of which columns are hidden or
reordered. Null fields (`tool`, `durMs`, `cwd`) are skipped; `raw` follows. The raw JSON confirms
`"message": { "role": "user" }`.

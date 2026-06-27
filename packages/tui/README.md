# @clogdy/tui-v2

A terminal live-monitor for clogdy v2 — built for watching a Claude Code session
on a **headless box or inside a docker container**, over SSH / `docker exec`,
where the browser UI isn't an option.

It is **not** a port of the web app. It deliberately drops the terminal-hostile
parts (the SQL editor, analytics, wide investigation grids) and keeps the
monitoring essentials: a live event tail, facet filtering, a substring search,
column control, and a detail drawer.

## Run

```bash
bun run v2:tui                  # spawn the ingester + monitor the default DB
bun run v2:tui -- --no-ingest   # attach to an externally-managed ingester (e.g. `bun start`)
bun run v2:tui -- --db <path>   # an explicit DB
bun run v2:tui -- --help
```

By default `v2:tui` is self-contained: it spawns `v2:ingest --watch` (the single
writer) with its logs redirected to a file so nothing corrupts the screen, then
renders a read-only view. Run it where the transcripts live (the same box /
container as the Claude session) — SSH / `docker exec` is just the terminal
transport; nothing crosses the network.

## Keys

| key            | action                                                                           |
| -------------- | -------------------------------------------------------------------------------- |
| `↑↓` / `j` `k` | move cursor (`PgUp`/`PgDn` page · `g`/`G` top/bottom)                            |
| `←→` / `h` `l` | scroll columns horizontally                                                      |
| `↵`            | open the detail drawer for the row                                               |
| `/`            | substring search (command · text · result); Enter applies, Esc cancels           |
| `f`            | facet picker (project/session/tool/kind/role/error; space toggles, multi-select) |
| `c`            | column manager — space show/hide · `f` freeze (pin) any column · `s` cycle sort  |
| `p`            | pause / resume the live tail                                                     |
| `Esc`          | (table) clear all filters                                                        |
| `q`            | quit (or back out of a pane)                                                     |

In the drawer: `↑↓` scroll · `r` toggle raw-JSON / structured · `x` re-scope to the
record's correlation id · `q` / `Esc` close.

## Architecture

Co-located, zero network. The process opens the SQLite store read-only via
`bun:sqlite` and reuses the server's pure query functions
(`@clogdy/server/src/queries`) plus the shared render helpers (`@clogdy/shared`)
through a `DataSource` seam — DuckDB and Hono never enter the process (ground
rules #3/#5/#9). The live tail is a ~1s keyset poll; facet counts come from
`queryFacets`. See the plan in `.claude/plans/` and `docs/v2/` for the rationale.

## Tests & evidence

`bun test ./packages/tui` — pure-logic units (layout, scroll-pin, filters,
facets, sort, drawer builders) + `ink-testing-library` interaction tests (search,
facet toggle, column hide/sort, drawer open/raw/correlate) + a logging
integration test (the spawned ingester's logs stay off the TTY). Recorded
terminal evidence (VHS) lives under `docs/v2/artifacts/tui/`.

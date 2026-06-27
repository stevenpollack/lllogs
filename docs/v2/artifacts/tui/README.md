# TUI evidence (`@lllogs/tui`)

Text-frame snapshots of each view, captured from a **synthetic fixture** (no real
transcript data) via `ink-testing-library`. Text frames are the terminal analog
of the web's Playwright screenshots — and they diff cleanly in review.

| frame | shows |
| --- | --- |
| `01-events-table.txt` | live tail · status pulse (`N/5m`) · frozen TIME column |
| `02-horizontal-scroll-frozen-time.txt` | ←/→ scrolled — TIME stays pinned while other columns shift |
| `03-facets.txt` | facet picker — exclude-own-dimension counts across every dimension |
| `04-column-manager.txt` | show/hide · PIN (freeze) · sort markers |
| `05-search.txt` | `/` substring search input |
| `06-drawer-structured-diff.txt` | detail drawer — header + command + colored unified diff |
| `07-drawer-raw-json.txt` | drawer raw-JSON pretty-print toggle |

The durable automated evidence is the `ink-testing-library` interaction suite in
`packages/tui/src/App.test.tsx` (search, facet toggle, column hide/sort, drawer
open/raw/correlate) plus the pure-logic units.

## Recorded GIFs (VHS)

`tapes/*.tape` render animated GIFs + PNGs of the **real** `tui` binary in a
pseudo-terminal — the terminal analog of the web's recorded Playwright video.
They need [charmbracelet/vhs](https://github.com/charmbracelet/vhs) (+ `ttyd`)
installed, and a populated DB (`bun start` once). From the repo root:

```bash
vhs docs/v2/artifacts/tui/tapes/monitor.tape   # wide: table · hscroll · facets · drawer
vhs docs/v2/artifacts/tui/tapes/narrow.tape    # 80-col: ←/→ to reach off-screen columns
```

> VHS was not installed when these were authored, so only the text frames above
> are checked in; the tapes are ready to render once it is.

# Evidence — in-cell formatting / Drawer pretty-printing

Feature: human-readable `tool_use` input and `tool_result` output.

- **Cells** (`EventsTable.tsx`): non-Bash `tool_use` rows render a compact
  `formatToolInput()` preview (path + `N → M lines`, etc.) instead of the bare
  primary arg. Bash split (`splitBashCommand`) unchanged.
- **Drawer** (`Drawer.tsx`): three libraries —
  - `@uiw/react-json-view` for tool **input** (and JSON results),
  - `react-diff-view` for **diffs** (via the new `reconstructUnifiedDiff(raw)`
    shared helper → `parseDiff` → line numbers + word-level `markEdits`),
  - `prism-react-renderer` for the Bash **command** / Write **content**.
  Every rich renderer degrades to the prior `<pre>` on bad/absent data.

Captured against the real local DB (≈61k events) on `http://localhost:7399`,
React 19.2.7, prod (minified) bundle. Browser console clean apart from a benign
`favicon.ico` 404 — i.e. no React-19 runtime warnings from the three libraries.

| screenshot | shows |
| --- | --- |
| `01-cells-edit-preview.png` | Edit rows: `command` cell now shows `<path>` + dimmed `N → M lines` |
| `02-drawer-json-input.png` | `@uiw/react-json-view` collapsible tree for an Edit's tool input |
| `03-drawer-diff-view.png` | `react-diff-view` unified diff: dual old/new gutters, green insert, word-level mark |
| `04-drawer-prism-command.png` | `prism-react-renderer` Bash highlighting + JSON-view input (`timeout: 60000` typed) |

Gate (from the Integrate step): `bun run check` green (6 workspaces),
`bun run web:build` OK (`dist/main.js` ≈ 1.11 MiB minified), `bun test`
265 pass / 0 fail.

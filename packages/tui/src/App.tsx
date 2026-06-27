import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { EventFilter, EventRow, Facets } from "@lllogs/shared";
import type { DataSource } from "./datasource";
import { ALL_COLUMNS, DEFAULT_VISIBLE, columnById, type ColumnDef } from "./columns";
import { EventTable } from "./components/EventTable";
import { FacetPane } from "./components/FacetPane";
import { ColumnMenu } from "./components/ColumnMenu";
import { Drawer } from "./components/Drawer";
import { applyAppend, atBottom, withCursor, type TailState } from "./tail";
import { describeFilter, toggleFilterValue } from "./filters";
import { buildFacetItems, EMPTY_FACETS } from "./facets";
import { sortRows, cycleSort, type SortSpec } from "./sort";
import { buildDrawerLines, buildRawLines, type DrawerLine } from "./drawer";

const POLL_MS = 1000;
const PAGE_LIMIT = 500;
const EMPTY_TAIL: TailState = { rows: [], cursor: 0, lastId: 0, newCount: 0 };

type Mode = "table" | "search" | "facets" | "columns" | "drawer";

/** Columns hidden on first run = everything not in DEFAULT_VISIBLE. */
function initialHidden(): Set<string> {
  return new Set(ALL_COLUMNS.map((c) => c.id).filter((id) => !DEFAULT_VISIBLE.includes(id)));
}

/**
 * Top-level Ink app: newest-first load + live keyset tail (scroll-pinned), an
 * EventFilter (reload + facet refresh on change), `/` search, an `f` facet
 * picker, and a `c` column manager (show/hide · freeze any columns · sort).
 * Sort is a view transform over the buffer; while it's active auto-follow is
 * suspended. The drawer (M4) builds on this.
 */
export function App({
  ds,
  pollMs = POLL_MS,
}: {
  ds: DataSource;
  pollMs?: number;
}): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termHeight = stdout?.rows ?? 24;

  const [filter, setFilter] = useState<EventFilter>({});
  const [tail, setTail] = useState<TailState>(EMPTY_TAIL);
  const [live, setLive] = useState(true);
  const [mode, setMode] = useState<Mode>("table");
  const [draft, setDraft] = useState(""); // the `/` search input buffer
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [facetCursor, setFacetCursor] = useState(0);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(initialHidden);
  const [frozenIds, setFrozenIds] = useState<ReadonlySet<string>>(() => new Set(["time"]));
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [colCursor, setColCursor] = useState(0);
  const [hOffset, setHOffset] = useState(0);
  const [drawerRow, setDrawerRow] = useState<EventRow | null>(null);
  const [drawerOffset, setDrawerOffset] = useState(0);
  const [drawerRaw, setDrawerRaw] = useState(false);

  const columns = useMemo<ColumnDef[]>(
    () => ALL_COLUMNS.filter((c) => !hiddenIds.has(c.id)),
    [hiddenIds],
  );
  const scrollableCount = columns.filter((c) => !frozenIds.has(c.id)).length;
  const page = Math.max(1, termHeight - 4);
  const facetItems = useMemo(() => buildFacetItems(facets, filter), [facets, filter]);
  // Sort is a view transform; the buffer (tail.rows) stays id-ascending.
  const viewRows = useMemo(
    () => (sort ? sortRows(tail.rows, sort, columnById) : tail.rows),
    [tail.rows, sort],
  );
  const drawerLines = useMemo<DrawerLine[]>(
    () => (drawerRow ? (drawerRaw ? buildRawLines(drawerRow) : buildDrawerLines(drawerRow)) : []),
    [drawerRow, drawerRaw],
  );

  const filterRef = useRef(filter);
  filterRef.current = filter;
  const lastIdRef = useRef(tail.lastId);
  lastIdRef.current = tail.lastId;
  const sortRef = useRef(sort);
  sortRef.current = sort;

  // Facets are a convenience — guard so an unexpected/older schema (e.g. a
  // pre-`role` read-only DB the ingester hasn't migrated yet) degrades to "no
  // facets" instead of crashing the app (ground rule #7).
  function loadFacets(f: EventFilter): Facets {
    try {
      return ds.queryFacets(f);
    } catch {
      return EMPTY_FACETS;
    }
  }

  // (Re)load the newest matching page on filter change.
  useEffect(() => {
    const { rows } = ds.queryLatest({ ...filter, limit: PAGE_LIMIT });
    const lastId = rows.length ? rows[rows.length - 1]!.id : ds.maxEventId();
    setTail({ rows, cursor: Math.max(0, rows.length - 1), lastId, newCount: 0 });
  }, [filter, ds]);

  // Facet counts (6 GROUP BYs) are only needed while the pane is open: load on
  // open and refresh on a toggle (filter change) — NOT on every closed-pane
  // filter change, so a search / Esc-clear doesn't pay for facets it never shows.
  useEffect(() => {
    if (mode === "facets") setFacets(loadFacets(filter));
  }, [mode, filter, ds]);

  // Keep the facet cursor inside its list, and the horizontal scroll offset
  // inside the scrollable columns when they shrink (a hidden/frozen column).
  useEffect(() => {
    setFacetCursor((c) => Math.min(c, Math.max(0, facetItems.length - 1)));
  }, [facetItems.length]);
  useEffect(() => {
    setHOffset((o) => Math.min(o, Math.max(0, scrollableCount - 1)));
  }, [scrollableCount]);

  // Live keyset poll under the current filter. While a sort is active the buffer
  // is FROZEN (a true snapshot) so re-sorting can't shift the row under the
  // cursor; clearing the sort resumes the tail and catches up via afterId.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      if (sortRef.current !== null) return;
      const { rows } = ds.queryEvents({
        ...filterRef.current,
        afterId: lastIdRef.current,
        limit: PAGE_LIMIT,
      });
      if (rows.length) setTail((s) => applyAppend(s, rows, atBottom(s)));
    }, pollMs);
    return () => clearInterval(id);
  }, [live, ds, pollMs]);

  function applySearch(q: string): void {
    const trimmed = q.trim();
    setFilter((f) => {
      const next = { ...f };
      if (trimmed) next.q = trimmed;
      else delete next.q;
      return next;
    });
  }

  function openFacets(): void {
    // The mode-gated effect loads fresh counts once mode becomes "facets".
    setFacetCursor(0);
    setMode("facets");
  }

  function toggleFacetAtCursor(): void {
    const it = facetItems[facetCursor];
    if (it) setFilter((f) => toggleFilterValue(f, it.dim, it.value));
  }

  function toggleColumnVisible(id: string): void {
    setHiddenIds((h) => {
      const next = new Set(h);
      if (next.has(id)) {
        next.delete(id); // show
      } else if (ALL_COLUMNS.length - h.size > 1) {
        next.add(id); // hide, but never the last visible column
      }
      return next;
    });
  }

  function toggleColumnFrozen(id: string): void {
    setFrozenIds((f) => {
      const next = new Set(f);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useInput((input, key) => {
    if (mode === "search") {
      if (key.return) {
        applySearch(draft);
        setMode("table");
      } else if (key.escape) {
        setMode("table");
      } else if (key.backspace || key.delete) {
        setDraft((d) => d.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setDraft((d) => d + input);
      }
      return;
    }

    if (mode === "facets") {
      if (key.escape || input === "f" || input === "q") setMode("table");
      else if (key.upArrow || input === "k") setFacetCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === "j")
        setFacetCursor((c) => Math.min(Math.max(0, facetItems.length - 1), c + 1));
      else if (input === " " || key.return) toggleFacetAtCursor();
      return;
    }

    if (mode === "columns") {
      const col = ALL_COLUMNS[colCursor];
      if (key.escape || input === "c" || input === "q") setMode("table");
      else if (key.upArrow || input === "k") setColCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === "j")
        setColCursor((c) => Math.min(ALL_COLUMNS.length - 1, c + 1));
      else if (input === " " || input === "v") {
        if (col) toggleColumnVisible(col.id);
      } else if (input === "f") {
        if (col) toggleColumnFrozen(col.id);
      } else if (input === "s") {
        if (col) setSort((s) => cycleSort(s, col.id));
      }
      return;
    }

    if (mode === "drawer") {
      if (key.escape || input === "q") setMode("table");
      else if (key.upArrow || input === "k") setDrawerOffset((o) => Math.max(0, o - 1));
      else if (key.downArrow || input === "j")
        setDrawerOffset((o) => Math.min(o + 1, Math.max(0, drawerLines.length - 1)));
      else if (key.pageUp) setDrawerOffset((o) => Math.max(0, o - page));
      else if (key.pageDown)
        setDrawerOffset((o) => Math.min(o + page, Math.max(0, drawerLines.length - 1)));
      else if (input === "g") setDrawerOffset(0);
      else if (input === "r") {
        setDrawerRaw((r) => !r);
        setDrawerOffset(0);
      } else if (input === "x" && drawerRow?.corr) {
        // Re-scope to ONLY this correlation (the tool_use ↔ tool_result pair):
        // REPLACE the filter, don't AND onto it — a lingering kind/tool/q would
        // exclude the counterpart. Esc in the table clears it to back out.
        setFilter({ corr: drawerRow.corr });
        setMode("table");
      }
      return;
    }

    if (input === "q" || (key.ctrl && input === "c")) exit();
    else if (input === "/") {
      setDraft(filter.q ?? "");
      setMode("search");
    } else if (input === "f") openFacets();
    else if (input === "c") {
      setColCursor(0);
      setMode("columns");
    } else if (key.return) {
      const row = viewRows[tail.cursor];
      if (row) {
        setDrawerRow(row);
        setDrawerOffset(0);
        setDrawerRaw(false);
        setMode("drawer");
      }
    } else if (key.escape) {
      // Esc clears all active filters (incl. a corr drill-in) — "show everything".
      setFilter((f) => (Object.keys(f).length ? {} : f));
    } else if (key.upArrow || input === "k") setTail((s) => withCursor(s, s.cursor - 1));
    else if (key.downArrow || input === "j") setTail((s) => withCursor(s, s.cursor + 1));
    else if (key.pageUp) setTail((s) => withCursor(s, s.cursor - page));
    else if (key.pageDown) setTail((s) => withCursor(s, s.cursor + page));
    else if (input === "g") setTail((s) => withCursor(s, 0));
    else if (input === "G") setTail((s) => withCursor(s, s.rows.length - 1));
    else if (key.leftArrow || input === "h") setHOffset((o) => Math.max(0, o - 1));
    else if (key.rightArrow || input === "l")
      setHOffset((o) => Math.min(Math.max(0, scrollableCount - 1), o + 1));
    else if (input === "p") setLive((l) => !l);
  });

  const chips = describeFilter(filter);
  const sortLabel = sort ? ` · sort:${sort.col}${sort.dir === 1 ? "▲" : "▼"}` : "";
  // Liveness pulse: events in the last 5 minutes (within the current filter).
  const now = Date.now();
  const recent5m = tail.rows.reduce((n, r) => (now - r.ts < 300_000 ? n + 1 : n), 0);
  const status =
    `lllogs ▸ ${live ? "LIVE ●" : "paused ‖"} · ${recent5m}/5m` +
    (tail.newCount ? ` · ↓ ${tail.newCount} new` : "") +
    sortLabel +
    (chips ? ` · ${chips}` : "");

  const bottom =
    mode === "facets"
      ? "↑↓ move · space toggle · f/esc close"
      : mode === "columns"
        ? "↑↓ move · space show/hide · f freeze · s sort · c/esc close"
        : mode === "drawer"
          ? "↑↓ scroll · r raw/structured · x correlate · q/esc close"
          : "↑↓ move · ←→ cols · ↵ detail · / search · f facets · c columns · p pause · q quit";

  return (
    <Box flexDirection="column" width={termWidth}>
      <Text bold wrap="truncate">
        {status}
      </Text>
      {mode === "facets" ? (
        <FacetPane items={facetItems} cursor={facetCursor} termHeight={termHeight - 2} />
      ) : mode === "columns" ? (
        <ColumnMenu
          columns={ALL_COLUMNS}
          hidden={hiddenIds}
          frozen={frozenIds}
          sort={sort}
          cursor={colCursor}
          termHeight={termHeight - 2}
        />
      ) : mode === "drawer" ? (
        <Drawer lines={drawerLines} offset={drawerOffset} termHeight={termHeight - 2} />
      ) : (
        <EventTable
          rows={viewRows}
          cursor={tail.cursor}
          columns={columns}
          frozenIds={frozenIds}
          hOffset={hOffset}
          termWidth={termWidth}
          termHeight={termHeight - 2}
        />
      )}
      {mode === "search" ? (
        <Text wrap="truncate">
          {"/"}
          {draft}
          <Text inverse> </Text>
        </Text>
      ) : (
        <Text dimColor wrap="truncate">
          {bottom}
        </Text>
      )}
    </Box>
  );
}

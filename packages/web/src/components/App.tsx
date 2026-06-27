import React, { useCallback, useEffect, useReducer, useRef } from "react";
import type { VisibilityState } from "@tanstack/react-table";
import type { EventFilter, EventRow, Facets } from "@lllogs/shared";
import { asArray, assertSelectOnly } from "@lllogs/shared";

// Facet dimensions that support multiple selected values (OR within a dimension).
const MULTI_DIMS = ["project", "session", "tool", "kind", "role", "error"] as const;

/** Set a facet dimension to a list of values: 0 → absent, 1 → scalar, n → array. */
function setFilterValues(
  filter: EventFilter,
  key: keyof EventFilter,
  values: string[],
): EventFilter {
  const next = { ...filter } as Record<string, unknown>;
  if (values.length === 0) delete next[key];
  else next[key] = values.length === 1 ? values[0] : values;
  return next as EventFilter;
}
import { getEvents, getFacets, postQuery } from "../api";
import type { QueryResult } from "../api";
import { log } from "../log";
import { subscribe, mergeAppend, computeTiles } from "../live";
import { Tiles } from "./Tiles";
import { FacetSidebar } from "./FacetSidebar";
import { FilterBar } from "./FilterBar";
import { EventsTable, EVENT_COLUMNS } from "./EventsTable";
import { usePersistedState } from "../usePersistedState";

// Events-table column hide/show key. A missing id defaults to visible (react-table
// treats absent keys as true), so a newly-added column shows by default.
const COL_VIS_KEY = "lllogs.eventsColVisibility.v1";
import { Drawer } from "./Drawer";
import { AnalyticsView } from "./AnalyticsView";
import SqlEditor from "./SqlEditor";
import QueryResultGrid from "./QueryResultGrid";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SQL_LIMIT = 1000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type View = "events" | "analytics";

interface AppState {
  filter: EventFilter;
  rows: EventRow[];
  nextAfterId: number | null;
  liveOn: boolean;
  view: View;
  drawer: EventRow | null;
  facets: Facets;
  tiles: { total: string; last5: string; errorRate: string; topTool: string };
  // q is tracked separately so we can seed it from URL
  qValue: string;
  sqlActive: boolean;
  sqlText: string;
  sqlResult: QueryResult | null;
  sqlError: string | null;
}

type Action =
  | { type: "SET_FILTER"; filter: EventFilter }
  | { type: "SET_ROWS"; rows: EventRow[]; nextAfterId: number | null }
  | { type: "APPEND_ROWS"; rows: EventRow[]; nextAfterId?: number | null }
  | { type: "SET_FACETS"; facets: Facets }
  | { type: "SET_TILES"; tiles: AppState["tiles"] }
  | { type: "TOGGLE_LIVE" }
  | { type: "SET_VIEW"; view: View }
  | { type: "OPEN_DRAWER"; event: EventRow }
  | { type: "CLOSE_DRAWER" }
  | { type: "SET_Q"; q: string }
  | { type: "ENTER_SQL" }
  | { type: "EXIT_SQL" }
  | { type: "SET_SQL_TEXT"; sql: string }
  | { type: "SET_SQL_RESULT"; result: QueryResult }
  | { type: "SET_SQL_ERROR"; error: string };

const EMPTY_FACETS: Facets = {
  project: [],
  session: [],
  tool: [],
  kind: [],
  role: [],
  error: [],
};

function initState(): AppState {
  const sp = new URLSearchParams(location.search);
  const filter: EventFilter = {};
  let qValue = "";
  for (const k of MULTI_DIMS) {
    const vals = sp.getAll(k).filter(Boolean);
    if (vals.length) (filter as Record<string, unknown>)[k] = vals.length === 1 ? vals[0] : vals;
  }
  const corr = sp.get("corr");
  if (corr) filter.corr = corr;
  const qParam = sp.get("q");
  if (qParam) {
    filter.q = qParam;
    qValue = qParam;
  }
  // URLSearchParams.get already percent-decodes; the URL-sync effect sets it
  // without manual encoding, so no decodeURIComponent here (double-decoding a
  // hand-crafted link containing a literal '%' — e.g. a LIKE pattern — throws).
  const sqlText = sp.get("sql") ?? "";
  return {
    filter,
    rows: [],
    nextAfterId: null,
    liveOn: false,
    view: "events",
    drawer: null,
    facets: EMPTY_FACETS,
    tiles: { total: "—", last5: "—", errorRate: "—", topTool: "—" },
    qValue,
    sqlActive: !!sqlText,
    sqlText,
    sqlResult: null,
    sqlError: null,
  };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_FILTER":
      return { ...state, filter: action.filter };
    case "SET_ROWS":
      return { ...state, rows: action.rows, nextAfterId: action.nextAfterId };
    case "APPEND_ROWS":
      return {
        ...state,
        rows: mergeAppend(state.rows, action.rows),
        // keyset paging: update cursor when provided (SSE appends omit it)
        ...(action.nextAfterId !== undefined ? { nextAfterId: action.nextAfterId } : {}),
      };
    case "SET_FACETS":
      return { ...state, facets: action.facets };
    case "SET_TILES":
      return { ...state, tiles: action.tiles };
    case "TOGGLE_LIVE":
      return { ...state, liveOn: !state.liveOn };
    case "SET_VIEW":
      return { ...state, view: action.view };
    case "OPEN_DRAWER":
      return { ...state, drawer: action.event };
    case "CLOSE_DRAWER":
      return { ...state, drawer: null };
    case "SET_Q":
      return {
        ...state,
        filter: action.q
          ? { ...state.filter, q: action.q }
          : ((({ q: _q, ...rest }) => rest)(
              state.filter as Record<string, string> & { q?: string },
            ) as EventFilter),
        qValue: action.q,
      };
    case "ENTER_SQL":
      return { ...state, sqlActive: true };
    case "EXIT_SQL":
      return { ...state, sqlActive: false, sqlText: "", sqlResult: null, sqlError: null };
    case "SET_SQL_TEXT":
      return { ...state, sqlText: action.sql };
    case "SET_SQL_RESULT":
      return { ...state, sqlResult: action.result, sqlError: null };
    case "SET_SQL_ERROR":
      return { ...state, sqlError: action.error };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// SqlBanner
// ---------------------------------------------------------------------------

function SqlBanner({
  count,
  truncated,
}: {
  count: number;
  truncated: boolean;
}): React.ReactElement {
  return (
    <div id="sql-banner">
      {`Querying ${count} faceted events · live paused · rows capped at ${SQL_LIMIT}`}
      {truncated && " · truncated"}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initState);
  // Pure UI state (doesn't affect queries), so kept out of the reducer.
  const [columnVisibility, setColumnVisibility] = usePersistedState<VisibilityState>(
    COL_VIS_KEY,
    {},
  );
  const toggleColumn = useCallback((id: string): void => {
    setColumnVisibility((v) => {
      const hiding = v[id] !== false; // currently visible → this toggle hides it
      // Never hide the last visible column: a zero-column grid renders empty <tr>s
      // (~0px), which makes the virtualizer pull in every row and page the whole
      // dataset. Keep at least one column.
      if (hiding && EVENT_COLUMNS.filter((c) => v[c.id] !== false).length <= 1) {
        return v;
      }
      return { ...v, [id]: !hiding };
    });
  }, []);
  const unsubRef = useRef<(() => void) | null>(null);
  const tileThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  // Guard to prevent concurrent keyset-paging fetches
  const fetchingMoreRef = useRef(false);
  // Most-recent filter for the throttled tile refresh (so a rapid second filter
  // change isn't dropped in favor of the first one's stale filter).
  const pendingTileFilterRef = useRef<EventFilter>({});

  // ---------------------------------------------------------------------------
  // Load data
  // ---------------------------------------------------------------------------

  const load = useCallback(async (filter: EventFilter): Promise<void> => {
    const [ev, facets] = await Promise.all([getEvents(filter), getFacets(filter)]);
    dispatch({ type: "SET_ROWS", rows: ev.events, nextAfterId: ev.nextAfterId });
    dispatch({ type: "SET_FACETS", facets });
    scheduleTileRefresh(filter);
  }, []);

  function scheduleTileRefresh(filter: EventFilter): void {
    pendingTileFilterRef.current = filter; // trailing-edge refresh uses the latest filter
    if (tileThrottleRef.current !== null) return;
    tileThrottleRef.current = setTimeout(() => {
      tileThrottleRef.current = null;
      void refreshTiles(pendingTileFilterRef.current);
    }, 1000);
  }

  async function refreshTiles(filter: EventFilter): Promise<void> {
    const [facets, windowFacets] = await Promise.all([
      getFacets(filter),
      getFacets({ ...filter, since: Date.now() - 5 * 60 * 1000 }),
    ]);
    const windowCount = windowFacets.kind.reduce((s, b) => s + b.count, 0);
    const [total, last5, errorRate, topTool] = computeTiles(
      facets.kind,
      facets.error,
      facets.tool,
      windowCount,
    );
    dispatch({ type: "SET_TILES", tiles: { total, last5, errorRate, topTool } });
  }

  async function loadFacets(filter: EventFilter): Promise<void> {
    const facets = await getFacets(filter);
    dispatch({ type: "SET_FACETS", facets });
    scheduleTileRefresh(filter);
  }

  // ---------------------------------------------------------------------------
  // SQL query
  // ---------------------------------------------------------------------------

  async function runSqlQuery(sqlText: string, filter: EventFilter): Promise<void> {
    if (!sqlText.trim()) return;
    log.info({ evt: "query.submit", sqlLen: sqlText.length });
    // Preflight with the SAME guard the server applies (strips comments, matches
    // error wording) instead of a divergent local regex that rejects e.g. a
    // leading `-- comment` the server would accept.
    try {
      assertSelectOnly(sqlText);
    } catch (err) {
      log.warn({ evt: "query.error", msg: String(err) });
      dispatch({ type: "SET_SQL_ERROR", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    try {
      const result = await postQuery({ sql: sqlText, filter, limit: SQL_LIMIT });
      log.info({ evt: "query.result", rows: result.rows.length, truncated: result.truncated });
      dispatch({ type: "SET_SQL_RESULT", result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ evt: "query.error", msg: String(err) });
      dispatch({ type: "SET_SQL_ERROR", error: msg });
    }
  }

  // ---------------------------------------------------------------------------
  // Live subscription
  // ---------------------------------------------------------------------------

  function stopLive(): void {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
  }

  function startLive(filter: EventFilter, rows: EventRow[]): void {
    stopLive();
    // reduce, not Math.max(...spread): the row buffer can hold tens of thousands
    // of rows after keyset paging, and spreading that many args overflows the stack.
    const maxId = rows.reduce((m, r) => (r.id > m ? r.id : m), 0);
    unsubRef.current = subscribe(filter, maxId, (newRows) => {
      // Check scroll position before React re-renders
      const main = mainRef.current;
      const atBottom = main ? main.scrollHeight - main.scrollTop - main.clientHeight < 40 : false;

      dispatch({ type: "APPEND_ROWS", rows: newRows });
      scheduleTileRefresh(filter);

      // Scroll to bottom if pinned — use requestAnimationFrame to run after render
      if (atBottom && main) {
        requestAnimationFrame(() => {
          if (mainRef.current) mainRef.current.scrollTop = mainRef.current.scrollHeight;
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // Initial load
  useEffect(() => {
    if (state.sqlActive && state.sqlText) {
      void getFacets(state.filter).then((facets) => {
        dispatch({ type: "SET_FACETS", facets });
      });
      void runSqlQuery(state.sqlText, state.filter);
      scheduleTileRefresh(state.filter);
    } else {
      void load(state.filter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopLive();
      if (tileThrottleRef.current !== null) clearTimeout(tileThrottleRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click-outside closes drawer
  useEffect(() => {
    if (!state.drawer) return;
    function onClick(ev: MouseEvent): void {
      const drawerEl = document.getElementById("drawer");
      if (drawerEl && !drawerEl.contains(ev.target as Node)) {
        dispatch({ type: "CLOSE_DRAWER" });
      }
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [state.drawer]);

  // URL sync — persist filters + sql so reload / share / Back restore state
  // (initState reads these same keys back).
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    for (const k of ["project", "session", "tool", "kind", "role", "error", "corr", "q"] as const) {
      sp.delete(k);
      const v = (state.filter as Record<string, unknown>)[k];
      for (const x of asArray(v)) {
        if (x !== undefined && x !== null && x !== "") sp.append(k, String(x));
      }
    }
    if (state.sqlActive && state.sqlText) {
      // No manual encodeURIComponent: URLSearchParams encodes on toString and
      // initState decodes via get(); double-encoding breaks round-tripping.
      sp.set("sql", state.sqlText);
    } else {
      sp.delete("sql");
    }
    const search = sp.toString();
    history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}`);
  }, [state.sqlActive, state.sqlText, state.filter]);

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  // Single "filter changed → refresh the right view" path, shared by every
  // filter-change handler so SQL mode, live mode, and facet refresh stay in
  // sync. (handleCorrFilter previously skipped this and left a stale stream/grid.)
  function applyFilter(newFilter: EventFilter): void {
    if (state.sqlActive && state.sqlText) {
      void runSqlQuery(state.sqlText, newFilter);
      void loadFacets(newFilter);
    } else {
      if (state.liveOn) startLive(newFilter, []);
      void load(newFilter);
    }
  }

  // Toggle one value of a facet dimension on/off. Multiple values of the same
  // dimension OR together (e.g. kind = tool_use OR tool_result).
  function handleToggleFacet(key: keyof EventFilter, value: string): void {
    const current = asArray((state.filter as Record<string, string | string[] | undefined>)[key]);
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    const newFilter = setFilterValues(state.filter, key, next);
    dispatch({ type: "SET_FILTER", filter: newFilter });
    applyFilter(newFilter);
  }

  // Remove a single value (chip). If `value` is omitted, drop the whole dimension.
  function handleRemoveFilter(k: string, value?: string): void {
    const key = k as keyof EventFilter;
    const next =
      value === undefined
        ? []
        : asArray((state.filter as Record<string, string | string[] | undefined>)[key]).filter(
            (v) => v !== value,
          );
    const f = setFilterValues(state.filter, key, next);
    dispatch({ type: "SET_FILTER", filter: f });
    applyFilter(f);
  }

  function handleQChange(v: string): void {
    dispatch({ type: "SET_Q", q: v });
    const newFilter = v
      ? { ...state.filter, q: v }
      : ((({ q: _q, ...rest }) => rest)(
          state.filter as Record<string, string> & { q?: string },
        ) as EventFilter);
    applyFilter(newFilter);
  }

  // Scroll-driven keyset paging: APPENDS to the row buffer so the virtualizer
  // can render a continuous window across all loaded pages. fetchingMoreRef
  // prevents concurrent fetches (the near-end effect fires on every render).
  const handleLoadMore = useCallback(async (): Promise<void> => {
    if (state.nextAfterId === null || fetchingMoreRef.current) return;
    fetchingMoreRef.current = true;
    try {
      const ev = await getEvents({ ...state.filter, afterId: state.nextAfterId });
      dispatch({
        type: "APPEND_ROWS",
        rows: ev.events,
        nextAfterId: ev.nextAfterId,
      });
    } finally {
      fetchingMoreRef.current = false;
    }
  }, [state.nextAfterId, state.filter]);

  function handleToggleLive(): void {
    const willBeOn = !state.liveOn;
    dispatch({ type: "TOGGLE_LIVE" });
    if (willBeOn) {
      startLive(state.filter, state.rows);
    } else {
      stopLive();
    }
  }

  function handleTabEvents(): void {
    dispatch({ type: "SET_VIEW", view: "events" });
  }

  function handleTabAnalytics(): void {
    dispatch({ type: "SET_VIEW", view: "analytics" });
  }

  function handleCorrFilter(corr: string): void {
    const newFilter = { ...state.filter, corr };
    dispatch({ type: "SET_FILTER", filter: newFilter });
    applyFilter(newFilter); // restart live / re-run SQL for the new filter like the others
  }

  function handleToggleSql(): void {
    if (state.sqlActive) {
      log.info({ evt: "mode.switch", to: "live" });
      dispatch({ type: "EXIT_SQL" });
      // Resume the live stream SQL mode paused (liveOn stays true throughout SQL).
      if (state.liveOn) startLive(state.filter, state.rows);
      void load(state.filter);
    } else {
      log.info({ evt: "mode.switch", to: "sql" });
      stopLive();
      dispatch({ type: "ENTER_SQL" });
      void loadFacets(state.filter);
    }
  }

  function handleSqlChange(sql: string): void {
    // Don't exit SQL mode just because the box is momentarily empty — the editor
    // is mounted on sqlActive, so unmounting it mid-edit (select-all + delete to
    // retype) would swallow the next keystroke. Use the SQL toggle to exit.
    dispatch({ type: "SET_SQL_TEXT", sql });
  }

  function handleSqlRowClick(row: Record<string, unknown>): void {
    // `SELECT * FROM events` yields SQLite (snake_case) column names, and
    // getRowsJson() returns integer columns as strings — so accept both casings
    // and coerce is_error/ts explicitly rather than via truthiness ('0' is truthy).
    const pick = (camel: string, snake: string): unknown => row[camel] ?? row[snake];
    const opt = (v: unknown): string | undefined =>
      v === null || v === undefined || v === "" ? undefined : String(v);
    const ie = pick("isError", "is_error");
    const tsv = row["ts"];
    const idNum = Number(row["id"] ?? row["uuid"] ?? 0);
    const fakeEvent = {
      id: Number.isNaN(idNum) ? 0 : idNum,
      raw: JSON.stringify(row, null, 2),
      sessionId: String(pick("sessionId", "session_id") ?? ""),
      project: String(row["project"] ?? ""),
      ts: tsv === null || tsv === undefined || tsv === "" ? undefined : Number(tsv),
      kind: String(row["kind"] ?? ""),
      role: opt(row["role"]),
      tool: opt(row["tool"]),
      command: opt(row["command"]),
      isError: ie === true || ie === 1 || ie === "1",
      result: opt(row["result"]),
      text: opt(row["text"]),
      diff: opt(row["diff"]),
      stderr: opt(row["stderr"]),
      corr: opt(row["corr"]),
      resultHead: opt(pick("resultHead", "result_head")),
    } as EventRow;
    dispatch({ type: "OPEN_DRAWER", event: fakeEvent });
  }

  const isAnalytics = state.view === "analytics";

  const facetedCount = state.facets.kind.reduce((s, b) => s + b.count, 0);
  const sqlHasIdCol = state.sqlResult
    ? state.sqlResult.columns.some((c) => c === "id" || c === "uuid")
    : false;

  return (
    <div id="layout">
      <Tiles
        total={state.tiles.total}
        last5={state.tiles.last5}
        errorRate={state.tiles.errorRate}
        topTool={state.tiles.topTool}
      />
      <div id="body-row">
        <FacetSidebar facets={state.facets} filter={state.filter} onToggle={handleToggleFacet} />
        <main ref={mainRef}>
          <div id="tabs">
            <button
              id="tab-events"
              className={isAnalytics ? "tab" : "tab active"}
              onClick={handleTabEvents}
            >
              Events
            </button>
            <button
              id="tab-analytics"
              className={isAnalytics ? "tab active" : "tab"}
              onClick={handleTabAnalytics}
            >
              Analytics
            </button>
          </div>

          <FilterBar
            filter={state.filter}
            liveOn={state.liveOn}
            qValue={state.qValue}
            onQChange={handleQChange}
            onRemoveFilter={handleRemoveFilter}
            onToggleLive={handleToggleLive}
            sqlActive={state.sqlActive}
            onToggleSql={handleToggleSql}
            showColumnMenu={!isAnalytics && !state.sqlActive}
            columns={EVENT_COLUMNS}
            columnVisibility={columnVisibility}
            onToggleColumn={toggleColumn}
          />

          {state.sqlActive && (
            <SqlEditor
              value={state.sqlText}
              onChange={handleSqlChange}
              onRun={(sql) => void runSqlQuery(sql, state.filter)}
              error={state.sqlError}
            />
          )}

          <div style={{ display: isAnalytics || state.sqlActive ? "none" : "" }}>
            <EventsTable
              rows={state.rows}
              nextAfterId={state.nextAfterId}
              onNearEnd={() => void handleLoadMore()}
              onRowClick={(e) => dispatch({ type: "OPEN_DRAWER", event: e })}
              scrollRef={mainRef}
              columnVisibility={columnVisibility}
              onColumnVisibilityChange={setColumnVisibility}
            />
          </div>

          {state.sqlActive && state.sqlResult && (
            <>
              <SqlBanner count={facetedCount} truncated={state.sqlResult.truncated} />
              <QueryResultGrid
                columns={state.sqlResult.columns}
                rows={state.sqlResult.rows}
                onRowClick={sqlHasIdCol ? handleSqlRowClick : undefined}
                scrollRef={mainRef}
              />
            </>
          )}

          <AnalyticsView filter={state.filter} visible={isAnalytics} />
        </main>
      </div>

      {state.drawer && (
        <Drawer
          event={state.drawer}
          onClose={() => dispatch({ type: "CLOSE_DRAWER" })}
          onCorrFilter={handleCorrFilter}
        />
      )}
    </div>
  );
}

import React, { useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type {
  ColumnSizingState,
  OnChangeFn,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
import type { EventRow } from "@lllogs/shared";
import { splitBashCommand, resultLines, formatToolInput } from "@lllogs/shared";
import { ResizableColgroup, HeaderCell } from "./ResizableColumns";
import { usePersistedState } from "../usePersistedState";

function trunc(s: string | null, n = 200): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function shortSession(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

// ---------------------------------------------------------------------------
// Cell renderers (JSX, never dangerouslySetInnerHTML)
// ---------------------------------------------------------------------------

function CommandCellContent({ e }: { e: EventRow }): React.ReactElement {
  if (e.tool === "Bash" && e.command) {
    const segments = splitBashCommand(e.command);
    if (segments.length > 1) {
      return (
        <table className="cmd-table">
          <tbody>
            {segments.map((seg, i) => (
              <tr key={i}>
                <td>{seg}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
  }
  // Non-Bash tool_use: show a concise, clamp-friendly preview of the full input
  // (Edit/Write/Read/Task/… specialized; generic key:value fallback) instead of
  // the bare primary-arg `command`. Empty preview falls back to `command`.
  if (e.tool !== "Bash") {
    const lines = formatToolInput(e.tool, e.inputJson);
    if (lines.length) {
      return (
        <>
          {lines.map((line, i) => (
            <div key={i} style={line.dim ? { opacity: 0.65 } : undefined}>
              {line.text}
            </div>
          ))}
        </>
      );
    }
  }
  return <>{e.command ?? ""}</>;
}

function ResultCellContent({ e }: { e: EventRow }): React.ReactElement {
  const lines = resultLines({
    resultHead: e.resultHead,
    diff: e.diff,
    result: e.result,
    stderr: e.stderr,
  });
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className={line.color ? `rline ${line.color}` : "rline"}>
          {line.text}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const colHelper = createColumnHelper<EventRow>();

// `size` is the default (px) width; users drag to override and the override is
// persisted (see useColumnSizing). Defaults approximate the old percentage layout.
const columns = [
  colHelper.accessor("project", {
    header: "PROJECT",
    size: 120,
    cell: (info) => <>{info.getValue()}</>,
  }),
  colHelper.accessor("sessionId", {
    header: "SESSION",
    size: 80,
    cell: (info) => <>{shortSession(info.getValue())}</>,
  }),
  colHelper.accessor("ts", {
    header: "TIME",
    size: 150,
    cell: (info) => {
      const ts = info.getValue();
      return <>{ts ? new Date(ts).toLocaleString() : ""}</>;
    },
  }),
  colHelper.accessor("kind", {
    header: "KIND",
    size: 80,
    cell: (info) => <>{info.getValue()}</>,
  }),
  colHelper.accessor("role", {
    header: "ROLE",
    size: 70,
    cell: (info) => <>{info.getValue() ?? ""}</>,
  }),
  colHelper.accessor("tool", {
    header: "TOOL",
    size: 90,
    cell: (info) => <>{info.getValue() ?? ""}</>,
  }),
  colHelper.display({
    id: "command",
    header: "COMMAND",
    size: 300,
    cell: (info) => <CommandCellContent e={info.row.original} />,
  }),
  colHelper.accessor("isError", {
    header: "ERROR",
    size: 60,
    cell: (info) => {
      const v = info.getValue();
      return v === true ? <span className="error">ERROR</span> : <></>;
    },
  }),
  colHelper.display({
    id: "result",
    header: "RESULT",
    size: 320,
    cell: (info) => <ResultCellContent e={info.row.original} />,
  }),
  colHelper.accessor("text", {
    header: "TEXT",
    size: 220,
    cell: (info) => <>{trunc(info.getValue())}</>,
  }),
];

// {id, label} per column — drives the "Columns ▾" hide/show menu in the bar. The
// id must equal react-table's column id: that's the `accessorKey` for accessor
// columns and the explicit `id` for display columns — true for all columns above
// (flat string accessors + explicit display ids, string headers). A future
// function-accessor column would need an explicit `id`.
export const EVENT_COLUMNS: { id: string; label: string }[] = columns.map((c) => ({
  id: (c as { accessorKey?: string }).accessorKey ?? (c as { id?: string }).id!,
  label: String(c.header),
}));

// Persist user-dragged column widths across remounts (tab switches) and reloads.
const COL_SIZING_KEY = "lllogs.eventsColSizing.v1";
// Persist drag-to-reorder column order the same way ([] = react-table's
// definition order; the first reorder writes the full on-screen order).
const COL_ORDER_KEY = "lllogs.eventsColOrder.v1";

function loadColumnSizing(): ColumnSizingState {
  try {
    const raw = localStorage.getItem(COL_SIZING_KEY);
    return raw ? (JSON.parse(raw) as ColumnSizingState) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface EventsTableProps {
  rows: EventRow[];
  nextAfterId: number | null;
  onNearEnd: () => void;
  onRowClick: (e: EventRow) => void;
  scrollRef: React.RefObject<HTMLElement | null>;
  columnVisibility: VisibilityState;
  onColumnVisibilityChange: OnChangeFn<VisibilityState>;
}

export function EventsTable({
  rows,
  nextAfterId,
  onNearEnd,
  onRowClick,
  scrollRef,
  columnVisibility,
  onColumnVisibilityChange,
}: EventsTableProps): React.ReactElement {
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(loadColumnSizing);
  // Drag-to-reorder order (list of column ids), persisted; [] = definition order.
  const [columnOrder, setColumnOrder] = usePersistedState<string[]>(COL_ORDER_KEY, []);
  // Client-side sort over the loaded buffer. With server keyset pagination this
  // sorts the rows currently fetched — ideal for reading a narrowed (faceted)
  // view chronologically (e.g. sort by TIME); a default (no sort) keeps the
  // server's id order. Display columns (command/result) have no accessor and so
  // aren't sortable.
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data: rows,
    columns,
    state: { columnSizing, sorting, columnVisibility, columnOrder },
    onColumnSizingChange: setColumnSizing,
    onColumnOrderChange: setColumnOrder,
    onSortingChange: setSorting,
    onColumnVisibilityChange,
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 48 },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Padding-row span must track only *visible* columns, else a hidden column
  // leaves the spacer rows spanning too wide.
  const colSpan = table.getVisibleLeafColumns().length || 1;

  // Move `draggedId` to sit immediately before `targetId`. Reconcile against the
  // live leaf-column ids first — keep the persisted order for ids that still
  // exist, then append any column missing from a stale saved order — so no column
  // is ever stranded / non-reorderable and a future column stays draggable. The
  // dragged id is removed BEFORE the target index is read, so the insert lands on
  // the target's slot regardless of drag direction (reading the target index
  // before the removal is the classic off-by-one).
  function handleReorder(draggedId: string, targetId: string): void {
    if (draggedId === targetId) return;
    const ids = table.getAllLeafColumns().map((c) => c.id);
    const order = columnOrder.filter((id) => ids.includes(id));
    for (const id of ids) if (!order.includes(id)) order.push(id);
    if (!order.includes(draggedId) || !order.includes(targetId)) return;
    const next = order.filter((id) => id !== draggedId);
    next.splice(next.indexOf(targetId), 0, draggedId);
    setColumnOrder(next);
  }

  // Persist widths once a drag ENDS, not on every mousemove. With
  // columnResizeMode "onChange", columnSizing updates each pointermove; gating on
  // isResizingColumn avoids a JSON.stringify + localStorage.setItem per frame.
  const isResizingColumn = table.getState().columnSizingInfo.isResizingColumn;
  useEffect(() => {
    if (isResizingColumn) return;
    try {
      localStorage.setItem(COL_SIZING_KEY, JSON.stringify(columnSizing));
    } catch {
      /* ignore quota/availability errors — resizing still works in-session */
    }
  }, [isResizingColumn, columnSizing]);

  const tableRows = table.getRowModel().rows;

  // ---------------------------------------------------------------------------
  // Virtualizer — padding-rows approach keeps <colgroup> + table-layout: fixed
  // working correctly without requiring display:block on tbody.
  // ---------------------------------------------------------------------------
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  // Top/bottom padding rows simulate the full scroll height so the scrollbar
  // accurately represents the total row count. Only window+overscan <tr>s
  // with real data are in the DOM.
  const paddingTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? totalSize - (virtualItems[virtualItems.length - 1]?.end ?? totalSize)
      : 0;

  // ---------------------------------------------------------------------------
  // Append-on-scroll: trigger when the last rendered index nears the buffer end.
  // The guard in App's handleLoadMore prevents concurrent fetches.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (virtualItems.length === 0 || nextAfterId === null) return;
    const lastVirtual = virtualItems[virtualItems.length - 1];
    if (lastVirtual !== undefined && lastVirtual.index >= tableRows.length - 50) {
      onNearEnd();
    }
  }, [virtualItems, tableRows.length, nextAfterId, onNearEnd]);

  return (
    <div id="events-view">
      <table id="events" style={{ minWidth: table.getTotalSize() }}>
        <ResizableColgroup table={table} />
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id}>
                  <HeaderCell header={h} onReorder={handleReorder} />
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody id="rows">
          {/* Top spacer — fills the gap before the first visible row */}
          {paddingTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={colSpan} style={{ height: paddingTop, padding: 0, border: 0 }} />
            </tr>
          )}

          {/* Only the virtualizer window + overscan rows are in the DOM */}
          {virtualItems.map((virtualRow) => {
            const row = tableRows[virtualRow.index]!;
            return (
              <tr
                key={row.id}
                data-id={String(row.original.id)}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onRowClick(row.original);
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    <div>{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>
                  </td>
                ))}
              </tr>
            );
          })}

          {/* Bottom spacer — fills the gap after the last visible row */}
          {paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={colSpan} style={{ height: paddingBottom, padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

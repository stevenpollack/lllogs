import React, { useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ColumnDef,
  CellContext,
  ColumnSizingState,
  SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ResizableColgroup, HeaderCell } from "./ResizableColumns";

interface QueryResultGridProps {
  columns: string[];
  rows: unknown[][];
  onRowClick?: (row: Record<string, unknown>) => void;
  scrollRef: React.RefObject<HTMLElement | null>;
}

export default function QueryResultGrid({
  columns,
  rows,
  onRowClick,
  scrollRef,
}: QueryResultGridProps): React.ReactElement {
  // Index-based columns: a SQL result can repeat a column name (self-joins,
  // `SELECT tool, tool`). Keying TanStack columns / row objects by name would
  // collide — duplicate column id throws, and Object.fromEntries keeps only the
  // last value. Address every column by its ordinal position instead. This also
  // drops the per-render materialization of N row objects.
  const colDefs = useMemo<ColumnDef<unknown[]>[]>(
    () =>
      columns.map((col, i) => ({
        // Id encodes BOTH position and name: position keeps ids unique when a
        // result repeats a column name (self-joins); name makes the id change
        // when a *different* query is run, so persisted widths (keyed by id)
        // aren't reapplied to an unrelated column — while re-running the SAME
        // query keeps your widths.
        id: `${i}:${col}`,
        header: col.toUpperCase(),
        accessorFn: (row: unknown[]) => row[i],
        cell: (info: CellContext<unknown[], unknown>) => {
          const v = info.getValue();
          return <>{v === null || v === undefined ? "" : String(v)}</>;
        },
      })),
    [columns],
  );

  // In-session only (not localStorage): a different query gets fresh widths
  // because column ids encode the column name (see colDefs) — sizing keyed by an
  // old query's ids simply doesn't match, so it's ignored rather than mislabeled.
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  // Client-side sort is fully correct here — the entire result set is loaded
  // (capped at 1000 rows). Reset when a new query's columns arrive so a stale
  // sort (by ordinal) doesn't carry to unrelated columns.
  const [sorting, setSorting] = useState<SortingState>([]);
  useEffect(() => {
    setSorting([]);
  }, [columns]);
  const table = useReactTable({
    data: rows,
    columns: colDefs,
    state: { columnSizing, sorting },
    onColumnSizingChange: setColumnSizing,
    onSortingChange: setSorting,
    columnResizeMode: "onChange",
    defaultColumn: { size: 180, minSize: 48 },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const tableRows = table.getRowModel().rows;
  const colSpan = Math.max(columns.length, 1);

  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const paddingTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? totalSize - (virtualItems[virtualItems.length - 1]?.end ?? totalSize)
      : 0;

  return (
    <div id="query-result-view">
      <table id="query-result" style={{ minWidth: table.getTotalSize() }}>
        <ResizableColgroup table={table} />
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id}>
                  <HeaderCell header={h} />
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody id="sql-rows">
          {paddingTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={colSpan} style={{ height: paddingTop, padding: 0, border: 0 }} />
            </tr>
          )}

          {virtualItems.map((vr) => {
            const row = tableRows[vr.index]!;
            return (
              <tr
                key={row.id}
                data-sql-row={vr.index}
                data-index={vr.index}
                ref={rowVirtualizer.measureElement}
                onClick={
                  onRowClick
                    ? (ev) => {
                        ev.stopPropagation();
                        const arr = row.original as unknown[];
                        onRowClick(Object.fromEntries(columns.map((c, i) => [c, arr[i]])));
                      }
                    : undefined
                }
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    <div>{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>
                  </td>
                ))}
              </tr>
            );
          })}

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

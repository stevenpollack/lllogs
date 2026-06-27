// Shared column-header UI (sort toggle + resize handle + sizing <colgroup>) for
// the events and SQL-result grids. Keeping this markup in one place (DRY) stops
// the two grids from drifting. Sizing/sorting *state* stays per-grid (the events
// grid persists widths; both manage their own SortingState) — only presentation
// is shared here.
import React from "react";
import { flexRender } from "@tanstack/react-table";
import type { Header, Table } from "@tanstack/react-table";

/** <colgroup> whose widths track react-table's column sizing (table-layout:fixed). */
export function ResizableColgroup<T>({ table }: { table: Table<T> }): React.ReactElement {
  return (
    <colgroup>
      {table.getVisibleLeafColumns().map((col) => (
        <col key={col.id} style={{ width: col.getSize() }} />
      ))}
    </colgroup>
  );
}

/** Drag handle on a header's right edge: drag to resize, double-click to reset. */
export function ColumnResizer<T>({
  header,
}: {
  header: Header<T, unknown>;
}): React.ReactElement | null {
  if (!header.column.getCanResize()) return null;
  return (
    <div
      className={`resizer${header.column.getIsResizing() ? " is-resizing" : ""}`}
      onMouseDown={header.getResizeHandler()}
      onTouchStart={header.getResizeHandler()}
      onDoubleClick={() => header.column.resetSize()}
      // Don't let the drag handle's click bubble to the header (which would sort).
      onClick={(e) => e.stopPropagation()}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${String(header.column.columnDef.header)} column`}
    />
  );
}

/**
 * A header cell's contents: a click-to-sort label (when sortable) + resize handle.
 * When `onReorder` is supplied (events grid only), the label becomes an HTML5
 * drag-and-drop source/target so columns can be re-arranged; grids that omit it
 * (the SQL-result grid) keep working unchanged with no reorder behavior.
 */
export function HeaderCell<T>({
  header,
  onReorder,
}: {
  header: Header<T, unknown>;
  onReorder?: (draggedId: string, targetId: string) => void;
}): React.ReactElement {
  const canSort = header.column.getCanSort();
  const sorted = header.column.getIsSorted(); // false | "asc" | "desc"
  const colId = header.column.id;
  const [dragOver, setDragOver] = React.useState(false);

  // Only the events grid passes onReorder; without it the label is inert (no
  // draggable attr, no handlers) so the SQL-result grid is unaffected.
  const dnd = onReorder
    ? {
        draggable: true,
        onDragStart: (ev: React.DragEvent<HTMLSpanElement>) => {
          ev.dataTransfer.setData("text/plain", colId);
          ev.dataTransfer.effectAllowed = "move";
        },
        onDragEnter: (ev: React.DragEvent<HTMLSpanElement>) => {
          ev.preventDefault();
          setDragOver(true);
        },
        onDragOver: (ev: React.DragEvent<HTMLSpanElement>) => {
          ev.preventDefault(); // allow drop
          ev.dataTransfer.dropEffect = "move";
        },
        onDragLeave: () => setDragOver(false),
        onDrop: (ev: React.DragEvent<HTMLSpanElement>) => {
          ev.preventDefault();
          setDragOver(false);
          const draggedId = ev.dataTransfer.getData("text/plain");
          if (draggedId && draggedId !== colId) onReorder(draggedId, colId);
        },
        onDragEnd: () => setDragOver(false),
      }
    : {};

  const className = ["th-label", canSort ? "sortable" : "", dragOver ? "drag-over" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <span
        className={className}
        onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
        title={canSort ? "Click to sort" : undefined}
        {...dnd}
      >
        {flexRender(header.column.columnDef.header, header.getContext())}
        {sorted === "asc" ? " ▲" : sorted === "desc" ? " ▼" : ""}
      </span>
      <ColumnResizer header={header} />
    </>
  );
}

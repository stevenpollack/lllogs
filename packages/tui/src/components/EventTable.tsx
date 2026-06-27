import React from "react";
import { Box, Text } from "ink";
import type { EventRow } from "@clogdy/shared";
import type { ColumnDef } from "../columns";
import { layoutColumns, pad } from "../layout";

interface Props {
  rows: EventRow[];
  cursor: number;
  /** Visible columns, in order (after show/hide). */
  columns: ColumnDef[];
  /** Ids of pinned (frozen-left) columns. */
  frozenIds: ReadonlySet<string>;
  /** Horizontal scroll offset into the non-frozen columns. */
  hOffset: number;
  termWidth: number;
  /** Lines available for the whole table (header + rows + footer). */
  termHeight: number;
}

/**
 * The event grid. One text line per row (the drawer shows rich detail); columns
 * are truncated to fixed widths. Vertical scrolling is manual windowing (Ink does
 * not virtualize); horizontal scrolling + freeze come from `layoutColumns`.
 */
export function EventTable({
  rows,
  cursor,
  columns,
  frozenIds,
  hOffset,
  termWidth,
  termHeight,
}: Props): React.ReactElement {
  const { frozen, scrolled, moreLeft, moreRight } = layoutColumns(
    columns,
    frozenIds,
    termWidth,
    hOffset,
  );
  const shown = [...frozen, ...scrolled];
  const renderCells = (get: (c: ColumnDef) => string): string =>
    shown.map((c) => pad(get(c), c.width)).join(" ");

  // Vertical window: reserve the header line + the footer line.
  const viewport = Math.max(1, termHeight - 2);
  const start = Math.min(
    Math.max(0, cursor - Math.floor(viewport / 2)),
    Math.max(0, rows.length - viewport),
  );
  const windowRows = rows.slice(start, start + viewport);

  const footer =
    (rows.length ? `${cursor + 1}/${rows.length}` : "no events") +
    (frozen.length ? ` · frozen: ${frozen.map((c) => c.id).join(",")}` : "") +
    (moreLeft ? " · ◀ more" : "") +
    (moreRight ? " · more ▶" : "");

  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate">
        {renderCells((c) => c.label)}
      </Text>
      {windowRows.map((e, idx) => (
        <Text key={e.id} inverse={start + idx === cursor} wrap="truncate">
          {renderCells((c) => c.value(e))}
        </Text>
      ))}
      <Text dimColor wrap="truncate">
        {footer}
      </Text>
    </Box>
  );
}

import React from "react";
import { Box, Text } from "ink";
import type { ColumnDef } from "../columns";
import type { SortSpec } from "../sort";
import { pad } from "../layout";

interface Props {
  columns: ColumnDef[]; // ALL columns, in order
  hidden: ReadonlySet<string>;
  frozen: ReadonlySet<string>;
  sort: SortSpec | null;
  cursor: number;
  termHeight: number;
}

/**
 * Column manager: every column with its visibility checkbox, freeze (PIN) marker,
 * and sort arrow. Driven by App (space = show/hide, f = freeze, s = cycle sort).
 */
export function ColumnMenu({
  columns,
  hidden,
  frozen,
  sort,
  cursor,
  termHeight,
}: Props): React.ReactElement {
  const viewport = Math.max(1, termHeight - 1);
  const start = Math.min(
    Math.max(0, cursor - Math.floor(viewport / 2)),
    Math.max(0, columns.length - viewport),
  );
  const win = columns.slice(start, start + viewport);

  return (
    <Box flexDirection="column">
      {win.map((c, idx) => {
        const i = start + idx;
        const vis = !hidden.has(c.id) ? "[x]" : "[ ]";
        const pin = frozen.has(c.id) ? "PIN" : "   ";
        const arrow = sort?.col === c.id ? (sort.dir === 1 ? "▲" : "▼") : " ";
        return (
          <Text key={c.id} inverse={i === cursor} wrap="truncate">
            {`${vis} ${pin} ${arrow} ${pad(c.label, 12)}`}
          </Text>
        );
      })}
    </Box>
  );
}

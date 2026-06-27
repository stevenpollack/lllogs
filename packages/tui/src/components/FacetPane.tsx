import React from "react";
import { Box, Text } from "ink";
import type { FacetItem } from "../facets";
import { pad } from "../layout";

interface Props {
  items: FacetItem[];
  cursor: number;
  termHeight: number;
}

/**
 * Full-area facet picker: the flattened dimension/value list, windowed around the
 * cursor. A dimension label prints once at the start of its run; each value shows
 * a selection marker and its count. Toggling is driven by App (space/enter).
 */
export function FacetPane({ items, cursor, termHeight }: Props): React.ReactElement {
  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>no facets for the current filter</Text>
      </Box>
    );
  }

  const viewport = Math.max(1, termHeight - 1);
  const start = Math.min(
    Math.max(0, cursor - Math.floor(viewport / 2)),
    Math.max(0, items.length - viewport),
  );
  const win = items.slice(start, start + viewport);

  return (
    <Box flexDirection="column">
      {win.map((it, idx) => {
        const i = start + idx;
        const prev = items[i - 1];
        // Always label the top visible row (its dimension's first item may have
        // scrolled above the window), else only at a dimension boundary.
        const dimLabel = idx === 0 || !prev || prev.dim !== it.dim ? it.dim.toUpperCase() : "";
        const line = `${pad(dimLabel, 9)} ${it.selected ? "◉" : "○"} ${pad(it.value, 30)} ${it.count}`;
        return (
          <Text key={`${it.dim}:${it.value}`} inverse={i === cursor} wrap="truncate">
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

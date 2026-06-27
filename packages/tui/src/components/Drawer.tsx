import React from "react";
import { Box, Text } from "ink";
import type { DrawerLine } from "../drawer";

interface Props {
  lines: DrawerLine[];
  offset: number;
  termHeight: number;
}

/** Scrollable single-record detail view. Lines are pre-built (structured or raw);
 *  this just windows them and applies each line's color/dim/bold. */
export function Drawer({ lines, offset, termHeight }: Props): React.ReactElement {
  const viewport = Math.max(1, termHeight - 1);
  const start = Math.min(Math.max(0, offset), Math.max(0, lines.length - viewport));
  const win = lines.slice(start, start + viewport);

  return (
    <Box flexDirection="column">
      {win.map((l, idx) => (
        <Text key={start + idx} color={l.color} dimColor={l.dim} bold={l.bold} wrap="truncate">
          {l.text.length ? l.text : " "}
        </Text>
      ))}
    </Box>
  );
}

import type { EventRow } from "@lllogs/shared";
import type { ColumnDef } from "./columns";

export interface SortSpec {
  col: string;
  dir: 1 | -1; // 1 = ascending, -1 = descending
}

/**
 * Sort a COPY of `rows` by a column's sort key (id-ascending as a stable
 * tiebreaker so equal keys keep a deterministic, chronological order). Pure;
 * never mutates the input. An unknown column id returns the rows unchanged.
 *
 * This is a view transform over the live buffer — the buffer itself stays
 * id-ascending for the tail. While a sort is active App suspends auto-follow
 * (you're inspecting a snapshot that still grows); clearing it resumes the tail.
 */
export function sortRows(
  rows: EventRow[],
  sort: SortSpec,
  getCol: (id: string) => ColumnDef | undefined,
): EventRow[] {
  const col = getCol(sort.col);
  if (!col) return rows;
  const key = col.sortKey ?? ((e: EventRow) => col.value(e));
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const c = ka < kb ? -1 : ka > kb ? 1 : 0;
    return c !== 0 ? c * sort.dir : a.id - b.id;
  });
}

/** Cycle a column through none → ascending → descending → none. */
export function cycleSort(sort: SortSpec | null, col: string): SortSpec | null {
  if (!sort || sort.col !== col) return { col, dir: 1 };
  if (sort.dir === 1) return { col, dir: -1 };
  return null;
}

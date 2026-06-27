/**
 * Pure horizontal-layout math for the event table. Ink has no native horizontal
 * scroll or column clipping, so we do it at the data level: given the visible
 * columns, a set of frozen (pinned-left) column ids, the terminal width and a
 * horizontal offset, decide which columns render and where. Kept dependency-free
 * and side-effect-free so it's unit-tested without Ink.
 */

/** The minimal column shape layout needs (ColumnDef satisfies this structurally). */
export interface LaidOutColumn {
  id: string;
  label: string;
  width: number;
}

export interface TableLayout<T extends LaidOutColumn> {
  /** Pinned columns, always rendered at the left, in column order. */
  frozen: T[];
  /** Non-frozen columns inside the horizontal scroll window, in column order. */
  scrolled: T[];
  /** Non-frozen columns exist to the left / right of the window. */
  moreLeft: boolean;
  moreRight: boolean;
  /** The offset actually used after clamping — callers should store it back. */
  offset: number;
}

/** One space between adjacent columns. */
export const GAP = 1;

/**
 * Lay out columns for the current viewport.
 *
 * Frozen columns consume width first (in column order); the remaining width is
 * the scroll viewport, filled with non-frozen columns starting at `hOffset`.
 * At least one non-frozen column always renders (truncated by `pad` if it can't
 * fully fit) so the table is never blank when columns remain.
 */
export function layoutColumns<T extends LaidOutColumn>(
  columns: T[],
  frozenIds: ReadonlySet<string>,
  termWidth: number,
  hOffset: number,
): TableLayout<T> {
  const frozen = columns.filter((c) => frozenIds.has(c.id));
  const rest = columns.filter((c) => !frozenIds.has(c.id));

  const frozenWidth = frozen.reduce((w, c) => w + c.width + GAP, 0);
  const avail = Math.max(0, termWidth - frozenWidth);

  // Clamp the offset into the non-frozen list (0 when there are none).
  const maxOffset = Math.max(0, rest.length - 1);
  const offset = Math.min(Math.max(0, hOffset), maxOffset);

  const scrolled: T[] = [];
  let used = 0;
  for (let i = offset; i < rest.length; i++) {
    const c = rest[i]!;
    const need = (scrolled.length === 0 ? 0 : GAP) + c.width;
    if (used + need > avail && scrolled.length > 0) break;
    scrolled.push(c);
    used += need;
  }

  return {
    frozen,
    scrolled,
    moreLeft: offset > 0,
    moreRight: offset + scrolled.length < rest.length,
    offset,
  };
}

/**
 * Fit a string to exactly `n` columns: truncate with a trailing ellipsis when
 * too long, right-pad with spaces when short. `n <= 0` → empty.
 */
export function pad(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length > n) return n <= 1 ? s.slice(0, n) : s.slice(0, n - 1) + "…";
  return s.padEnd(n);
}

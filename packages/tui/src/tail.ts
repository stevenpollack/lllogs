import type { EventRow } from "@lllogs/shared";

/**
 * The live event buffer + view position. Rows are kept ascending by id; the live
 * poll appends newer rows. Pure reducer functions below keep the scroll-pin and
 * cursor logic testable without Ink or a DB.
 */
export interface TailState {
  rows: EventRow[];
  /** Selected/highlighted row index into `rows`. */
  cursor: number;
  /** Max event id seen — the keyset cursor for the next poll (`afterId`). */
  lastId: number;
  /** New rows that arrived while scrolled up (cursor not at the bottom). */
  newCount: number;
}

/** True when the cursor sits on the last row (so the tail should auto-follow). */
export function atBottom(s: TailState): boolean {
  return s.cursor >= s.rows.length - 1;
}

/**
 * Apply a freshly-polled batch (ascending id). `follow` (caller-computed:
 * usually `sort === null && atBottom(prev)`) decides scroll-pin: when true we
 * move the cursor to the new bottom and stay caught up; when false the cursor
 * stays put and arrivals accumulate in `newCount` (shown as a "N new" hint).
 * Rows already at/below `lastId` are dropped, so an overlapping/stale poll is
 * idempotent.
 */
/** Cap the live buffer so a long-running monitor can't grow without bound. */
export const MAX_ROWS = 20_000;

export function applyAppend(prev: TailState, incoming: EventRow[], follow: boolean): TailState {
  const fresh = incoming.filter((r) => r.id > prev.lastId);
  if (fresh.length === 0) return prev;
  let rows = prev.rows.concat(fresh);
  let cursor = follow ? rows.length - 1 : prev.cursor;
  if (rows.length > MAX_ROWS) {
    // Keep the most recent MAX_ROWS; drop the oldest and shift the cursor to match.
    const drop = rows.length - MAX_ROWS;
    rows = rows.slice(drop);
    cursor = Math.max(0, cursor - drop);
  }
  return {
    rows,
    lastId: fresh[fresh.length - 1]!.id,
    cursor,
    newCount: follow ? 0 : prev.newCount + fresh.length,
  };
}

/**
 * Move the cursor to `to` (clamped to the buffer). Reaching the bottom clears
 * the unread `newCount` — the user has caught up.
 */
export function withCursor(s: TailState, to: number): TailState {
  const cursor = Math.max(0, Math.min(s.rows.length - 1, to));
  const newCount = cursor >= s.rows.length - 1 ? 0 : s.newCount;
  return { ...s, cursor, newCount };
}

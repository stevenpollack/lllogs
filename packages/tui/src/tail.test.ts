import { describe, expect, test } from "bun:test";
import { applyAppend, withCursor, atBottom, MAX_ROWS, type TailState } from "./tail";
import { makeRow } from "./fixtures";

function state(over: Partial<TailState> = {}): TailState {
  const rows = over.rows ?? [makeRow({ id: 1 }), makeRow({ id: 2 }), makeRow({ id: 3 })];
  return {
    rows,
    cursor: over.cursor ?? rows.length - 1,
    lastId: over.lastId ?? (rows.length ? rows[rows.length - 1]!.id : 0),
    newCount: over.newCount ?? 0,
  };
}

describe("applyAppend (scroll-pin)", () => {
  test("follow=true → appends and moves the cursor to the new bottom", () => {
    const next = applyAppend(state({ cursor: 2 }), [makeRow({ id: 4 }), makeRow({ id: 5 })], true);
    expect(next.rows.length).toBe(5);
    expect(next.cursor).toBe(4);
    expect(next.lastId).toBe(5);
    expect(next.newCount).toBe(0);
  });

  test("follow=false → cursor stays put, arrivals counted", () => {
    const next = applyAppend(
      state({ cursor: 0, lastId: 3 }),
      [makeRow({ id: 4 }), makeRow({ id: 5 })],
      false,
    );
    expect(next.cursor).toBe(0);
    expect(next.newCount).toBe(2);
    expect(next.lastId).toBe(5);
  });

  test("accumulates newCount across non-follow appends", () => {
    let s = state({ cursor: 0, lastId: 3 });
    s = applyAppend(s, [makeRow({ id: 4 })], false);
    s = applyAppend(s, [makeRow({ id: 5 }), makeRow({ id: 6 })], false);
    expect(s.newCount).toBe(3);
  });

  test("drops rows at/below lastId (idempotent on overlap)", () => {
    const next = applyAppend(
      state({ cursor: 2, lastId: 3 }),
      [makeRow({ id: 2 }), makeRow({ id: 3 }), makeRow({ id: 4 })],
      true,
    );
    expect(next.rows.length).toBe(4); // only id 4 is fresh
    expect(next.lastId).toBe(4);
  });

  test("empty / no-fresh incoming returns the same state reference", () => {
    const s = state({ cursor: 2, lastId: 3 });
    expect(applyAppend(s, [], true)).toBe(s);
    expect(applyAppend(s, [makeRow({ id: 1 })], true)).toBe(s);
  });

  test("empty buffer with follow → cursor at the bottom", () => {
    const next = applyAppend(
      { rows: [], cursor: 0, lastId: 0, newCount: 0 },
      [makeRow({ id: 1 }), makeRow({ id: 2 })],
      true,
    );
    expect(next.cursor).toBe(1);
    expect(next.newCount).toBe(0);
  });

  test("caps the buffer at MAX_ROWS, dropping the oldest and shifting the cursor", () => {
    const rows = Array.from({ length: MAX_ROWS }, (_, i) => makeRow({ id: i + 1 }));
    const prev: TailState = { rows, cursor: MAX_ROWS - 1, lastId: MAX_ROWS, newCount: 0 };
    const next = applyAppend(prev, [makeRow({ id: MAX_ROWS + 1 })], true);
    expect(next.rows.length).toBe(MAX_ROWS); // trimmed back to the cap
    expect(next.rows[0]!.id).toBe(2); // oldest (id 1) dropped
    expect(next.rows[next.rows.length - 1]!.id).toBe(MAX_ROWS + 1); // newest kept
    expect(next.cursor).toBe(MAX_ROWS - 1); // followed, then shifted by the drop
  });
});

describe("withCursor", () => {
  test("clamps to the buffer bounds", () => {
    const s = state({ cursor: 1 });
    expect(withCursor(s, -5).cursor).toBe(0);
    expect(withCursor(s, 99).cursor).toBe(2);
  });
  test("reaching the bottom clears the unread count", () => {
    const s = state({ cursor: 0, newCount: 4 });
    expect(withCursor(s, 2).newCount).toBe(0); // moved onto the last row
    expect(withCursor(s, 1).newCount).toBe(4); // still above the bottom
  });
});

describe("atBottom", () => {
  test("true only on the last row", () => {
    expect(atBottom(state({ cursor: 2 }))).toBe(true);
    expect(atBottom(state({ cursor: 1 }))).toBe(false);
  });
});

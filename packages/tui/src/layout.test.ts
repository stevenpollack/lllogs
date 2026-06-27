import { describe, expect, test } from "bun:test";
import { layoutColumns, pad, type LaidOutColumn } from "./layout";

const cols: LaidOutColumn[] = [
  { id: "time", label: "TIME", width: 10 },
  { id: "project", label: "PROJECT", width: 10 },
  { id: "tool", label: "TOOL", width: 10 },
  { id: "command", label: "COMMAND", width: 10 },
];

describe("pad", () => {
  test("right-pads a short string to width", () => {
    expect(pad("ab", 5)).toBe("ab   ");
  });
  test("truncates with an ellipsis when too long", () => {
    expect(pad("abcdef", 4)).toBe("abc…");
  });
  test("leaves an exact-width string unchanged", () => {
    expect(pad("abcd", 4)).toBe("abcd");
  });
  test("width <= 0 → empty", () => {
    expect(pad("abc", 0)).toBe("");
  });
  test("width 1 truncates without an ellipsis (no room for it)", () => {
    expect(pad("abc", 1)).toBe("a");
  });
});

describe("layoutColumns", () => {
  test("no freeze, ample width → all columns scroll, no more-indicators", () => {
    const l = layoutColumns(cols, new Set(), 100, 0);
    expect(l.frozen).toEqual([]);
    expect(l.scrolled.map((c) => c.id)).toEqual(["time", "project", "tool", "command"]);
    expect(l.moreLeft).toBe(false);
    expect(l.moreRight).toBe(false);
  });

  test("frozen column is split out and always present", () => {
    const l = layoutColumns(cols, new Set(["time"]), 100, 0);
    expect(l.frozen.map((c) => c.id)).toEqual(["time"]);
    expect(l.scrolled.map((c) => c.id)).toEqual(["project", "tool", "command"]);
  });

  test("narrow width windows the non-frozen columns and flags moreRight", () => {
    // time frozen (10+gap=11). avail = 24-11 = 13 → fits one 10-wide col (+0 gap),
    // a second needs 1+10=11 more → 21 > 13, so it stops at one.
    const l = layoutColumns(cols, new Set(["time"]), 24, 0);
    expect(l.frozen.map((c) => c.id)).toEqual(["time"]);
    expect(l.scrolled.map((c) => c.id)).toEqual(["project"]);
    expect(l.moreLeft).toBe(false);
    expect(l.moreRight).toBe(true);
  });

  test("offset shifts the window and flags moreLeft", () => {
    const l = layoutColumns(cols, new Set(["time"]), 24, 1);
    expect(l.scrolled.map((c) => c.id)).toEqual(["tool"]);
    expect(l.moreLeft).toBe(true);
    expect(l.moreRight).toBe(true);
    expect(l.offset).toBe(1);
  });

  test("offset is clamped to the last non-frozen column", () => {
    const l = layoutColumns(cols, new Set(["time"]), 24, 99);
    expect(l.offset).toBe(2); // rest = [project, tool, command] → max index 2
    expect(l.scrolled.map((c) => c.id)).toEqual(["command"]);
    expect(l.moreRight).toBe(false);
  });

  test("at least one non-frozen column renders even if it can't fully fit", () => {
    const l = layoutColumns(cols, new Set(), 3, 0);
    expect(l.scrolled.map((c) => c.id)).toEqual(["time"]);
  });

  test("empty visible set → everything empty, no indicators", () => {
    const l = layoutColumns([], new Set(), 80, 0);
    expect(l.frozen).toEqual([]);
    expect(l.scrolled).toEqual([]);
    expect(l.moreLeft).toBe(false);
    expect(l.moreRight).toBe(false);
  });
});

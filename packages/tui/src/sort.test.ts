import { describe, expect, test } from "bun:test";
import { sortRows, cycleSort } from "./sort";
import { columnById } from "./columns";
import { makeRow } from "./fixtures";

describe("sortRows", () => {
  test("string column ascending, id-ascending tiebreak", () => {
    const rows = [
      makeRow({ id: 1, tool: "Read" }),
      makeRow({ id: 2, tool: "Bash" }),
      makeRow({ id: 3, tool: "Bash" }),
    ];
    expect(sortRows(rows, { col: "tool", dir: 1 }, columnById).map((r) => r.id)).toEqual([2, 3, 1]);
  });

  test("descending reverses the primary but keeps the id tiebreak ascending", () => {
    const rows = [
      makeRow({ id: 1, tool: "Read" }),
      makeRow({ id: 2, tool: "Bash" }),
      makeRow({ id: 3, tool: "Bash" }),
    ];
    expect(sortRows(rows, { col: "tool", dir: -1 }, columnById).map((r) => r.id)).toEqual([
      1, 2, 3,
    ]);
  });

  test("the time column sorts by ts numerically, not lexically", () => {
    const rows = [
      makeRow({ id: 1, ts: 300 }),
      makeRow({ id: 2, ts: 100 }),
      makeRow({ id: 3, ts: 200 }),
    ];
    expect(sortRows(rows, { col: "time", dir: 1 }, columnById).map((r) => r.id)).toEqual([2, 3, 1]);
  });

  test("unknown column → unchanged", () => {
    const rows = [makeRow({ id: 1 }), makeRow({ id: 2 })];
    expect(sortRows(rows, { col: "nope", dir: 1 }, columnById).map((r) => r.id)).toEqual([1, 2]);
  });

  test("does not mutate the input array", () => {
    const rows = [makeRow({ id: 2, tool: "B" }), makeRow({ id: 1, tool: "A" })];
    sortRows(rows, { col: "tool", dir: 1 }, columnById);
    expect(rows.map((r) => r.id)).toEqual([2, 1]);
  });
});

describe("cycleSort", () => {
  test("none → asc → desc → none", () => {
    let s = cycleSort(null, "tool");
    expect(s).toEqual({ col: "tool", dir: 1 });
    s = cycleSort(s, "tool");
    expect(s).toEqual({ col: "tool", dir: -1 });
    s = cycleSort(s, "tool");
    expect(s).toBe(null);
  });

  test("switching to a different column restarts at ascending", () => {
    expect(cycleSort({ col: "tool", dir: -1 }, "kind")).toEqual({ col: "kind", dir: 1 });
  });
});

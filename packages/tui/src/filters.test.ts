import { describe, expect, test } from "bun:test";
import { asArray, type EventFilter } from "@lllogs/shared";
import { toggleFilterValue, describeFilter } from "./filters";

describe("toggleFilterValue", () => {
  test("adds a value as a scalar, then a second as an array", () => {
    let f: EventFilter = {};
    f = toggleFilterValue(f, "tool", "Bash");
    expect(asArray(f.tool)).toEqual(["Bash"]);
    f = toggleFilterValue(f, "tool", "Read");
    expect(asArray(f.tool)).toEqual(["Bash", "Read"]);
  });

  test("removing the last value drops the key entirely", () => {
    const f = toggleFilterValue({ tool: "Bash" }, "tool", "Bash");
    expect("tool" in f).toBe(false);
  });

  test("removing one of many collapses back to a scalar", () => {
    const f = toggleFilterValue({ tool: ["Bash", "Read"] }, "tool", "Bash");
    expect(f.tool).toBe("Read");
  });

  test("does not mutate the input filter", () => {
    const f: EventFilter = { tool: "Bash" };
    const g = toggleFilterValue(f, "tool", "Read");
    expect(f.tool).toBe("Bash");
    expect(asArray(g.tool)).toEqual(["Bash", "Read"]);
  });
});

describe("describeFilter", () => {
  test("summarizes dimensions and the q substring", () => {
    expect(describeFilter({ tool: ["Bash", "Read"], q: "foo" })).toBe('tool:Bash,Read · q:"foo"');
  });
  test("empty filter → empty string", () => {
    expect(describeFilter({})).toBe("");
  });
  test("shortens session ids", () => {
    expect(describeFilter({ session: "abcdef1234567890" })).toBe("session:abcdef12");
  });
});

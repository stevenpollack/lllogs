import { expect, test } from "bun:test";
import type { Facets } from "@lllogs/shared";
import { buildFacetItems } from "./facets";

const facets: Facets = {
  project: [
    { value: "lllogs", count: 10 },
    { value: "web", count: 3 },
  ],
  session: [],
  tool: [{ value: "Bash", count: 5 }],
  kind: [],
  role: [],
  error: [
    { value: "ok", count: 8 },
    { value: "error", count: 2 },
  ],
};

test("flattens dims in order, marking selected values", () => {
  const items = buildFacetItems(facets, { tool: "Bash", project: ["web"] });
  expect(items.map((i) => `${i.dim}:${i.value}`)).toEqual([
    "project:lllogs",
    "project:web",
    "tool:Bash",
    "error:ok",
    "error:error",
  ]);
  expect(items.find((i) => i.value === "web")!.selected).toBe(true);
  expect(items.find((i) => i.value === "Bash")!.selected).toBe(true);
  expect(items.find((i) => i.value === "lllogs")!.selected).toBe(false);
});

test("empty facets → empty list", () => {
  const empty: Facets = { project: [], session: [], tool: [], kind: [], role: [], error: [] };
  expect(buildFacetItems(empty, {})).toEqual([]);
});

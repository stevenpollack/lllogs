import type { EventFilter, EventRow, Facets } from "@clogdy/shared";
import { asArray } from "@clogdy/shared";
import { FACET_DIMS, type FacetDim } from "./filters";
import type { DataSource } from "./datasource";

/**
 * Build a fully-populated EventRow with sensible defaults; override any field.
 * Test-only helper shared across the TUI's component/interaction tests so they
 * never need a real DB.
 */
export function makeRow(over: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    uuid: "uuid-1",
    blockIdx: 0,
    parentUuid: null,
    sessionId: "sess1234deadbeef",
    project: "clogdy",
    cwd: "/home/u/clogdy",
    ts: Date.parse("2026-06-27T15:04:05.000Z"),
    kind: "tool_use",
    role: "assistant",
    tool: "Bash",
    command: "ls -la",
    corr: "toolu_01",
    isError: null,
    inputJson: null,
    result: null,
    stderr: null,
    diff: null,
    resultHead: null,
    text: null,
    durMs: null,
    gitBranch: "main",
    raw: "{}",
    ...over,
  };
}

/** The value a row contributes to a facet dimension (null = not counted). */
function dimValue(r: EventRow, dim: FacetDim): string | null {
  switch (dim) {
    case "project":
      return r.project || null;
    case "session":
      return r.sessionId || null;
    case "tool":
      return r.tool;
    case "kind":
      return r.kind;
    case "role":
      return r.role;
    case "error":
      return r.isError == null ? null : r.isError ? "error" : "ok";
  }
}

function filterVals(f: EventFilter, dim: FacetDim): string[] {
  return asArray(f[dim] as string | string[] | undefined).map(String);
}

/** Does the row pass every filter dimension except `except` (+ the q substring)? */
function matchesExcept(r: EventRow, f: EventFilter, except?: FacetDim): boolean {
  for (const dim of FACET_DIMS) {
    if (dim === except) continue;
    const vals = filterVals(f, dim);
    if (vals.length) {
      const v = dimValue(r, dim);
      if (v == null || !vals.includes(v)) return false;
    }
  }
  if (f.q != null && f.q !== "") {
    const q = f.q.toLowerCase(); // SQL LIKE is ASCII case-insensitive
    if (![r.command, r.text, r.result].some((s) => s != null && s.toLowerCase().includes(q)))
      return false;
  }
  if (f.corr != null && r.corr !== f.corr) return false;
  if (f.since !== undefined && r.ts < f.since) return false;
  if (f.until !== undefined && r.ts >= f.until) return false;
  return true;
}

const matches = (r: EventRow, f: EventFilter): boolean => matchesExcept(r, f);

/**
 * A faithful in-memory DataSource — applies every filter dimension + the q
 * substring (queryEvents/queryLatest) and computes exclude-own-dimension facet
 * counts (queryFacets), mirroring the real bun:sqlite query semantics. This is
 * the fixture seam component tests inject instead of a DB.
 */
export function makeFixtureDataSource(all: EventRow[]): DataSource {
  return {
    queryEvents: (f) => {
      let rows = all.filter((r) => matches(r, f));
      if (f.afterId !== undefined) rows = rows.filter((r) => r.id > f.afterId!);
      const limit = Math.min(f.limit ?? 200, 2000);
      const page = rows.slice(0, limit);
      const nextAfterId =
        page.length === limit && page.length > 0 ? page[page.length - 1]!.id : null;
      return { rows: page, nextAfterId };
    },
    queryLatest: (f) => {
      const rows = all.filter((r) => matches(r, f));
      const limit = Math.min(f.limit ?? 200, 2000);
      const page = rows.slice(-limit); // the last `limit`, already ascending
      const prevBeforeId = page.length === limit && page.length > 0 ? page[0]!.id : null;
      return { rows: page, prevBeforeId };
    },
    queryFacets: (f) => {
      const out: Facets = { project: [], session: [], tool: [], kind: [], role: [], error: [] };
      for (const dim of FACET_DIMS) {
        const counts = new Map<string, number>();
        for (const r of all) {
          if (!matchesExcept(r, f, dim)) continue;
          const v = dimValue(r, dim);
          if (v == null) continue;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        out[dim] = [...counts.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count);
      }
      return out;
    },
    maxEventId: () => all.reduce((m, r) => Math.max(m, r.id), 0),
  };
}

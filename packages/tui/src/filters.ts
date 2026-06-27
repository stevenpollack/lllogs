import type { EventFilter } from "@clogdy/shared";
import { asArray } from "@clogdy/shared";
import { shortSession } from "./columns";

/** The multi-value facet dimensions, in display order. */
export const FACET_DIMS = ["project", "session", "tool", "kind", "role", "error"] as const;
export type FacetDim = (typeof FACET_DIMS)[number];

function short(dim: FacetDim, v: string): string {
  return dim === "session" ? shortSession(v) : v;
}

/**
 * Toggle a single value within a facet dimension (OR-within-dimension): add it if
 * absent, remove it if present, and drop the key entirely when it empties. Pure —
 * returns a new filter, never mutates.
 */
export function toggleFilterValue(f: EventFilter, dim: FacetDim, value: string): EventFilter {
  const cur = asArray(f[dim] as string | string[] | undefined).map(String);
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  const out: EventFilter = { ...f };
  if (next.length === 0) {
    delete out[dim];
  } else {
    // Store a lone value as a scalar (matches how the rest of the stack reads it).
    // `dim` spans dims of differing value types (e.g. error: ErrorFilter), so
    // assign through an index signature rather than fight the union.
    (out as Record<string, unknown>)[dim] = next.length === 1 ? next[0] : next;
  }
  return out;
}

/** Compact active-filter summary for the status bar, e.g. `tool:Bash,Read · q:"foo"`. */
export function describeFilter(f: EventFilter): string {
  const parts: string[] = [];
  for (const dim of FACET_DIMS) {
    const vals = asArray(f[dim] as string | string[] | undefined);
    if (vals.length) parts.push(`${dim}:${vals.map((v) => short(dim, String(v))).join(",")}`);
  }
  if (f.corr) parts.push(`corr:${f.corr}`);
  if (f.q) parts.push(`q:"${f.q}"`);
  return parts.join(" · ");
}

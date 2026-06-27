import type { EventFilter, Facets } from "@lllogs/shared";
import { asArray } from "@lllogs/shared";
import { FACET_DIMS, type FacetDim } from "./filters";

/** One navigable row in the facet pane: a dimension value with its count + selection. */
export interface FacetItem {
  dim: FacetDim;
  value: string;
  count: number;
  selected: boolean;
}

export const EMPTY_FACETS: Facets = {
  project: [],
  session: [],
  tool: [],
  kind: [],
  role: [],
  error: [],
};

/**
 * Flatten the per-dimension facet buckets into one navigable list (dimensions in
 * FACET_DIMS order, values in the order the query returned them — count DESC),
 * marking which values the filter currently selects. Pure.
 */
export function buildFacetItems(facets: Facets, filter: EventFilter): FacetItem[] {
  const items: FacetItem[] = [];
  for (const dim of FACET_DIMS) {
    const selected = new Set(asArray(filter[dim] as string | string[] | undefined).map(String));
    for (const b of facets[dim]) {
      items.push({ dim, value: b.value, count: b.count, selected: selected.has(b.value) });
    }
  }
  return items;
}

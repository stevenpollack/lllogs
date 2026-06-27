import React from "react";
import type { Facets, EventFilter } from "@clogdy/shared";
import { asArray } from "@clogdy/shared";
import { usePersistedState } from "../usePersistedState";

type FacetDim = keyof Facets;

const FACET_DIMS: FacetDim[] = ["project", "session", "tool", "kind", "role", "error"];

function filterKey(dim: FacetDim): keyof EventFilter {
  return dim === "session" ? "session" : (dim as keyof EventFilter);
}

function shortSession(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

// Persist which sections are collapsed so e.g. a long PROJECT list can be folded
// away to reach KIND/TOOL, and stays that way across reloads.
const COLLAPSE_KEY = "clogdy.facetCollapsed.v1";

interface FacetSidebarProps {
  facets: Facets;
  filter: EventFilter;
  onToggle: (key: keyof EventFilter, value: string) => void;
}

export function FacetSidebar({ facets, filter, onToggle }: FacetSidebarProps): React.ReactElement {
  const [collapsed, setCollapsed] = usePersistedState<Record<string, boolean>>(COLLAPSE_KEY, {});

  const toggleSection = (dim: FacetDim): void => {
    setCollapsed((c) => ({ ...c, [dim]: !c[dim] }));
  };

  return (
    <aside id="facets">
      {FACET_DIMS.map((dim) => {
        const key = filterKey(dim);
        const selected = asArray(filter[key]);
        const isCollapsed = !!collapsed[dim];
        return (
          <React.Fragment key={dim}>
            <h3
              className="facet-head"
              onClick={() => toggleSection(dim)}
              aria-expanded={!isCollapsed}
            >
              <span className="facet-caret">{isCollapsed ? "▸" : "▾"}</span>
              <span className="facet-dim">{dim}</span>
              <span className="facet-n">{facets[dim].length}</span>
            </h3>
            {!isCollapsed &&
              facets[dim].map((b) => {
                const label = dim === "session" ? shortSession(b.value) : b.value;
                const isActive = selected.includes(b.value);
                return (
                  <div
                    key={b.value}
                    className={isActive ? "facet active" : "facet"}
                    onClick={() => onToggle(key, b.value)}
                  >
                    <span>{label || "(none)"}</span>
                    <span className="count">{b.count}</span>
                  </div>
                );
              })}
          </React.Fragment>
        );
      })}
    </aside>
  );
}

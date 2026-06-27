import type { Database } from "bun:sqlite";
import type { EventFilter, EventRow, Facets } from "@clogdy/shared";
import { queryEvents, queryLatest, queryFacets, maxEventId } from "@clogdy/server/src/queries";

/**
 * The data seam every Ink component depends on. Production wires it over a
 * read-only `bun:sqlite` handle (`makeSqliteDataSource`); tests pass a fixture so
 * the UI renders deterministically with no real DB, ingester, or server. This is
 * what keeps the components headless-testable (see the plan's Testing section).
 *
 * All methods are synchronous: `bun:sqlite` reads are blocking, so the table,
 * facets, and the live poll all read straight through with no async plumbing.
 */
export interface DataSource {
  queryEvents(filter: EventFilter): { rows: EventRow[]; nextAfterId: number | null };
  queryLatest(filter: EventFilter): { rows: EventRow[]; prevBeforeId: number | null };
  queryFacets(filter: EventFilter): Facets;
  maxEventId(): number;
}

/**
 * The production DataSource: thin adapters over the server's pure query
 * functions, bound to one read-only DB handle. Imports `queries.ts` directly
 * (NOT the `@clogdy/server` index, which pulls in Hono) — queries.ts only needs
 * `bun:sqlite` + `@clogdy/shared`, so DuckDB/Hono never enter this process.
 */
export function makeSqliteDataSource(db: Database): DataSource {
  return {
    queryEvents: (f) => queryEvents(db, f),
    queryLatest: (f) => queryLatest(db, f),
    queryFacets: (f) => queryFacets(db, f),
    maxEventId: () => maxEventId(db),
  };
}

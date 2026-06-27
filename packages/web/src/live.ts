import type { EventFilter, EventRow } from "@clogdy/shared";
import { appendParam } from "./api";
import { log } from "./log";

/**
 * Open an SSE subscription to /api/events/stream.
 * @param filter  The active EventFilter (facets, search, etc.)
 * @param lastId  The table's current max id; the stream starts after this.
 * @param onAppend  Called with each batch of new EventRows as they arrive.
 * @returns An unsubscribe function that closes the EventSource.
 */
export function subscribe(
  filter: EventFilter,
  lastId: number,
  onAppend: (rows: EventRow[]) => void,
): () => void {
  const es = new EventSource(streamUrl(filter, lastId));
  log.info({ evt: "sse.open", lastId, filters: Object.keys(filter) });

  es.addEventListener("append", (e: Event) => {
    const me = e as MessageEvent<string>;
    let parsed: { events: EventRow[]; lastId: number };
    try {
      parsed = JSON.parse(me.data) as { events: EventRow[]; lastId: number };
    } catch {
      log.debug({ evt: "sse.frame_bad" });
      return; // ignore malformed frames
    }
    if (Array.isArray(parsed.events) && parsed.events.length > 0) {
      log.debug({ evt: "sse.append", n: parsed.events.length, lastId: parsed.lastId });
      onAppend(parsed.events);
    }
  });

  // ping: intentionally no-op; the EventSource keeps the connection alive.

  return () => {
    log.info({ evt: "sse.close" });
    es.close();
  };
}

// --- Pure helpers (exported for unit testing) ---

/**
 * Build the SSE stream URL: each active filter value as a (repeated) query param
 * plus the `lastId` cursor. Reuses api.ts's appendParam so a multi-value facet is
 * sent as repeated params (e.g. role=user&role=assistant), NOT collapsed to one
 * comma-joined value the server treats as a single literal — which matched zero
 * rows, silently stalling live updates while a multi-value facet was active.
 */
export function streamUrl(filter: EventFilter, lastId: number): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) appendParam(p, k, v);
  p.set("lastId", String(lastId));
  return `/api/events/stream?${p.toString()}`;
}

/**
 * Merge incoming rows into an existing sorted-by-id array.
 * De-duplicates by id; maintains id ASC order.
 * Assumes existing is already sorted ASC and incoming arrives ASC (both guaranteed by the contract).
 */
export function mergeAppend(existing: EventRow[], incoming: EventRow[]): EventRow[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((r) => r.id));
  const novel = incoming.filter((r) => !seen.has(r.id));
  if (novel.length === 0) return existing;
  return [...existing, ...novel];
}

/**
 * Compute dashboard tile values from facets + a windowed total count.
 *
 * @param kindBuckets   facets.kind (covers every event exactly once → total = sum of counts)
 * @param errorBuckets  facets.error (buckets with value "error" | "ok")
 * @param toolBuckets   facets.tool (ordered by count DESC → first = top tool)
 * @param windowCount   total events in the last 5 min (from a windowed facet call)
 * @returns 4 display strings: [total, last5min, errorRate, topTool]
 */
export function computeTiles(
  kindBuckets: Array<{ value: string; count: number }>,
  errorBuckets: Array<{ value: string; count: number }>,
  toolBuckets: Array<{ value: string; count: number }>,
  windowCount: number,
): [string, string, string, string] {
  const total = kindBuckets.reduce((s, b) => s + b.count, 0);

  let errors = 0;
  let ok = 0;
  for (const b of errorBuckets) {
    if (b.value === "error") errors = b.count;
    else if (b.value === "ok") ok = b.count;
  }
  const denom = errors + ok;
  const errorRate = denom === 0 ? "—" : `${Math.round((errors / denom) * 100)}%`;

  const topTool = toolBuckets.length > 0 ? toolBuckets[0]!.value : "—";

  return [String(total), String(windowCount), errorRate, topTool];
}

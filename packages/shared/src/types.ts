/** A normalized tool-usage event: one row per content block of interest. */
export interface FlatEvent {
  uuid: string; // transcript line uuid (fallback: `${sessionId}:${lineIndex}` if absent)
  blockIdx: number; // 0-based index of the block within the line (prompt → 0)
  parentUuid: string | null;
  sessionId: string;
  project: string; // basename(cwd); "" if no cwd seen on the line
  cwd: string | null;
  ts: number; // ms epoch (Date.parse(timestamp)); 0 if unparseable
  kind: EventKind;
  role: string | null; // message.role (user/assistant); null if absent
  tool: string | null; // tool_use name
  command: string | null; // primary arg of a tool call
  corr: string | null; // tool id linking tool_use <-> tool_result
  isError: boolean | null; // tool_result error flag; null when N/A
  inputJson: string | null; // full tool input, compact JSON
  result: string | null; // tool_result text / Bash stdout
  stderr: string | null; // Bash stderr
  diff: string | null; // unified-diff text from structuredPatch
  resultHead: string | null; // one-line result summary
  text: string | null; // prompt / assistant text / thinking
  durMs: number | null; // tool latency; null at insert (computed later/queries)
  gitBranch: string | null;
  raw: string; // the original JSONL line (verbatim)
}

export type EventKind = "prompt" | "text" | "thinking" | "tool_use" | "tool_result";

/** Filters accepted by the query layer and the HTTP API (all optional / AND-combined). */
export interface EventFilter {
  // Facet dimensions accept one value or many (OR within a dimension → SQL IN).
  // A single string is still valid (backward compatible); the UI sends an array
  // when more than one value of a dimension is selected.
  project?: string | string[]; // exact project name(s)
  session?: string | string[]; // exact full sessionId(s) (UI may pass short → server expands; see API)
  tool?: string | string[]; // exact tool name(s)
  kind?: EventKind | EventKind[];
  role?: string | string[]; // exact message.role(s)
  error?: ErrorFilter | ErrorFilter[]; // maps to isError = 1 / 0
  corr?: string; // exact correlation id
  since?: number; // ts >= since (ms epoch)
  until?: number; // ts <  until (ms epoch)
  q?: string; // substring match over (command, text, result) — LIKE %q%
  afterId?: number; // id > afterId (keyset pagination / live cursor)
  limit?: number; // default 200, max 2000
}

export type ErrorFilter = "error" | "ok";

/** Normalize a single-or-array (or absent) filter value to a flat array. */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

/** A row as returned to the API (FlatEvent + the DB id). */
export interface EventRow extends FlatEvent {
  id: number; // event.id (== rowid), the live/pagination cursor
}

export interface FacetBucket {
  value: string;
  count: number;
}
export interface Facets {
  project: FacetBucket[];
  session: FacetBucket[];
  tool: FacetBucket[];
  kind: FacetBucket[];
  role: FacetBucket[];
  error: FacetBucket[];
}

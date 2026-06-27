import type { EventRow } from "@lllogs/shared";
import { formatToolInput } from "@lllogs/shared";

/**
 * One displayable table column. `value` returns a SINGLE-LINE string for the
 * cell (the terminal table is one text line per row — the drawer shows the rich,
 * multi-line form). `width` is the fixed render width; content is truncated to
 * it (no drag-resize — Ink is keyboard-only). Horizontal scroll + freeze decide
 * which columns are on screen; see layout.ts.
 */
export interface ColumnDef {
  id: string;
  label: string;
  width: number;
  value: (e: EventRow) => string;
  /** Sort comparator key; defaults to `value` (string) when omitted. Numeric for
   *  time/dur/error so they don't sort lexically. */
  sortKey?: (e: EventRow) => string | number;
}

/** Collapse any whitespace run (newlines/tabs) to single spaces for one-line cells. */
export function oneLine(s: string | null | undefined): string {
  return s ? s.replace(/\s+/g, " ").trim() : "";
}

export function shortSession(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

/** Compact local timestamp "MM-DD HH:MM:SS" — monitoring wants day + seconds.
 *  Shared with the drawer so the table cell and the detail header agree (same
 *  timezone, same format). */
export function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** COMMAND cell: prefer the primary arg, else a compact tool-input preview, else text. */
function cmdValue(e: EventRow): string {
  if (e.command) return oneLine(e.command);
  const lines = formatToolInput(e.tool, e.inputJson);
  if (lines.length) return oneLine(lines.map((l) => l.text).join(" · "));
  return oneLine(e.text);
}

/** Every column the table can show. Order here is the default column order. */
export const ALL_COLUMNS: ColumnDef[] = [
  { id: "time", label: "TIME", width: 14, value: (e) => fmtTime(e.ts), sortKey: (e) => e.ts },
  { id: "project", label: "PROJECT", width: 16, value: (e) => oneLine(e.project) },
  { id: "session", label: "SESSION", width: 8, value: (e) => shortSession(e.sessionId) },
  { id: "kind", label: "KIND", width: 11, value: (e) => e.kind },
  { id: "tool", label: "TOOL", width: 12, value: (e) => oneLine(e.tool) },
  { id: "command", label: "COMMAND", width: 40, value: cmdValue },
  {
    id: "error",
    label: "ERR",
    width: 4,
    value: (e) => (e.isError === true ? "ERR" : ""),
    sortKey: (e) => (e.isError === true ? 2 : e.isError === false ? 1 : 0),
  },
  { id: "result", label: "RESULT", width: 40, value: (e) => oneLine(e.resultHead ?? e.result) },
  { id: "text", label: "TEXT", width: 40, value: (e) => oneLine(e.text) },
  { id: "corr", label: "CORR", width: 10, value: (e) => oneLine(e.corr) },
  {
    id: "dur",
    label: "DUR",
    width: 7,
    value: (e) => (e.durMs != null ? `${e.durMs}ms` : ""),
    sortKey: (e) => e.durMs ?? -1,
  },
  { id: "branch", label: "BRANCH", width: 14, value: (e) => oneLine(e.gitBranch) },
];

/** Columns shown on first run — the monitoring essentials. */
export const DEFAULT_VISIBLE: string[] = [
  "time",
  "project",
  "session",
  "kind",
  "tool",
  "command",
  "error",
];

export function columnById(id: string): ColumnDef | undefined {
  return ALL_COLUMNS.find((c) => c.id === id);
}

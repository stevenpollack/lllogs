import type { LoggerOptions } from "pino";

/** The canonical level set — one source of truth for the LogLevel type and the node/web validators. */
export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Shared pino options so the node and browser loggers emit ONE evidence schema:
 * string `level`, ISO `ts`, `msg` message key. Per-process `base: {proc, pid}` and the
 * destination are set by the node/web factories. Pure object — no I/O, safe in the browser.
 * NOTE: pino/browser ignores `formatters`/`timestamp`/`base`; the web factory (a later phase)
 * normalizes its output in a `write` hook to match this schema.
 */
export const SCHEMA_OPTS: LoggerOptions = {
  messageKey: "msg",
  formatters: { level: (label) => ({ level: label }) },
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
};

/** One parsed structured-log line — the evidence record asserted on by tests. */
export interface LogEntry {
  ts: string;
  level: LogLevel;
  proc: string;
  pid?: number;
  evt?: string;
  msg?: string;
  [k: string]: unknown;
}

/** Parse JSONL log text (a log file's contents or a captured console stream) into entries. Skips blank / non-JSON lines. */
export function parseLogLines(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as LogEntry);
    } catch {
      // skip non-JSON (a stray banner, a pino-pretty header, unrelated console noise)
    }
  }
  return out;
}

/** Filter parsed entries by event name and/or level — the assertion primitive for bun:test + Playwright. */
export function selectEvents(
  entries: LogEntry[],
  q: { evt?: string; level?: LogLevel },
): LogEntry[] {
  return entries.filter(
    (e) =>
      (q.evt === undefined || e.evt === q.evt) && (q.level === undefined || e.level === q.level),
  );
}

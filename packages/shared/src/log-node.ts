import pino, { type Logger } from "pino";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LOG_LEVELS, SCHEMA_OPTS, type LogLevel } from "./log";

/**
 * Build a process logger. Sink precedence:
 *  - CLOGDY_LOG_DIR set → `<dir>/<proc>[-<pid>].jsonl` (sync append; analytics gets per-pid because
 *    it is spawned per-request and concurrent — one shared file would tear mid-line).
 *  - else proc "analytics" → SILENT. Its stdout is the JSON-result wire and its stderr is the
 *    error-string wire the server forwards to the user; both are reserved. Forced silent, and the
 *    (unused) destination points at fd 2 so it can NEVER reach stdout (fd 1) even if misused.
 *  - else → stderr (fd 2), sync.
 * Level from CLOGDY_LOG_LEVEL (default "info", validated — an unknown value must NOT throw at construction).
 */
export function nodeLogger(proc: string): Logger {
  const envLevel = process.env.CLOGDY_LOG_LEVEL as LogLevel | undefined;
  const level: LogLevel = envLevel && LOG_LEVELS.includes(envLevel) ? envLevel : "info";
  const dir = process.env.CLOGDY_LOG_DIR;
  const base = { proc, pid: process.pid };

  if (dir) {
    mkdirSync(dir, { recursive: true });
    const file = proc === "analytics" ? `analytics-${process.pid}.jsonl` : `${proc}.jsonl`;
    return pino(
      { ...SCHEMA_OPTS, level, base },
      pino.destination({ dest: join(dir, file), sync: true }),
    );
  }
  if (proc === "analytics") {
    return pino({ ...SCHEMA_OPTS, level: "silent", base }, pino.destination({ fd: 2, sync: true }));
  }
  return pino({ ...SCHEMA_OPTS, level, base }, pino.destination({ fd: 2, sync: true }));
}

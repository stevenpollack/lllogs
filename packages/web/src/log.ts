import pino from "pino";
import { LOG_LEVELS, type LogLevel } from "@lllogs/shared";

const LEVEL_LABEL: Record<number, LogLevel> = { 20: "debug", 30: "info", 40: "warn", 50: "error" };

function resolveLevel(): LogLevel {
  let v: string | null = null;
  try {
    v = new URLSearchParams(window.location.search).get("log");
  } catch {
    /* noop */
  }
  if (!v) {
    try {
      v = window.localStorage.getItem("lllogs:log");
    } catch {
      /* noop */
    }
  }
  const lvl = (v ?? "warn") as LogLevel;
  return LOG_LEVELS.includes(lvl) ? lvl : "warn";
}

// pino/browser ignores formatters/timestamp/base — it emits {time:<epoch>, level:<number>} with no
// `proc`. Normalize here so browser logs match the NODE evidence schema (ts ISO / string level / proc).
export const log = pino({
  level: resolveLevel(),
  browser: {
    asObject: true,
    // pino types `write` as WriteFn (param `object`); narrow to a record inside.
    write: (o: object) => {
      const rec = o as Record<string, unknown>;
      const lvl = rec.level;
      // Copy the payload first, then set the normalized keys LAST so they always win over a
      // caller-supplied `proc`/`ts`/`msg` collision — the proc:"web" capture marker must hold.
      const entry: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (k !== "time" && k !== "level") entry[k] = v;
      }
      entry.ts = new Date(typeof rec.time === "number" ? rec.time : Date.now()).toISOString();
      entry.level = typeof lvl === "number" ? (LEVEL_LABEL[lvl] ?? "info") : lvl;
      entry.proc = "web";
      console.log(JSON.stringify(entry)); // pure JSON line; proc:"web" marks our logs for capture
    },
  },
});

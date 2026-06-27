import { describe, expect, it } from "bun:test";
import pino from "pino";
import { SCHEMA_OPTS, parseLogLines, selectEvents, type LogEntry, type LogLevel } from "./log";

/**
 * Build a pino logger writing JSONL into an in-memory buffer (no fd, no file) so a test can
 * read back exactly what the schema serializes. Construct pino directly from SCHEMA_OPTS — this
 * test stays isomorphic and must NOT import `@clogdy/shared/node` (the node-only sink).
 */
function capture(level: LogLevel = "debug") {
  const buf: string[] = [];
  const log = pino(
    { ...SCHEMA_OPTS, level, base: { proc: "test", pid: process.pid } },
    {
      write: (s: string) => {
        buf.push(s);
      },
    },
  );
  return { log, entries: (): LogEntry[] => parseLogLines(buf.join("")) };
}

describe("level gating", () => {
  it("at level warn, debug/info emit nothing and warn/error emit lines", () => {
    const { log, entries } = capture("warn");
    log.debug({ evt: "d" });
    log.info({ evt: "i" });
    log.warn({ evt: "w" });
    log.error({ evt: "e" });

    expect(entries().map((e) => e.evt)).toEqual(["w", "e"]);
    expect(selectEvents(entries(), { evt: "d" })).toHaveLength(0);
    expect(selectEvents(entries(), { evt: "i" })).toHaveLength(0);
  });
});

describe("schema shape", () => {
  it("emits string level, ISO ts, proc, numeric pid, evt — and no hostname", () => {
    const { log, entries } = capture("info");
    log.info({ evt: "shape" });

    const [e] = entries();
    expect(typeof e.level).toBe("string");
    expect(e.level).toBe("info");
    expect(e.ts).toMatch(/\dT.*Z$/);
    expect(e.proc).toBe("test");
    expect(typeof e.pid).toBe("number");
    expect(e.evt).toBe("shape");
    expect(e).not.toHaveProperty("hostname");
  });
});

describe("never-throws (safe serialization — the pino correctness win)", () => {
  it("logs a circular object without throwing, marking the cycle [Circular]", () => {
    const { log, entries } = capture("info");
    const circ: { self?: unknown } = {};
    circ.self = circ;

    expect(() => log.info({ evt: "circ", circ })).not.toThrow();
    const [e] = entries();
    expect((e.circ as { self: unknown }).self).toBe("[Circular]");
  });

  it("serializes an Error's message and stack without throwing", () => {
    const { log, entries } = capture("info");

    expect(() => log.error({ evt: "err", err: new Error("boom") })).not.toThrow();
    const [e] = entries();
    const err = e.err as { message: string; stack: string };
    expect(err.message).toBe("boom");
    expect(typeof err.stack).toBe("string");
  });
});

describe("parseLogLines", () => {
  it("skips blank and non-JSON lines, keeping the JSON ones in order", () => {
    const text = [
      "",
      "   ",
      "a stray banner line",
      '{"level":"info","ts":"2026-01-01T00:00:00.000Z","proc":"a","evt":"x"}',
      "pino-pretty [12:00:00.000] INFO: header",
      '{"level":"warn","ts":"2026-01-01T00:00:01.000Z","proc":"a","evt":"y"}',
    ].join("\n");

    expect(parseLogLines(text).map((e) => e.evt)).toEqual(["x", "y"]);
  });
});

describe("selectEvents", () => {
  const entries: LogEntry[] = [
    { ts: "t", level: "info", proc: "a", evt: "open" },
    { ts: "t", level: "warn", proc: "a", evt: "open" },
    { ts: "t", level: "info", proc: "a", evt: "close" },
  ];

  it("filters by evt", () => {
    expect(selectEvents(entries, { evt: "open" })).toHaveLength(2);
  });
  it("filters by level", () => {
    expect(selectEvents(entries, { level: "warn" })).toHaveLength(1);
  });
  it("filters by evt AND level together", () => {
    const r = selectEvents(entries, { evt: "open", level: "info" });
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("info");
  });
});

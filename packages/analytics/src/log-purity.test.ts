/**
 * Phase 4 — analytics stdout-purity + file-only-logging evidence test.
 *
 * GROUND RULE #3: this file exercises DuckDB only through the SPAWNED analytics
 * CLI; it never imports bun:sqlite or @lllogs/ingest. The fixture DB is built by
 * spawning the ingest CLI in a separate child process (as the sibling
 * query.test.ts does), then the analytics CLI opens it READ_ONLY.
 *
 * THE CRITICAL INVARIANT under test: the analytics process's stdout is the JSON
 * wire the server JSON.parse()s, and its stderr is the error-string wire the
 * server forwards to the user. So nodeLogger("analytics") must write to a FILE
 * only (when LLLOGS_LOG_DIR is set) and otherwise stay SILENT — never a byte to
 * stdout/stderr. These tests prove exactly that, even with logging at debug.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLogLines, selectEvents } from "@lllogs/shared";
import { ingestFixture, transcriptLine } from "@lllogs/shared/testing";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

const T = 1700000000000; // fixed epoch — deterministic fixture
const SESSION = "sess-purity";
const CWD = "/tmp/sessions/purityProj";

/** Build one JSONL transcript line (binds this suite's SESSION/CWD; mirrors the sibling query.test.ts helper). */
const line = (o: { uuid: string; ts: number; content: unknown[]; role?: string }): string =>
  transcriptLine({ ...o, sessionId: SESSION, cwd: CWD });

// Two tool_use (Bash, Read) + their tool_results → toolCounts yields {Bash:1, Read:1}.
const TRANSCRIPT = [
  line({
    uuid: "p1",
    ts: T,
    content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
  }),
  line({
    uuid: "p2",
    ts: T + 10,
    content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x" } }],
  }),
  line({
    uuid: "p3",
    ts: T + 20,
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }],
  }),
  line({
    uuid: "p4",
    ts: T + 30,
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t2", content: "data", is_error: false }],
  }),
].join("\n");

let tmpDir: string;
let tmpDb: string;
let logDir: string;
let metricStdout: string;
let metricStderr: string;
let metricExit: number | null;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lllogs-purity-"));
  const tree = join(tmpDir, "tree");
  // basename(cwd) determines the project slug; any dir name works as the holder.
  const projDir = join(tree, "purityProj-slug");
  mkdirSync(projDir, { recursive: true });
  // Trailing \n: the tailer only emits lines up to the last "\n".
  writeFileSync(join(projDir, `${SESSION}.jsonl`), `${TRANSCRIPT}\n`);

  tmpDb = join(tmpDir, "fixture.db");
  ingestFixture({ root: tree, db: tmpDb });

  // Run analytics ONCE with file logging at debug. Test 1 asserts on its stdout/
  // exit, Test 2 on the JSONL file it writes — captured here in beforeAll so the
  // two assertions don't depend on inter-test execution order.
  logDir = join(tmpDir, "logs");
  const env = { ...process.env, LLLOGS_LOG_DIR: logDir, LLLOGS_LOG_LEVEL: "debug" };
  const run = Bun.spawnSync(
    ["bun", "run", "analytics", "--", "--db", tmpDb, "--metric", "toolCounts"],
    { cwd: REPO_ROOT, env },
  );
  metricStdout = run.stdout.toString();
  metricStderr = run.stderr.toString();
  metricExit = run.exitCode;
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("analytics logging purity (Phase 4)", () => {
  // Test 1 — proves the invariant: stdout stays byte-pure JSON even with file
  // logging active at debug (the server does JSON.parse(stdout); a stray log byte
  // would corrupt it), and no log leaks onto the stderr error wire either.
  it("keeps stdout pure JSON with LLLOGS_LOG_DIR + debug logging", () => {
    expect(metricExit).toBe(0);
    const parsed = JSON.parse(metricStdout) as { metric?: unknown; data?: unknown };
    expect(parsed).toHaveProperty("metric");
    expect(parsed).toHaveProperty("data");
    expect(parsed.metric).toBe("toolCounts");

    // Logs went to the file, so the stderr error wire stays clean.
    expect(metricStderr).not.toContain("analytics:");
    expect(parseLogLines(metricStderr).filter((e) => e.proc === "analytics")).toHaveLength(0);
  });

  // Test 2 — the file sink works and carries the Phase 4 schema: run + done (info)
  // and attach (debug, the ground-rule-#4 READ_ONLY evidence).
  it("writes analytics-<pid>.jsonl with run/done/attach events", () => {
    const files = readdirSync(logDir).filter((f) => /^analytics-\d+\.jsonl$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const text = files.map((f) => readFileSync(join(logDir, f), "utf8")).join("\n");
    const lines = parseLogLines(text);

    expect(selectEvents(lines, { evt: "analytics.run" }).length).toBeGreaterThan(0);
    expect(selectEvents(lines, { evt: "analytics.done" }).length).toBeGreaterThan(0);
    expect(selectEvents(lines, { evt: "analytics.attach", level: "debug" }).length).toBeGreaterThan(
      0,
    );
  });

  // Test 3 — without LLLOGS_LOG_DIR the analytics logger is SILENT (even at debug):
  // stdout stays pure JSON and stderr carries NO structured log line, keeping it
  // reserved as the single human error wire the server forwards.
  it("stays silent without LLLOGS_LOG_DIR — no log bytes on stdout or stderr", () => {
    // Drop LLLOGS_LOG_DIR (it may be set in the runner's own env) so the child
    // truly runs without a log directory.
    const { LLLOGS_LOG_DIR: _drop, ...baseEnv } = process.env;
    const env = { ...baseEnv, LLLOGS_LOG_LEVEL: "debug" };
    const run = Bun.spawnSync(
      ["bun", "run", "analytics", "--", "--db", tmpDb, "--metric", "toolCounts"],
      { cwd: REPO_ROOT, env },
    );

    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout.toString()) as { metric?: unknown };
    expect(parsed.metric).toBe("toolCounts");

    // No analytics structured-log entry may appear on stderr (the error wire).
    const stderrLogs = parseLogLines(run.stderr.toString()).filter((e) => e.proc === "analytics");
    expect(stderrLogs).toHaveLength(0);
  });
});

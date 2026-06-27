/**
 * T-5.1 query.test.ts -- tests for runQuery (DuckDB process; never imports bun:sqlite).
 *
 * GROUND RULE #3: this file loads DuckDB. It MUST NOT import bun:sqlite or
 * @clogdy/ingest. The fixture DB is built by SPAWNING the ingest CLI in a
 * separate child process, then DuckDB opens it READ_ONLY here.
 *
 * Note on getRowsJson() value types:
 *   DuckDB INTEGER/BIGINT columns come back as strings via getRowsJson() (the Json
 *   type serializes bigints as strings). DOUBLE/FLOAT columns come back as numbers.
 *   Tests use Number() to normalize comparisons.
 *
 * Note on CTE self-join limitation (DuckDB bug):
 *   A self-join on a CTE backed by the SQLite scanner crashes DuckDB's CTEInlining
 *   optimizer with "Attempted to access index 0 within vector of size 0". This is a
 *   known DuckDB internal bug (not in our code). Test (b) therefore proves
 *   DuckDB analytical SQL works via quantile_cont on ts (no self-join required).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventFilter } from "@clogdy/shared";
import { ingestFixture, transcriptLine as line } from "@clogdy/shared/testing";
import { runQuery, withDuck } from "./duck";

// Fixed epoch for deterministic hand-computation.
const T = 1700000000000; // 2023-11-14T22:13:20Z

// Two projects so we can test facet scoping.
const PROJECT_X = "projX";
const CWD_X = `/tmp/sessions/${PROJECT_X}`;
const SESSION_X = "sess-xxxx";

const PROJECT_Y = "projY";
const CWD_Y = `/tmp/sessions/${PROJECT_Y}`;
const SESSION_Y = "sess-yyyy";

// Fixture:
//   Project X: 2 tool_use (Bash, Read) + 2 tool_result
//   Project Y: 1 tool_use (Edit) + 1 tool_result
//
// Total events: 6 (4 in X, 2 in Y)
// tool_use in X: {Bash:1, Read:1}; in Y: {Edit:1}
// Facet-scoped by project=X should see only Bash/Read.
//
// For cap+truncated: cap=2 over 6 total events should truncate.

const TRANSCRIPT_X = [
  line({
    uuid: "x1",
    ts: T,
    sessionId: SESSION_X,
    cwd: CWD_X,
    content: [{ type: "tool_use", id: "tx1", name: "Bash", input: { command: "ls" } }],
  }),
  line({
    uuid: "x2",
    ts: T,
    sessionId: SESSION_X,
    cwd: CWD_X,
    content: [{ type: "tool_use", id: "tx2", name: "Read", input: { file_path: "/x" } }],
  }),
  line({
    uuid: "x3",
    ts: T + 200,
    role: "user",
    sessionId: SESSION_X,
    cwd: CWD_X,
    content: [{ type: "tool_result", tool_use_id: "tx1", content: "ok", is_error: false }],
    toolUseResult: { stdout: "ok", stderr: "" },
  }),
  line({
    uuid: "x4",
    ts: T + 100,
    role: "user",
    sessionId: SESSION_X,
    cwd: CWD_X,
    content: [{ type: "tool_result", tool_use_id: "tx2", content: "data", is_error: false }],
    toolUseResult: { stdout: "data", stderr: "" },
  }),
].join("\n");

const TRANSCRIPT_Y = [
  line({
    uuid: "y1",
    ts: T + 50,
    sessionId: SESSION_Y,
    cwd: CWD_Y,
    content: [{ type: "tool_use", id: "ty1", name: "Edit", input: { file_path: "/y" } }],
  }),
  line({
    uuid: "y2",
    ts: T + 300,
    role: "user",
    sessionId: SESSION_Y,
    cwd: CWD_Y,
    content: [{ type: "tool_result", tool_use_id: "ty1", content: "saved", is_error: false }],
    toolUseResult: { stdout: "saved", stderr: "" },
  }),
].join("\n");

let tmpDir: string;
let tmpDb: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "clogdy-query-"));
  const tree = join(tmpDir, "tree");
  // Project directories: basename(cwd) determines the project name.
  const xDir = join(tree, "projX-slug");
  const yDir = join(tree, "projY-slug");
  mkdirSync(xDir, { recursive: true });
  mkdirSync(yDir, { recursive: true });
  // Trailing \n: the tailer only emits lines up to the last "\n".
  writeFileSync(join(xDir, `${SESSION_X}.jsonl`), `${TRANSCRIPT_X}\n`);
  writeFileSync(join(yDir, `${SESSION_Y}.jsonl`), `${TRANSCRIPT_Y}\n`);
  tmpDb = join(tmpDir, "fixture.db");

  ingestFixture({ root: tree, db: tmpDb });
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

const EMPTY: EventFilter = {};

describe("runQuery via withDuck", () => {
  // (a) GROUP BY query -- assert columns ["tool","n"] and hand-computed counts.
  // Note: getRowsJson() returns INTEGER/BIGINT values as strings (Json type has no bigint).
  it("(a) GROUP BY tool: columns=[tool,n], tool_use counts across all projects", async () => {
    const result = await withDuck(tmpDb, (conn) =>
      runQuery(
        conn,
        "SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool ORDER BY tool",
        EMPTY,
        1000,
      ),
    );
    expect(result.columns).toEqual(["tool", "n"]);
    // Normalize values with Number() since INTEGER comes back as string from getRowsJson.
    const byTool = Object.fromEntries(result.rows.map((r) => [r[0] as string, Number(r[1])]));
    // X: Bash=1, Read=1; Y: Edit=1
    expect(byTool).toEqual({ Bash: 1, Read: 1, Edit: 1 });
    expect(result.truncated).toBe(false);
  });

  // (b) Quantile/window query -- proves DuckDB analytical SQL (quantile_cont) works via CTE.
  // Uses quantile on ts (a DOUBLE-returning aggregate) to avoid a CTE self-join, which
  // triggers a DuckDB CTEInlining bug when combined with the SQLite scanner (internal assertion
  // "Attempted to access index 0 within vector of size 0"). The p50 of ts for tool_use events
  // in X is T (both are at T), in Y is T+50.
  it("(b) quantile_cont on ts proves DuckDB analytical SQL works", async () => {
    const sql = [
      "SELECT tool,",
      "       quantile_cont(CAST(ts AS DOUBLE), 0.5) p50_ts",
      "FROM events",
      "WHERE tool IS NOT NULL AND kind = 'tool_use'",
      "GROUP BY tool",
      "ORDER BY tool",
    ].join("\n");
    const result = await withDuck(tmpDb, (conn) => runQuery(conn, sql, EMPTY, 1000));
    expect(result.columns).toEqual(["tool", "p50_ts"]);
    const byTool = Object.fromEntries(result.rows.map((r) => [r[0] as string, Number(r[1])]));
    // Bash at T, Read at T -- both p50 = T (exactly one sample each).
    // Edit at T+50 -- p50 = T+50.
    expect(byTool["Bash"]).toBe(T);
    expect(byTool["Read"]).toBe(T);
    expect(byTool["Edit"]).toBe(T + 50);
    expect(result.truncated).toBe(false);
  });

  // (c) Facet scoping -- pass filter={project:'projX'} and assert only X tools counted.
  it("(c) facet scoping: filter={project:projX} sees only Bash+Read, not Edit", async () => {
    const filter: EventFilter = { project: PROJECT_X };
    const result = await withDuck(tmpDb, (conn) =>
      runQuery(
        conn,
        "SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool ORDER BY tool",
        filter,
        1000,
      ),
    );
    expect(result.columns).toEqual(["tool", "n"]);
    const byTool = Object.fromEntries(result.rows.map((r) => [r[0] as string, Number(r[1])]));
    // Edit is in projY -- must NOT appear.
    expect(byTool).toEqual({ Bash: 1, Read: 1 });
    expect(byTool["Edit"]).toBeUndefined();
  });

  // (d) cap+truncated -- SELECT * FROM events with cap=2 over a >2-row fixture.
  // Total events: 6 (4 in X + 2 in Y). cap=2 => rows.length=2 and truncated=true.
  it("(d) cap=2: returns 2 rows and truncated=true", async () => {
    const result = await withDuck(tmpDb, (conn) =>
      runQuery(conn, "SELECT * FROM events", EMPTY, 2),
    );
    expect(result.rows.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  // (e) Security: the engine sandbox (enable_external_access=false in withDuck)
  // blocks DuckDB's file-reader functions, which assertSelectOnly does NOT
  // keyword-block. Without the sandbox this would exfiltrate arbitrary files.
  it("(e) sandbox blocks read_text file access", async () => {
    await expect(
      withDuck(tmpDb, (conn) =>
        runQuery(conn, "SELECT content FROM read_text('/etc/hostname')", EMPTY, 10),
      ),
    ).rejects.toThrow(/disabled|Permission|external access/i);
  });

  // (f) A trailing ';' is tolerated by the guard; buildQuery must strip it so the
  // wrapped subquery is valid SQL (it would otherwise be a syntax error → 500).
  it("(f) trailing semicolon in user SQL still runs", async () => {
    const result = await withDuck(tmpDb, (conn) =>
      runQuery(
        conn,
        "SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool;",
        EMPTY,
        1000,
      ),
    );
    expect(result.columns).toEqual(["tool", "n"]);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

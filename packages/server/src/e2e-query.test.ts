/**
 * T-5.7 (a)+(b) e2e-query.test.ts — thorough correctness gate for POST /api/query.
 *
 * GROUND RULE #3: uses bun:sqlite (via createApp's Database) and spawns DuckDB as a
 * child process (the analytics CLI). Fixture DB is built by spawning the ingest CLI
 * in a separate process (D-3.b). Fixture lines end with \n (D-3.e).
 *
 * Fixture design (hand-computed; kept deterministic):
 *   Project "projA" (basename of cwd = /tmp/lllogs-e2e-q/<run>/projA):
 *     - 3 Bash tool_use  (bash-1, bash-2, bash-3)
 *     - 3 Bash tool_result  (bash-1: ok, bash-2: ok, bash-3: ERROR ← required error)
 *     - 1 Read tool_use   (read-1)
 *     - 1 Read tool_result  (read-1: ok)
 *   = 8 events
 *
 *   Project "projB" (cwd = /tmp/lllogs-e2e-q/<run>/projB):
 *     - 2 Edit tool_use  (edit-1, edit-2)
 *     - 2 Edit tool_result  (both ok)
 *   = 4 events
 *
 *   Total: 12 events | 6 tool_use | 6 tool_result | 1 error tool_result
 *
 * Hand-computed expected counts:
 *   SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool
 *   All corpus:           { Bash:3, Edit:2, Read:1 }
 *   filter={project:"projA"}: { Bash:3, Read:1 }    ← no Edit (projB-only)
 *   filter={project:"projB"}: { Edit:2 }              ← no Bash, no Read
 *   → filtered ≠ unfiltered proves SQL runs atop the faceted data, not the whole corpus.
 *
 * BIGINT/INTEGER cells come back as strings from DuckDB getRowsJson() (D-5.f).
 * Tests use Number() to normalize before asserting (same pattern as query.test.ts).
 * Tie-prone results compared order-insensitively via a { key→value } map (D-3.f).
 *
 * Cast `(await res.json()) as any` to satisfy TS18046 under strict mode.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ingestFixture, transcriptLine as line } from "@lllogs/shared/testing";
import { createApp } from "./app";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

// Fixed epoch for deterministic hand-computation (2023-11-14T22:13:20Z).
const T = 1700000000000;

// Project names are derived from basename(cwd) in the JSONL lines.
// The directory layout under the tree is arbitrary; what matters is cwd.
const SESSION_A = "sessaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "sessbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// Session A — project "projA": 3 Bash + 1 Read = 4 tool_use; 4 tool_result
//   bash-3 result is an ERROR (satisfies "at least one error tool_result")
// ---------------------------------------------------------------------------
function buildTranscriptA(cwdA: string): string {
  const lines = [
    // Bash #1
    line({
      uuid: "a-bash1-use",
      ts: T + 0,
      sessionId: SESSION_A,
      cwd: cwdA,
      content: [{ type: "tool_use", id: "ta-b1", name: "Bash", input: { command: "ls" } }],
    }),
    line({
      uuid: "a-bash1-res",
      ts: T + 100,
      role: "user",
      sessionId: SESSION_A,
      cwd: cwdA,
      content: [
        { type: "tool_result", tool_use_id: "ta-b1", content: "file1\nfile2", is_error: false },
      ],
      toolUseResult: { stdout: "file1\nfile2", stderr: "" },
    }),
    // Bash #2
    line({
      uuid: "a-bash2-use",
      ts: T + 200,
      sessionId: SESSION_A,
      cwd: cwdA,
      content: [{ type: "tool_use", id: "ta-b2", name: "Bash", input: { command: "pwd" } }],
    }),
    line({
      uuid: "a-bash2-res",
      ts: T + 300,
      role: "user",
      sessionId: SESSION_A,
      cwd: cwdA,
      content: [
        { type: "tool_result", tool_use_id: "ta-b2", content: "/home/user", is_error: false },
      ],
      toolUseResult: { stdout: "/home/user", stderr: "" },
    }),
    // Bash #3 — ERROR result (the required error event)
    line({
      uuid: "a-bash3-use",
      ts: T + 400,
      sessionId: SESSION_A,
      cwd: cwdA,
      content: [
        { type: "tool_use", id: "ta-b3", name: "Bash", input: { command: "cat /missing" } },
      ],
    }),
    line({
      uuid: "a-bash3-res",
      ts: T + 500,
      role: "user",
      sessionId: SESSION_A,
      cwd: cwdA,
      content: [
        { type: "tool_result", tool_use_id: "ta-b3", content: "No such file", is_error: true },
      ],
      toolUseResult: { stdout: "", stderr: "cat: /missing: No such file or directory" },
    }),
    // Read #1
    line({
      uuid: "a-read1-use",
      ts: T + 600,
      sessionId: SESSION_A,
      cwd: cwdA,
      content: [
        { type: "tool_use", id: "ta-r1", name: "Read", input: { file_path: "/tmp/readme.txt" } },
      ],
    }),
    line({
      uuid: "a-read1-res",
      ts: T + 700,
      role: "user",
      sessionId: SESSION_A,
      cwd: cwdA,
      content: [
        { type: "tool_result", tool_use_id: "ta-r1", content: "Hello world", is_error: false },
      ],
      toolUseResult: { stdout: "Hello world", stderr: "" },
    }),
  ];
  return lines.join("\n") + "\n"; // D-3.e: trailing newline
}

// ---------------------------------------------------------------------------
// Session B — project "projB": 2 Edit = 2 tool_use; 2 tool_result (both ok)
// ---------------------------------------------------------------------------
function buildTranscriptB(cwdB: string): string {
  const lines = [
    // Edit #1
    line({
      uuid: "b-edit1-use",
      ts: T + 1000,
      sessionId: SESSION_B,
      cwd: cwdB,
      content: [
        {
          type: "tool_use",
          id: "tb-e1",
          name: "Edit",
          input: { file_path: "/tmp/main.ts", old_string: "foo", new_string: "bar" },
        },
      ],
    }),
    line({
      uuid: "b-edit1-res",
      ts: T + 1100,
      role: "user",
      sessionId: SESSION_B,
      cwd: cwdB,
      content: [{ type: "tool_result", tool_use_id: "tb-e1", content: "saved", is_error: false }],
      toolUseResult: { stdout: "saved", stderr: "" },
    }),
    // Edit #2
    line({
      uuid: "b-edit2-use",
      ts: T + 1200,
      sessionId: SESSION_B,
      cwd: cwdB,
      content: [
        {
          type: "tool_use",
          id: "tb-e2",
          name: "Edit",
          input: { file_path: "/tmp/README.md", old_string: "teh", new_string: "the" },
        },
      ],
    }),
    line({
      uuid: "b-edit2-res",
      ts: T + 1300,
      role: "user",
      sessionId: SESSION_B,
      cwd: cwdB,
      content: [{ type: "tool_result", tool_use_id: "tb-e2", content: "ok", is_error: false }],
      toolUseResult: { stdout: "ok", stderr: "" },
    }),
  ];
  return lines.join("\n") + "\n"; // D-3.e: trailing newline
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------
let tmpDir: string;
let cwdA: string;
let cwdB: string;
let dbPath: string;
let db: Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lllogs-e2e-q-"));

  // Cwd paths: basename → project name in DB.
  cwdA = join(tmpDir, "projA");
  cwdB = join(tmpDir, "projB");
  mkdirSync(cwdA, { recursive: true });
  mkdirSync(cwdB, { recursive: true });

  // Place transcript files under the tree. The directory slug under tree is arbitrary;
  // the project name comes from basename(cwd) in each JSONL line.
  const tree = join(tmpDir, "tree");
  const slugA = join(tree, "slug-A");
  const slugB = join(tree, "slug-B");
  mkdirSync(slugA, { recursive: true });
  mkdirSync(slugB, { recursive: true });

  writeFileSync(join(slugA, `${SESSION_A}.jsonl`), buildTranscriptA(cwdA));
  writeFileSync(join(slugB, `${SESSION_B}.jsonl`), buildTranscriptB(cwdB));

  dbPath = join(tmpDir, "e2e-query-fixture.db");

  ingestFixture({ root: tree, db: dbPath });

  db = new Database(dbPath, { readonly: true });
  const webDir = resolve(import.meta.dir, "../../web");
  app = createApp({ db, webDir, dbPath, repoRoot: REPO_ROOT });
});

afterAll(() => {
  if (db) db.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** POST /api/query helper. */
async function postQuery(body: unknown): Promise<Response> {
  return app.request("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Map rows (tool, count) to { tool → number } for order-insensitive comparison (D-3.f). */
function toToolMap(rows: unknown[][]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r[0] as string, Number(r[1])]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("e2e POST /api/query", () => {
  // --------------------------------------------------------------------------
  // (a) Facet scoping — the headline: SQL runs atop the faceted CTE, not the
  //     whole corpus. Filtering to projA excludes projB data (Edit) and vice versa.
  // --------------------------------------------------------------------------
  describe("(a) facet scoping", () => {
    const sql = "SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool";

    it("no filter → full corpus {Bash:3, Edit:2, Read:1}", async () => {
      const res = await postQuery({ sql });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.columns).toEqual(["tool", "n"]);
      expect(body.truncated).toBe(false);
      // Hand-computed: projA (Bash:3, Read:1) + projB (Edit:2) = all three tools
      const counts = toToolMap(body.rows);
      expect(counts).toEqual({ Bash: 3, Edit: 2, Read: 1 });
    });

    it("filter{project:'projA'} → {Bash:3, Read:1} — Edit absent (projB-only)", async () => {
      const res = await postQuery({ sql, filter: { project: "projA" } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const counts = toToolMap(body.rows);
      // projA has Bash×3 and Read×1; Edit lives exclusively in projB → absent here.
      expect(counts).toEqual({ Bash: 3, Read: 1 });
      expect(counts["Edit"]).toBeUndefined();
    });

    it("filter{project:'projB'} → {Edit:2} — Bash and Read absent (projA-only)", async () => {
      const res = await postQuery({ sql, filter: { project: "projB" } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const counts = toToolMap(body.rows);
      // projB has only Edit×2; Bash and Read live exclusively in projA.
      expect(counts).toEqual({ Edit: 2 });
      expect(counts["Bash"]).toBeUndefined();
      expect(counts["Read"]).toBeUndefined();
    });

    it("filtered counts differ from unfiltered → proves SQL is atop faceted data", async () => {
      const [resAll, resA] = await Promise.all([
        postQuery({ sql }),
        postQuery({ sql, filter: { project: "projA" } }),
      ]);
      expect(resAll.status).toBe(200);
      expect(resA.status).toBe(200);
      const all = toToolMap(((await resAll.json()) as any).rows);
      const projA = toToolMap(((await resA.json()) as any).rows);
      // Number of unique tools differs (3 vs 2) — fundamentally different results.
      expect(Object.keys(all).length).not.toBe(Object.keys(projA).length);
      // Bash count is the same, but Edit count differs (2 vs absent).
      expect(all["Edit"]).toBe(2);
      expect(projA["Edit"]).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // (b.1) Window / aggregate query — proves DuckDB analytical SQL works over the CTE.
  //       D-5.g: NO self-join of the `events` CTE; use a single-scan aggregate.
  //       D-5.f: dur_ms is NULL in the DB; use `ts` for a real quantile.
  //       Don't assert a real quantile value — assert columns shape + it runs.
  // --------------------------------------------------------------------------
  describe("(b.1) DuckDB analytical SQL (quantile_cont over single scan)", () => {
    it("quantile_cont(ts, 0.5) returns correct columns and non-empty rows", async () => {
      const sql =
        "SELECT kind, COUNT(*) n, quantile_cont(ts, 0.5) ts_p50 " +
        "FROM events GROUP BY kind ORDER BY kind";
      const res = await postQuery({ sql });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Column shape is the contract — the exact quantile value is not asserted.
      expect(body.columns).toEqual(["kind", "n", "ts_p50"]);
      // Fixture has 2 kinds (tool_use, tool_result); rows must be non-empty.
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.rows.length).toBeGreaterThan(0);
      expect(body.truncated).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // (b.2) Guard → 400 (assertSelectOnly fires before spawning DuckDB).
  //        All three vectors: COPY (file-write), DROP, multi-statement (incl.
  //        comment-smuggled `;`).
  // --------------------------------------------------------------------------
  describe("(b.2) SQL guard rejections → 400", () => {
    it("COPY … TO (DuckDB file-write vector) → 400 naming 'COPY'", async () => {
      const res = await postQuery({ sql: "COPY events TO '/tmp/leak.csv'" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(typeof body.error).toBe("string");
      expect(body.error).toMatch(/copy/i);
    });

    it("DROP TABLE event → 400 naming 'DROP'", async () => {
      const res = await postQuery({ sql: "DROP TABLE event" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(typeof body.error).toBe("string");
      expect(body.error).toMatch(/drop/i);
    });

    it("multi-statement SELECT; DELETE → 400", async () => {
      const res = await postQuery({ sql: "SELECT 1; DELETE FROM event" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(typeof body.error).toBe("string");
    });

    it("comment-smuggled multi-statement SELECT 1 /* */; DROP TABLE event → 400", async () => {
      // The strip-comments pass removes the block comment; the `;` then signals
      // a multi-statement, which assertSelectOnly rejects.
      const res = await postQuery({
        sql: "SELECT 1 /* */; DROP TABLE event",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(typeof body.error).toBe("string");
    });
  });

  // --------------------------------------------------------------------------
  // (c) Cap + truncated.
  //     Total events = 12; limit:3 → 3 rows + truncated:true.
  // --------------------------------------------------------------------------
  describe("(c) cap + truncated", () => {
    it("limit:3 over 12-event corpus returns 3 rows and truncated:true", async () => {
      const res = await postQuery({ sql: "SELECT * FROM events", limit: 3 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.rows.length).toBe(3);
      expect(body.truncated).toBe(true);
    });

    it("limit:1000 over 12-event corpus returns 12 rows and truncated:false", async () => {
      const res = await postQuery({ sql: "SELECT * FROM events", limit: 1000 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.rows.length).toBe(12);
      expect(body.truncated).toBe(false);
    });
  });
});

/**
 * T-5.4 query.test.ts — tests for POST /api/query proxy.
 *
 * GROUND RULE #3: this file uses bun:sqlite (via createApp's Database) and spawns
 * DuckDB as a child process (the analytics CLI). The fixture DB is built by spawning
 * the ingest CLI in a separate child process (D-3.b). Fixture lines end with \n (D-3.e).
 *
 * Two projects so facet scoping is testable (D-3.f).
 *
 * Timeout → 504: mechanism-identical to /api/stats (kill-deadline Promise.race).
 * A deliberate timeout test was omitted: a DuckDB CTE self-join crashes rather than
 * times out (D-5.g), and other heavy synthetic queries are not reliably slow enough
 * within a fixed bound. Verified by code inspection of the same pattern in stats.test.ts.
 *
 * BIGINT/INTEGER values come back as strings from DuckDB's getRowsJson() (D-5.f).
 * Tests use Number() to normalize before asserting.
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

// Fixed epoch for deterministic hand-computation.
const T = 1700000000000; // 2023-11-14T22:13:20Z

// Two projects so facet scoping is testable.
const SESSION_X = "sess-xxxx";
const CWD_X = `/tmp/lllogs-srv-q-test/projX`;

const SESSION_Y = "sess-yyyy";
const CWD_Y = `/tmp/lllogs-srv-q-test/projY`;

// Fixture:
//   Project X (projX): 2 tool_use (Bash, Read) + 2 tool_result = 4 events
//   Project Y (projY): 1 tool_use (Edit)        + 1 tool_result = 2 events
//   Total: 6 events, 3 tool_use
//
// Hand-computed results:
//   SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool
//   All: { Bash:1, Read:1, Edit:1 }
//   project=projX: { Bash:1, Read:1 }   (Edit is in projY — must not appear)
//
//   SELECT * FROM events with limit:2 → 2 rows + truncated:true

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
    ts: T + 100,
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
    ts: T + 300,
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
    ts: T + 400,
    role: "user",
    sessionId: SESSION_Y,
    cwd: CWD_Y,
    content: [{ type: "tool_result", tool_use_id: "ty1", content: "saved", is_error: false }],
    toolUseResult: { stdout: "saved", stderr: "" },
  }),
].join("\n");

let tmpDir: string;
let dbPath: string;
let db: Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lllogs-query-server-"));
  const tree = join(tmpDir, "tree");
  // Project name = basename(cwd in the JSONL line) — the directory layout under
  // tree is arbitrary; what matters is the sessionId.jsonl filename + cwd in each line.
  const xDir = join(tree, "projX-slug");
  const yDir = join(tree, "projY-slug");
  mkdirSync(xDir, { recursive: true });
  mkdirSync(yDir, { recursive: true });
  // D-3.e: trailing \n — the tailer withholds a final line without a newline.
  writeFileSync(join(xDir, `${SESSION_X}.jsonl`), `${TRANSCRIPT_X}\n`);
  writeFileSync(join(yDir, `${SESSION_Y}.jsonl`), `${TRANSCRIPT_Y}\n`);
  dbPath = join(tmpDir, "fixture.db");

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

describe("POST /api/query", () => {
  // (1) Valid SELECT GROUP BY → 200 with columns/rows matching a direct CLI spawn.
  it("(1) valid SELECT GROUP BY → 200, matches direct analytics CLI spawn", async () => {
    const sql = "SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool";
    const res = await postQuery({ sql });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.columns).toEqual(["tool", "n"]);
    expect(body.truncated).toBe(false);

    // Compare against a direct CLI spawn (order-insensitive — D-3.f).
    const direct = Bun.spawnSync(
      [
        "bun",
        "run",
        "analytics",
        "--",
        "--db",
        dbPath,
        "--query",
        "--sql",
        sql,
        "--filters",
        "{}",
        "--limit",
        "1000",
      ],
      { cwd: REPO_ROOT },
    );
    expect(direct.exitCode).toBe(0);
    const directBody = JSON.parse(direct.stdout.toString()) as any;

    expect(body.columns).toEqual(directBody.columns);
    // INTEGER/BIGINT counts come back as strings (D-5.f) — Number()-normalize.
    expect(toToolMap(body.rows)).toEqual(toToolMap(directBody.rows));
    // Sanity: all three tools are present with count 1.
    expect(toToolMap(body.rows)).toEqual({ Bash: 1, Read: 1, Edit: 1 });
  });

  // (2) Facet scoping — filter{project:projX} limits the CTE to projX events.
  it("(2) facet scoping: filter{project:projX} excludes projY (Edit not in result)", async () => {
    const sql = "SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool";

    const resX = await postQuery({ sql, filter: { project: "projX" } });
    expect(resX.status).toBe(200);
    const bodyX = (await resX.json()) as any;
    const countsX = toToolMap(bodyX.rows);
    // projX has Bash + Read; Edit lives in projY.
    expect(countsX).toEqual({ Bash: 1, Read: 1 });
    expect(countsX["Edit"]).toBeUndefined();

    // Confirm the whole corpus (no filter) gives a different result — proves scoping.
    const resAll = await postQuery({ sql });
    expect(resAll.status).toBe(200);
    const bodyAll = (await resAll.json()) as any;
    expect(toToolMap(bodyAll.rows)).toEqual({ Bash: 1, Read: 1, Edit: 1 });
  });

  // (3) Guard rejections → 400 (assertSelectOnly fires before spawning).
  it("(3a) DROP TABLE → 400 with error message naming the violation", async () => {
    const res = await postQuery({ sql: "DROP TABLE event" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(typeof body.error).toBe("string");
    expect(body.error).toMatch(/drop/i);
  });

  it("(3b) multi-statement (SELECT; DELETE) → 400", async () => {
    const res = await postQuery({ sql: "SELECT 1; DELETE FROM event" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(typeof body.error).toBe("string");
  });

  it("(3c) COPY … TO → 400 (DuckDB file-write vector)", async () => {
    const res = await postQuery({ sql: "COPY events TO '/tmp/leak.csv'" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(typeof body.error).toBe("string");
    expect(body.error).toMatch(/copy/i);
  });

  // (4) Cap respected + truncated surfaced.
  // Total events = 6; limit:2 → 2 rows + truncated:true.
  it("(4) limit:2 returns 2 rows and truncated:true over the 6-event corpus", async () => {
    const res = await postQuery({ sql: "SELECT * FROM events", limit: 2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBe(2);
    expect(body.truncated).toBe(true);
  });
});

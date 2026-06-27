import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ingestFixture, transcriptLine } from "@clogdy/shared/testing";
import { createApp } from "./app";

// GROUND RULE #3: this test process links SQLite ONLY via the server's bun:sqlite
// (createApp's read-only Database). DuckDB is never imported here — it runs solely
// as the CHILD process /api/stats spawns (the analytics CLI). We do NOT import
// @duckdb/node-api or @clogdy/analytics. The fixture DB is built by SPAWNING the
// ingest CLI in a SEPARATE process (D-3.b), so even the fixture build never
// double-links SQLite in this process.

const REPO_ROOT = resolve(import.meta.dir, "../../..");

// A fixed hour-aligned base epoch so timeBuckets is hand-computable.
const T = 1700000000000; // 2023-11-14T22:13:20Z
const HOUR = 3600000;
const BUCKET = Math.floor(T / HOUR) * HOUR; // the single hour bucket all events fall in

const PROJECT = "myproj";
const CWD = `/tmp/x/${PROJECT}`;
const SESSION = "sess-aaaa";

/** Build one JSONL transcript line in the real transcript shape (binds this suite's SESSION/CWD). */
const line = (o: {
  uuid: string;
  ts: number;
  content: unknown[];
  toolUseResult?: unknown;
  role?: string;
}): string => transcriptLine({ ...o, sessionId: SESSION, cwd: CWD });

// ── Fixture: every metric below is hand-computed from these 6 single-block lines. ──
// All lines share project=myproj, session=sess-aaaa, and ts within [T, T+1000] so
// they floor to ONE hour bucket. Each line emits exactly one FlatEvent (one content
// block), so #events = #lines = 6.
//
//   uuid  ts        kind         tool  corr  is_error
//   u1    T         tool_use     Bash  b1    null
//   u2    T+1000    tool_result  —     b1    false   (Bash pair, gap = 1000 ms)
//   u3    T+10      tool_use     Bash  b2    null    (no matching result → not in latency)
//   u4    T+20      tool_use     Read  r1    null
//   u5    T+30      tool_result  —     r1    true    (Read pair, gap = 10 ms; is_error)
//   u6    T+40      tool_result  —     zzz   false   (orphan result, no tool_use)
//
// HAND-COMPUTED EXPECTATIONS:
//   toolCounts  (tool IS NOT NULL, i.e. tool_use rows): Bash x2 (u1,u3), Read x1 (u4)
//               → [{tool:"Bash",count:2},{tool:"Read",count:1}]   (distinct counts ⇒ order is deterministic)
//   errorRate   (over kind='tool_result' rows u2,u5,u6): total=3, errors=1 (u5), rate=1/3
//   latency     (self-join on corr, u.kind=tool_use ∧ r.kind=tool_result):
//               pairs = b1 (u1→u2, gap 1000), r1 (u4→u5, gap 10). b2 has no result.
//               → Bash: n=1, p50=1000, p95=1000 (single point);  Read: n=1, p50=10
//   timeBuckets (hour-floored): all 6 events in one bucket → [{bucket:BUCKET, count:6}]
//   projectRollup: events=6, tool_calls=count(kind='tool_use')=3, errors=SUM(is_error)=1
//               → [{project:"myproj", events:6, tool_calls:3, errors:1}]
const TRANSCRIPT = [
  line({
    uuid: "u1",
    ts: T,
    content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }],
  }),
  line({
    uuid: "u2",
    ts: T + 1000, // Bash result 1000 ms after its tool_use → p50 = 1000 exactly
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "b1", content: "ok output", is_error: false }],
    toolUseResult: { stdout: "ok output", stderr: "" },
  }),
  line({
    uuid: "u3",
    ts: T + 10,
    content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "pwd" } }],
  }),
  line({
    uuid: "u4",
    ts: T + 20,
    content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/x" } }],
  }),
  line({
    uuid: "u5",
    ts: T + 30,
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "r1", content: "boom", is_error: true }],
    toolUseResult: { stdout: "", stderr: "boom" },
  }),
  line({
    uuid: "u6",
    ts: T + 40,
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "zzz", content: "orphan", is_error: false }],
    toolUseResult: { stdout: "orphan", stderr: "" },
  }),
].join("\n");

let tmpDir: string;
let dbPath: string;
let db: Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "clogdy-e2e-stats-"));
  const tree = join(tmpDir, "tree");
  const projDir = join(tree, "project-slug");
  mkdirSync(projDir, { recursive: true });
  // D-3.e: trailing newline is REQUIRED — the offset-tailer buffers an
  // unterminated final line as a remainder and never delivers it during
  // backfill, so `lines.join("\n")` alone would silently drop u6.
  writeFileSync(join(projDir, `${SESSION}.jsonl`), `${TRANSCRIPT}\n`);
  dbPath = join(tmpDir, "fixture.db");

  // D-3.b: build the fixture DB by SPAWNING the ingest CLI in a SEPARATE process.
  ingestFixture({ root: tree, db: dbPath });

  db = new Database(dbPath, { readonly: true });
  const webDir = resolve(import.meta.dir, "../../web");
  app = createApp({ db, webDir, dbPath, repoRoot: REPO_ROOT });
});

afterAll(() => {
  if (db) db.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** Map a toolCounts array to a {tool→count} object so tie order can't flake (D-3.f). */
const byTool = (data: Array<{ tool: string; count: number }>) =>
  Object.fromEntries(data.map((r) => [r.tool, r.count]));

describe("e2e /api/stats correctness vs hand-computed fixture", () => {
  it("toolCounts: Bash×2, Read×1 (distinct counts, deterministic order)", async () => {
    const res = await app.request("/api/stats?metric=toolCounts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.metric).toBe("toolCounts");
    // Distinct counts ⇒ ORDER BY count DESC is fully determined; assert the exact array.
    expect(body.data).toEqual([
      { tool: "Bash", count: 2 },
      { tool: "Read", count: 1 },
    ]);
    // …and order-insensitively too (D-3.f belt-and-suspenders).
    expect(byTool(body.data)).toEqual({ Bash: 2, Read: 1 });
  });

  it("errorRate: total=3, errors=1, rate=1/3", async () => {
    const res = await app.request("/api/stats?metric=errorRate");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.metric).toBe("errorRate");
    expect(body.data.total).toBe(3);
    expect(body.data.errors).toBe(1);
    // rate is the repeating fraction 1/3 — compare with tolerance.
    expect(body.data.rate).toBeCloseTo(1 / 3, 10);
  });

  it("latency: Bash p50=1000, p95=1000, n=1 (the KNOWN 1000 ms ts gap)", async () => {
    const res = await app.request("/api/stats?metric=latency");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.metric).toBe("latency");
    const data = body.data as Array<{ tool: string; p50: number; p95: number; n: number }>;
    // Single Bash pair (u1→u2) with a hand-known 1000 ms gap → exact p50/p95.
    const bash = data.find((d) => d.tool === "Bash");
    expect(bash).toBeDefined();
    expect(bash!.p50).toBe(1000);
    expect(bash!.p95).toBe(1000);
    expect(bash!.n).toBe(1);
    // Read pair (u4→u5) exists too (gap 10 ms, single point).
    const read = data.find((d) => d.tool === "Read");
    expect(read).toBeDefined();
    expect(read!.n).toBe(1);
    expect(read!.p50).toBe(10);
  });

  it("timeBuckets: all 6 events in one hour bucket", async () => {
    const res = await app.request("/api/stats?metric=timeBuckets");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.metric).toBe("timeBuckets");
    expect(body.data).toEqual([{ bucket: BUCKET, count: 6 }]);
  });

  it("projectRollup: myproj events=6, tool_calls=3, errors=1", async () => {
    const res = await app.request("/api/stats?metric=projectRollup");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.metric).toBe("projectRollup");
    // Single project ⇒ single row; assert exactly.
    expect(body.data).toEqual([{ project: PROJECT, events: 6, tool_calls: 3, errors: 1 }]);
  });

  it("filter flows server→CLI→DuckDB: project=myproj unchanged, project=other empty", async () => {
    // Single-project fixture: filtering to myproj must equal the unfiltered result.
    const filtered = await app.request(`/api/stats?metric=toolCounts&project=${PROJECT}`);
    expect(filtered.status).toBe(200);
    const fBody = (await filtered.json()) as any;
    expect(fBody.metric).toBe("toolCounts");
    expect(byTool(fBody.data)).toEqual({ Bash: 2, Read: 1 });

    // A non-existent project must come back empty — proving the filter param
    // actually reached the DuckDB query (not ignored end-to-end).
    const none = await app.request("/api/stats?metric=toolCounts&project=other");
    expect(none.status).toBe(200);
    const nBody = (await none.json()) as any;
    expect(nBody.metric).toBe("toolCounts");
    expect(nBody.data).toEqual([]);
  });
});

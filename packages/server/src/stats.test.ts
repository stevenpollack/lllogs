import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ingestFixture, transcriptLine } from "@lllogs/shared/testing";
import { createApp } from "./app";

// GROUND RULE #3: this test process uses bun:sqlite (via createApp's Database)
// and spawns DuckDB as a CHILD (the analytics CLI) — never linking DuckDB in
// process. The fixture DB is built by SPAWNING the ingest CLI (D-3.b), then the
// app spawns the analytics CLI to compute metrics.

const REPO_ROOT = resolve(import.meta.dir, "../../..");

const T = 1700000000000; // 2023-11-14T22:13:20Z
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

// Hand-computable values:
//   tool_use: Bash (t1), Read (t2)        → toolCounts {Bash:1, Read:1}
//   tool_result t1 ok, t2 error           → errorRate {total:2, errors:1, rate:0.5}
const TRANSCRIPT = [
  line({
    uuid: "u1",
    ts: T,
    content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
  }),
  line({
    uuid: "u2",
    ts: T,
    content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x" } }],
  }),
  line({
    uuid: "u3",
    ts: T + 1500,
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "ok output", is_error: false }],
    toolUseResult: { stdout: "ok output", stderr: "" },
  }),
  line({
    uuid: "u4",
    ts: T + 500,
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true }],
    toolUseResult: { stdout: "", stderr: "boom" },
  }),
].join("\n");

let tmpDir: string;
let dbPath: string;
let db: Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lllogs-stats-"));
  const tree = join(tmpDir, "tree");
  const projDir = join(tree, "project-slug");
  mkdirSync(projDir, { recursive: true });
  // D-3.e: trailing newline — the tailer withholds an unterminated final line.
  writeFileSync(join(projDir, `${SESSION}.jsonl`), `${TRANSCRIPT}\n`);
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

describe("/api/stats proxy → analytics CLI", () => {
  it("toolCounts: 200 and matches a direct CLI spawn", async () => {
    const res = await app.request("/api/stats?metric=toolCounts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.metric).toBe("toolCounts");

    const spawned = Bun.spawnSync(
      [
        "bun",
        "run",
        "analytics",
        "--",
        "--db",
        dbPath,
        "--metric",
        "toolCounts",
        "--filters",
        "{}",
      ],
      { cwd: REPO_ROOT },
    );
    expect(spawned.exitCode).toBe(0);
    // toolCounts ORDER BY count DESC leaves equal-count tools in arbitrary order,
    // so the app spawn and the direct spawn may disagree on tie order. Compare
    // order-insensitively: same metric + same {tool→count} mapping.
    const direct = JSON.parse(spawned.stdout.toString()) as any;
    expect(body.metric).toBe(direct.metric);
    const asMap = (d: any) =>
      Object.fromEntries(
        (d.data as Array<{ tool: string; count: number }>).map((r) => [r.tool, r.count]),
      );
    expect(asMap(body)).toEqual(asMap(direct));
  });

  it("unknown metric → 400", async () => {
    const res = await app.request("/api/stats?metric=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("bad metric");
  });

  it("missing metric → 400", async () => {
    const res = await app.request("/api/stats");
    expect(res.status).toBe(400);
  });

  it("toolCounts with project filter: 200, filtered data", async () => {
    const res = await app.request(`/api/stats?metric=toolCounts&project=${PROJECT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.metric).toBe("toolCounts");
    const byTool = Object.fromEntries(body.data.map((d: any) => [d.tool, d.count]));
    expect(byTool).toEqual({ Bash: 1, Read: 1 });

    const none = await app.request("/api/stats?metric=toolCounts&project=other");
    expect(none.status).toBe(200);
    const noneBody = (await none.json()) as any;
    expect(noneBody.data).toEqual([]);
  });

  it("errorRate: 200 with hand-computed {total,errors,rate}", async () => {
    const res = await app.request("/api/stats?metric=errorRate");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.metric).toBe("errorRate");
    expect(body.data).toEqual({ total: 2, errors: 1, rate: 0.5 });
  });
});

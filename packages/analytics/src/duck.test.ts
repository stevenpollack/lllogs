import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventFilter } from "@lllogs/shared";
import { ingestFixture, transcriptLine } from "@lllogs/shared/testing";
import {
  buildWhere,
  errorRate,
  latency,
  projectRollup,
  timeBuckets,
  toolCounts,
  withDuck,
} from "./duck";

describe("buildWhere multi-value (pure — no DuckDB)", () => {
  it("uses = for one value and IN for many; maps error → is_error", () => {
    const one = buildWhere({ kind: "tool_use" });
    expect(one.sql).toContain("kind = $1");
    expect(one.params).toEqual(["tool_use"]);

    const many = buildWhere({ kind: ["tool_use", "tool_result"], project: "alpha" });
    expect(many.sql).toMatch(/kind IN \(\$\d, \$\d\)/);
    // project is bound before kind (buildWhere's column order)
    expect(many.params).toEqual(["alpha", "tool_use", "tool_result"]);

    const err = buildWhere({ error: ["error", "ok"] });
    expect(err.sql).toMatch(/is_error IN \(\$\d, \$\d\)/);
    expect(err.params).toEqual([1, 0]);

    const role = buildWhere({ role: "user" });
    expect(role.sql).toContain("role = $1");
    expect(role.params).toEqual(["user"]);
  });
});

// GROUND RULE #3: this file loads DuckDB. It MUST NOT import bun:sqlite or
// @lllogs/ingest (double-linking SQLite in one process is forbidden). The
// fixture DB is built by SPAWNING the ingest CLI in a separate child process
// (D-3.b), then DuckDB opens it READ_ONLY here — the only in-process SQLite
// link is DuckDB's.

// A fixed hour-aligned epoch so timeBuckets is hand-computable.
const T = 1700000000000; // 2023-11-14T22:13:20Z
const HOUR = 3600000;

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

// Fixture transcript. Hand-computable values:
//   tool_use blocks: Bash (t1), Read (t2)  → toolCounts: {Bash:1, Read:1}
//   tool_result for t1 (Bash) at T+1500, ok      → pairs → Bash latency p50=1500, n=1
//   tool_result for t2 (Read) at T+500,  error   → pairs → Read latency p50=500,  n=1
//   errorRate over kind='tool_result': total=2, errors=1, rate=0.5
//   projectRollup(myproj): events=4, tool_calls=2, errors=1
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
let tmpDb: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lllogs-duck-"));
  const tree = join(tmpDir, "tree");
  const projDir = join(tree, "project-slug");
  mkdirSync(projDir, { recursive: true });
  // Trailing newline: the tailer only emits lines up to the last "\n" (a final
  // unterminated line is buffered as a remainder and never delivered). Real
  // transcripts end with "\n".
  writeFileSync(join(projDir, `${SESSION}.jsonl`), `${TRANSCRIPT}\n`);
  tmpDb = join(tmpDir, "fixture.db");

  ingestFixture({ root: tree, db: tmpDb });
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

const EMPTY: EventFilter = {};

describe("withDuck READ_ONLY ATTACH over spawned-ingest DB", () => {
  it("toolCounts: Bash & Read each once, ordered by count desc", async () => {
    const data = await withDuck(tmpDb, (c) => toolCounts(c, EMPTY));
    // both have count 1; just assert the set.
    const byTool = Object.fromEntries(data.map((d) => [d.tool, d.count]));
    expect(byTool).toEqual({ Bash: 1, Read: 1 });
  });

  it("errorRate over tool_result: total=2, errors=1, rate=0.5", async () => {
    const data = await withDuck(tmpDb, (c) => errorRate(c, EMPTY));
    expect(data).toEqual({ total: 2, errors: 1, rate: 0.5 });
  });

  it("projectRollup(myproj): events=4, tool_calls=2, errors=1", async () => {
    const data = await withDuck(tmpDb, (c) => projectRollup(c, EMPTY));
    expect(data).toEqual([{ project: PROJECT, events: 4, tool_calls: 2, errors: 1 }]);
  });

  it("latency: Bash p50=1500 n=1 (the known ts gap)", async () => {
    const data = await withDuck(tmpDb, (c) => latency(c, EMPTY));
    const bash = data.find((d) => d.tool === "Bash");
    expect(bash).toBeDefined();
    expect(bash!.p50).toBe(1500);
    expect(bash!.p95).toBe(1500);
    expect(bash!.n).toBe(1);
    const read = data.find((d) => d.tool === "Read");
    expect(read!.p50).toBe(500);
    expect(read!.n).toBe(1);
  });

  it("timeBuckets: all 4 events floor to the same hour bucket", async () => {
    const data = await withDuck(tmpDb, (c) => timeBuckets(c, EMPTY));
    // T, T+500, T+1500 all floor to the same hour bucket → one bucket, 4 events.
    const bucket = Math.floor(T / HOUR) * HOUR;
    expect(data).toEqual([{ bucket, count: 4 }]);
  });

  it("filter is applied: project=myproj keeps all; project=other → empty", async () => {
    const all = await withDuck(tmpDb, (c) => toolCounts(c, { project: PROJECT }));
    expect(all.length).toBe(2);
    const none = await withDuck(tmpDb, (c) => toolCounts(c, { project: "other" }));
    expect(none).toEqual([]);
  });

  it("latency drops a kind filter (D-3.c) — still returns the pairs", async () => {
    const data = await withDuck(tmpDb, (c) => latency(c, { kind: "tool_use" }));
    expect(data.find((d) => d.tool === "Bash")!.n).toBe(1);
  });
});

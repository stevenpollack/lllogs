import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { runIngest } from "./ingest";

let dir: string;
let root: string;
let dbPath: string;

const SID1 = "11111111-1111-1111-1111-111111111111";
const SID2 = "22222222-2222-2222-2222-222222222222";

function line(o: unknown): string {
  return JSON.stringify(o);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lllogs-ingest-"));
  root = join(dir, "projects");
  dbPath = join(dir, "db", "c.db");

  // Session 1: project "alpha" — prompt, assistant tool_use(Bash), tool_result, a non-message line.
  const p1 = join(root, "alpha-slug");
  mkdirSync(p1, { recursive: true });
  writeFileSync(
    join(p1, `${SID1}.jsonl`),
    [
      line({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: SID1,
        cwd: "/home/x/alpha",
        timestamp: "2024-01-01T00:00:00.000Z",
        message: { role: "user", content: "do a thing" },
      }),
      line({
        type: "assistant",
        uuid: "u2",
        parentUuid: "u1",
        sessionId: SID1,
        cwd: "/home/x/alpha",
        timestamp: "2024-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls -la" } }],
        },
      }),
      line({
        type: "user",
        uuid: "u3",
        parentUuid: "u2",
        sessionId: SID1,
        cwd: "/home/x/alpha",
        timestamp: "2024-01-01T00:00:02.000Z",
        toolUseResult: { stdout: "file1\nfile2", stderr: "" },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              is_error: false,
              content: "file1\nfile2",
            },
          ],
        },
      }),
      // a non-message line (snapshot / mode change) — must be dropped
      line({
        type: "summary",
        uuid: "u4",
        sessionId: SID1,
        cwd: "/home/x/alpha",
        timestamp: "2024-01-01T00:00:03.000Z",
        summary: "x",
      }),
    ].join("\n") + "\n",
  );

  // Session 2: project "beta" — assistant text, tool_use(Bash) error pair.
  const p2 = join(root, "beta-slug");
  mkdirSync(p2, { recursive: true });
  writeFileSync(
    join(p2, `${SID2}.jsonl`),
    [
      line({
        type: "assistant",
        uuid: "v1",
        parentUuid: null,
        sessionId: SID2,
        cwd: "/home/y/beta",
        timestamp: "2024-01-02T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "thinking out loud" }] },
      }),
      line({
        type: "assistant",
        uuid: "v2",
        parentUuid: "v1",
        sessionId: SID2,
        cwd: "/home/y/beta",
        timestamp: "2024-01-02T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_2", name: "Bash", input: { command: "false" } }],
        },
      }),
      line({
        type: "user",
        uuid: "v3",
        parentUuid: "v2",
        sessionId: SID2,
        cwd: "/home/y/beta",
        timestamp: "2024-01-02T00:00:02.000Z",
        toolUseResult: { stdout: "", stderr: "boom" },
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool_2", is_error: true, content: "exit 1" },
          ],
        },
      }),
    ].join("\n") + "\n",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Expected emitted blocks:
//  S1: prompt(u1), tool_use(u2), tool_result(u3) = 3 ; summary(u4) dropped
//  S2: text(v1), tool_use(v2), tool_result(v3) = 3
// total = 6
const EXPECTED_EVENTS = 6;

test("backfill ingests the expected event count, idempotently, with session rows", async () => {
  const db = openDb(dbPath);
  await runIngest({ mode: "backfill", root, db });

  const count = (db.query("SELECT COUNT(*) c FROM event").get() as { c: number }).c;
  expect(count).toBe(EXPECTED_EVENTS);

  // tool_use row mapping (role carried from the assistant message envelope)
  const tu = db
    .query("SELECT tool, command, corr, kind, role FROM event WHERE uuid='u2'")
    .get() as any;
  expect(tu).toEqual({
    tool: "Bash",
    command: "ls -la",
    corr: "tool_1",
    kind: "tool_use",
    role: "assistant",
  });

  // tool_result shares corr (role carried from the user message envelope)
  const tr = db.query("SELECT corr, kind, is_error, role FROM event WHERE uuid='u3'").get() as any;
  expect(tr.corr).toBe("tool_1");
  expect(tr.kind).toBe("tool_result");
  expect(tr.is_error).toBe(0);
  expect(tr.role).toBe("user");

  // sessions
  const sessRows = db
    .query("SELECT session_id, project FROM session ORDER BY project")
    .all() as any[];
  expect(sessRows.length).toBe(2);
  expect(sessRows.map((r) => r.project)).toEqual(["alpha", "beta"]);

  // idempotency: second pass inserts nothing new
  let inserted2 = -1;
  await runIngest({ mode: "backfill", root, db, onProgress: (n) => (inserted2 = n) });
  expect(inserted2).toBe(0);
  const count2 = (db.query("SELECT COUNT(*) c FROM event").get() as { c: number }).c;
  expect(count2).toBe(EXPECTED_EVENTS);

  db.close();
});

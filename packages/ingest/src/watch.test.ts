import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { runIngest } from "./ingest";

let dir: string;
let root: string;
let dbPath: string;

const SID_W1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID_W2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function line(o: unknown): string {
  return JSON.stringify(o) + "\n";
}

// Realistic transcript lines matching the format from ingest.test.ts
function promptLine(uuid: string, sid: string, cwd: string, ts: string, text: string): string {
  return line({
    type: "user",
    uuid,
    parentUuid: null,
    sessionId: sid,
    cwd,
    timestamp: ts,
    message: { role: "user", content: text },
  });
}

function toolUseLine(
  uuid: string,
  parentUuid: string,
  sid: string,
  cwd: string,
  ts: string,
  toolId: string,
  name: string,
  cmd: string,
): string {
  return line({
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: sid,
    cwd,
    timestamp: ts,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolId, name, input: { command: cmd } }],
    },
  });
}

function toolResultLine(
  uuid: string,
  parentUuid: string,
  sid: string,
  cwd: string,
  ts: string,
  toolId: string,
  stdout: string,
): string {
  return line({
    type: "user",
    uuid,
    parentUuid,
    sessionId: sid,
    cwd,
    timestamp: ts,
    toolUseResult: { stdout, stderr: "" },
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolId, is_error: false, content: stdout }],
    },
  });
}

function textLine(
  uuid: string,
  parentUuid: string,
  sid: string,
  cwd: string,
  ts: string,
  text: string,
): string {
  return line({
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: sid,
    cwd,
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

// Poll the DB until COUNT(*) FROM event reaches `expected`, up to ~2s.
// Returns final count.
async function pollUntilCount(db: ReturnType<typeof openDb>, expected: number): Promise<number> {
  const steps = 40; // 40 × 50ms = 2s
  for (let i = 0; i < steps; i++) {
    const { c } = db.query("SELECT COUNT(*) c FROM event").get() as { c: number };
    if (c >= expected) return c;
    await Bun.sleep(50);
  }
  return (db.query("SELECT COUNT(*) c FROM event").get() as { c: number }).c;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lllogs-watch-"));
  root = join(dir, "projects");
  dbPath = join(dir, "db", "w.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("watch: catch-up, live append, new file, idempotent restart", async () => {
  // Set up initial session file: 3 events (prompt, tool_use, tool_result)
  const proj1Dir = join(root, "watch-proj-slug");
  mkdirSync(proj1Dir, { recursive: true });
  const sessionFile1 = join(proj1Dir, `${SID_W1}.jsonl`);
  writeFileSync(
    sessionFile1,
    promptLine("w1", SID_W1, "/home/x/watch-proj", "2025-01-01T00:00:00.000Z", "do a thing") +
      toolUseLine(
        "w2",
        "w1",
        SID_W1,
        "/home/x/watch-proj",
        "2025-01-01T00:00:01.000Z",
        "t1",
        "Bash",
        "echo hi",
      ) +
      toolResultLine(
        "w3",
        "w2",
        SID_W1,
        "/home/x/watch-proj",
        "2025-01-01T00:00:02.000Z",
        "t1",
        "hi",
      ),
  );
  // Expected initial events: 3

  const db = openDb(dbPath);
  const ac = new AbortController();

  // Start watch in the background (don't await — it runs until abort).
  const watchPromise = runIngest({ mode: "watch", root, db, signal: ac.signal });

  // Give it a moment to complete the backfill pass before we append.
  await Bun.sleep(200);

  // Append one new tool_use line to the existing session file: +1 event
  appendFileSync(
    sessionFile1,
    toolUseLine(
      "w4",
      "w3",
      SID_W1,
      "/home/x/watch-proj",
      "2025-01-01T00:01:00.000Z",
      "t2",
      "Bash",
      "ls",
    ),
  );

  // Create a brand-new session file in a new project directory: +2 events (prompt, text)
  const proj2Dir = join(root, "watch-proj2-slug");
  mkdirSync(proj2Dir, { recursive: true });
  const sessionFile2 = join(proj2Dir, `${SID_W2}.jsonl`);
  writeFileSync(
    sessionFile2,
    promptLine("x1", SID_W2, "/home/x/watch-proj2", "2025-01-02T00:00:00.000Z", "hello world") +
      textLine("x2", "x1", SID_W2, "/home/x/watch-proj2", "2025-01-02T00:00:01.000Z", "sure thing"),
  );

  // Poll until all 6 events are visible: 3 initial + 1 appended + 2 new file
  const EXPECTED_TOTAL = 6;
  const finalCount = await pollUntilCount(db, EXPECTED_TOTAL);
  expect(finalCount).toBe(EXPECTED_TOTAL);

  // Abort the watch loop and wait for it to return cleanly.
  ac.abort();
  await watchPromise;

  // Idempotency: run a backfill against the same DB — should insert 0 new rows.
  let insertedOnRestart = -1;
  await runIngest({
    mode: "backfill",
    root,
    db,
    onProgress: (n) => {
      insertedOnRestart = n;
    },
  });
  expect(insertedOnRestart).toBe(0);

  // Event count must still be EXPECTED_TOTAL — no dupes.
  const countAfterRestart = (db.query("SELECT COUNT(*) c FROM event").get() as { c: number }).c;
  expect(countAfterRestart).toBe(EXPECTED_TOTAL);

  db.close();
}, 10_000); // generous timeout; actual runtime ~2s at most

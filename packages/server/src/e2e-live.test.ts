/**
 * T-2.4 — e2e live delivery.
 *
 * Verifies the full live path: watch ingest detects a file append and writes to
 * the DB within ~2s; pollNewEvents returns the new rows with correct corr pairing.
 *
 * WAL-read strategy: open a fresh readonly Database right before each poll/assert.
 * A long-lived readonly connection can cache a WAL snapshot; re-opening forces a
 * checkpoint read and sees all committed writes. We close each short-lived reader
 * after use to avoid handle leaks.
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, runIngest } from "@clogdy/ingest";
import { maxEventId } from "./queries";
import { pollNewEvents } from "./app";

// ── Session ids ────────────────────────────────────────────────────────────────
const SID_LIVE = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const J = (o: unknown): string => JSON.stringify(o);

// ── Line constructors (mirror e2e.test.ts / watch.test.ts) ────────────────────

function promptLine(uuid: string, sid: string, cwd: string, ts: string, text: string): string {
  return (
    J({
      type: "user",
      uuid,
      parentUuid: null,
      sessionId: sid,
      cwd,
      timestamp: ts,
      message: { role: "user", content: text },
    }) + "\n"
  );
}

function toolUseLine(
  uuid: string,
  parentUuid: string,
  sid: string,
  cwd: string,
  ts: string,
  toolId: string,
  toolName: string,
  cmd: string,
): string {
  return (
    J({
      type: "assistant",
      uuid,
      parentUuid,
      sessionId: sid,
      cwd,
      timestamp: ts,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolId, name: toolName, input: { command: cmd } }],
      },
    }) + "\n"
  );
}

function toolResultLine(
  uuid: string,
  parentUuid: string,
  sid: string,
  cwd: string,
  ts: string,
  toolId: string,
  stdout: string,
  isError: boolean,
): string {
  return (
    J({
      type: "user",
      uuid,
      parentUuid,
      sessionId: sid,
      cwd,
      timestamp: ts,
      toolUseResult: { stdout, stderr: "" },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolId, is_error: isError, content: stdout }],
      },
    }) + "\n"
  );
}

// ── Bounded poll helpers ───────────────────────────────────────────────────────

/**
 * Poll until the event table has at least `minCount` rows, or 2s elapses.
 * Opens a fresh readonly connection each iteration to avoid WAL snapshot staleness.
 */
async function pollUntilCount(dbPath: string, minCount: number): Promise<number> {
  const steps = 40; // 40 × 50ms = 2s
  for (let i = 0; i < steps; i++) {
    const rdb = new Database(dbPath, { readonly: true });
    const { c } = rdb.query("SELECT COUNT(*) c FROM event").get() as { c: number };
    rdb.close();
    if (c >= minCount) return c;
    await Bun.sleep(50);
  }
  const rdb = new Database(dbPath, { readonly: true });
  const { c } = rdb.query("SELECT COUNT(*) c FROM event").get() as { c: number };
  rdb.close();
  return c;
}

/**
 * Poll until both uuids appear in the event table, or 2s elapses.
 * Returns true if found within the deadline.
 */
async function pollUntilUuids(dbPath: string, uuid1: string, uuid2: string): Promise<boolean> {
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const rdb = new Database(dbPath, { readonly: true });
    const rows = rdb.query("SELECT uuid FROM event WHERE uuid IN (?, ?)").all(uuid1, uuid2) as {
      uuid: string;
    }[];
    rdb.close();
    if (rows.length >= 2) return true;
    await Bun.sleep(50);
  }
  // Final check
  const rdb = new Database(dbPath, { readonly: true });
  const rows = rdb.query("SELECT uuid FROM event WHERE uuid IN (?, ?)").all(uuid1, uuid2) as {
    uuid: string;
  }[];
  rdb.close();
  return rows.length >= 2;
}

// ── The test ───────────────────────────────────────────────────────────────────

test("e2e live: watch ingest delivers appended tool_use+tool_result with corr pairing", async () => {
  let dir = "";
  const ac = new AbortController();
  let runP: Promise<void> | null = null;
  let wdb: Database | null = null;

  try {
    // 1. Scaffold temp tree.
    dir = mkdtempSync(join(tmpdir(), "clogdy-e2e-live-"));
    const root = join(dir, "projects");
    const dbPath = join(dir, "db", "clogdy.db");

    // Create one project dir + one existing session file with a prompt line
    // (so the initial backfill has something to chew on and the file exists to append to).
    const projDir = join(root, "live-proj-slug");
    mkdirSync(projDir, { recursive: true });
    const sessionFile = join(projDir, `${SID_LIVE}.jsonl`);
    writeFileSync(
      sessionFile,
      promptLine(
        "live-p1",
        SID_LIVE,
        "/home/me/live-proj",
        "2025-06-01T00:00:00.000Z",
        "do something live",
      ),
    );

    // 2. Open the writer DB.
    wdb = openDb(dbPath);

    // 3. Start watch ingest in the background — do NOT await.
    runP = runIngest({ mode: "watch", root, db: wdb, signal: ac.signal });

    // 4. Wait for the initial backfill to land (1 prompt event).
    const backfillCount = await pollUntilCount(dbPath, 1);
    expect(backfillCount).toBeGreaterThanOrEqual(1);

    // Capture cursorBefore AFTER backfill has settled — open a fresh readonly handle.
    // This is the pre-append max id; pollNewEvents uses it as the lower bound.
    const rdbCursor = new Database(dbPath, { readonly: true });
    const cursorBefore = maxEventId(rdbCursor);
    rdbCursor.close();

    // 5. Append a tool_use + matching tool_result to the existing session file.
    const TOOL_ID = "tool_live_1";
    const TOOL_USE_UUID = "live-tu-1";
    const TOOL_RESULT_UUID = "live-tr-1";

    appendFileSync(
      sessionFile,
      toolUseLine(
        TOOL_USE_UUID,
        "live-p1",
        SID_LIVE,
        "/home/me/live-proj",
        "2025-06-01T00:00:01.000Z",
        TOOL_ID,
        "Bash",
        "echo hi",
      ),
    );
    appendFileSync(
      sessionFile,
      toolResultLine(
        TOOL_RESULT_UUID,
        TOOL_USE_UUID,
        SID_LIVE,
        "/home/me/live-proj",
        "2025-06-01T00:00:02.000Z",
        TOOL_ID,
        "hi",
        false,
      ),
    );

    // 6. Bounded-poll until both new uuids appear in the DB (within ~2s).
    const found = await pollUntilUuids(dbPath, TOOL_USE_UUID, TOOL_RESULT_UUID);
    expect(found).toBe(true); // assert — do not merely time out

    // 7. Open a fresh readonly DB; call pollNewEvents; assert corr pairing.
    const rdb2 = new Database(dbPath, { readonly: true });
    try {
      const { events } = pollNewEvents(rdb2, cursorBefore, {});

      // Must contain both appended events.
      expect(events.length).toBeGreaterThanOrEqual(2);

      const tuRow = events.find((e) => e.kind === "tool_use" && e.tool === "Bash");
      const trRow = events.find((e) => e.kind === "tool_result");

      expect(tuRow).toBeDefined();
      expect(trRow).toBeDefined();

      // Both share the same corr (the tool id).
      expect(tuRow!.corr).toBe(TOOL_ID);
      expect(trRow!.corr).toBe(TOOL_ID);

      // isError is correctly set on the tool_result; null on the tool_use.
      expect(trRow!.isError).toBe(false);
      expect(tuRow!.isError).toBeNull();
    } finally {
      rdb2.close();
    }
  } finally {
    // 8. Shut down cleanly: abort signal, await the ingest promise, close dbs.
    ac.abort();
    if (runP) await runP;
    if (wdb) wdb.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}, 10_000); // generous timeout; actual runtime ~2-3s

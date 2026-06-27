/**
 * Tests for T-2.2: SSE /api/events/stream
 *
 * Strategy: unit-test the extracted `pollNewEvents` pure function for determinism.
 * The SSE wiring smoke test via app.request is included as a best-effort check;
 * it reads the stream with a bounded AbortController timeout so it is not flaky.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, runIngest, makeWriter } from "@lllogs/ingest";
import type { FlatEvent } from "@lllogs/shared";
import { maxEventId } from "./queries";
import { pollNewEvents, createApp } from "./app";

// ── Fixture tree ────────────────────────────────────────────────────────────
const S1 = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const J = (o: unknown) => JSON.stringify(o);

let dir: string;
let root: string;
let dbPath: string;
let rodb: Database; // readonly reader

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lllogs-sse-"));
  root = join(dir, "projects");
  dbPath = join(dir, "lllogs.db");

  // One project, one session: prompt + tool_use(Bash) + tool_result(ok)
  const d1 = join(root, "myproject-A");
  mkdirSync(d1, { recursive: true });
  writeFileSync(
    join(d1, `${S1}.jsonl`),
    [
      J({
        uuid: "q1",
        parentUuid: null,
        sessionId: S1,
        cwd: "/home/me/myproject",
        timestamp: "2024-04-01T00:00:00.000Z",
        message: { role: "user", content: "do the thing" },
      }),
      J({
        uuid: "q2",
        parentUuid: "q1",
        sessionId: S1,
        cwd: "/home/me/myproject",
        timestamp: "2024-04-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "x1", name: "Bash", input: { command: "echo hi" } }],
        },
      }),
      J({
        uuid: "q3",
        parentUuid: "q2",
        sessionId: S1,
        cwd: "/home/me/myproject",
        timestamp: "2024-04-01T00:00:02.000Z",
        toolUseResult: { stdout: "hi", stderr: "" },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x1", is_error: false, content: "hi" }],
        },
      }),
    ].join("\n") + "\n",
  );

  const wdb = openDb(dbPath);
  await runIngest({ mode: "backfill", root, db: wdb });
  wdb.close();

  rodb = new Database(dbPath, { readonly: true });
});

afterAll(() => {
  rodb.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Unit tests for pollNewEvents ────────────────────────────────────────────

test("maxEventId > 0 after ingest", () => {
  expect(maxEventId(rodb)).toBeGreaterThan(0);
});

test("pollNewEvents(db, 0, {}) returns all events, lastId === maxEventId", () => {
  const max = maxEventId(rodb);
  const { events, lastId } = pollNewEvents(rodb, 0, {});
  expect(events.length).toBe(3); // prompt + tool_use + tool_result
  expect(lastId).toBe(max);
  // All belong to our session
  for (const e of events) {
    expect(e.sessionId).toBe(S1);
  }
});

test("pollNewEvents at maxEventId returns empty, lastId unchanged", () => {
  const max = maxEventId(rodb);
  const { events, lastId } = pollNewEvents(rodb, max, {});
  expect(events).toHaveLength(0);
  expect(lastId).toBe(max);
});

test("pollNewEvents sees a new event inserted by a writable DB", () => {
  const prevMax = maxEventId(rodb);

  // Write a new event via a separate writable connection (simulates the ingester).
  const newEvent: FlatEvent = {
    uuid: "q-new",
    blockIdx: 0,
    parentUuid: null,
    sessionId: S1,
    project: "myproject",
    cwd: "/home/me/myproject",
    ts: Date.now(),
    kind: "text",
    role: "assistant",
    tool: null,
    command: null,
    corr: null,
    isError: null,
    inputJson: null,
    result: null,
    stderr: null,
    diff: null,
    resultHead: null,
    text: "new assistant message",
    durMs: null,
    gitBranch: null,
    raw: '{"extra":"new"}',
  };

  const wdb = openDb(dbPath);
  const w = makeWriter(wdb);
  w.add([newEvent]);
  w.flush();
  wdb.close();

  // The readonly DB in WAL mode sees committed writes.
  const { events, lastId } = pollNewEvents(rodb, prevMax, {});
  expect(events.length).toBeGreaterThanOrEqual(1);
  const found = events.find((e) => e.uuid === "q-new");
  expect(found).toBeDefined();
  expect(found!.text).toBe("new assistant message");
  expect(found!.kind).toBe("text");
  expect(lastId).toBeGreaterThan(prevMax);
});

test("pollNewEvents with kind filter returns only matching rows", () => {
  const { events } = pollNewEvents(rodb, 0, { kind: "tool_use" });
  expect(events.length).toBeGreaterThanOrEqual(1);
  for (const e of events) {
    expect(e.kind).toBe("tool_use");
  }
  // Verify non-tool_use rows are excluded
  const total = pollNewEvents(rodb, 0, {}).events.length;
  expect(events.length).toBeLessThan(total);
});

test("pollNewEvents project filter returns only matching project rows", () => {
  const { events } = pollNewEvents(rodb, 0, { project: "myproject" });
  for (const e of events) {
    expect(e.project).toBe("myproject");
  }
  const { events: none } = pollNewEvents(rodb, 0, { project: "nonexistent" });
  expect(none).toHaveLength(0);
});

// ── SSE wiring smoke test ───────────────────────────────────────────────────
// We read the stream for a short bounded time using a ReadableStream reader + AbortController.
// If this proves flaky on CI, it can be dropped — the pollNewEvents tests above cover the logic.

test("SSE /api/events/stream?lastId=0 emits at least one append event", async () => {
  const webDir = join(dir, "web");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<!doctype html>");

  const app = createApp({ db: rodb, webDir, dbPath });

  // Use AbortController to cap how long we read.
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 2500);

  try {
    const res = await app.request("/api/events/stream?lastId=0");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    if (!res.body) throw new Error("no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let foundAppend = false;

    // Read chunks until we see an "event: append" line or the timeout fires.
    outer: while (!ac.signal.aborted) {
      const readPromise = reader.read();
      const abortPromise = new Promise<{ done: true; value: undefined }>((resolve) => {
        ac.signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
          once: true,
        });
      });

      const result = await Promise.race([readPromise, abortPromise]);
      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: append")) {
          foundAppend = true;
          break outer;
        }
      }
    }

    reader.cancel().catch(() => {});
    expect(foundAppend).toBe(true);
  } finally {
    clearTimeout(timeout);
  }
});

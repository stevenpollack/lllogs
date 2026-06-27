import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlatEvent } from "@clogdy/shared";
import { openDb } from "./db";
import { makeWriter } from "./writer";

let dir: string;
let db: Database;

function ev(over: Partial<FlatEvent>): FlatEvent {
  return {
    uuid: "u",
    blockIdx: 0,
    parentUuid: null,
    sessionId: "s1",
    project: "proj",
    cwd: "/home/x/proj",
    ts: 1000,
    kind: "text",
    role: null,
    tool: null,
    command: null,
    corr: null,
    isError: null,
    inputJson: null,
    result: null,
    stderr: null,
    diff: null,
    resultHead: null,
    text: null,
    durMs: null,
    gitBranch: null,
    raw: "{}",
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clogdy-writer-"));
  db = openDb(join(dir, "w.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("add + flush inserts rows and maps columns", () => {
  const w = makeWriter(db);
  w.add([
    ev({
      uuid: "a",
      blockIdx: 0,
      kind: "tool_use",
      role: "assistant",
      tool: "Bash",
      command: "ls",
      corr: "t1",
    }),
    ev({ uuid: "a", blockIdx: 1, kind: "tool_result", isError: true, result: "boom", corr: "t1" }),
    ev({ uuid: "b", blockIdx: 0, kind: "text", text: "hi" }),
  ]);
  const inserted = w.flush();
  expect(inserted).toBe(3);

  const count = (db.query("SELECT COUNT(*) c FROM event").get() as { c: number }).c;
  expect(count).toBe(3);

  const tu = db
    .query("SELECT tool, command, corr, kind, role FROM event WHERE uuid='a' AND block_idx=0")
    .get() as any;
  expect(tu).toEqual({
    tool: "Bash",
    command: "ls",
    corr: "t1",
    kind: "tool_use",
    role: "assistant",
  });

  const tr = db
    .query("SELECT is_error, corr FROM event WHERE uuid='a' AND block_idx=1")
    .get() as any;
  expect(tr.is_error).toBe(1);
  expect(tr.corr).toBe("t1");
});

test("isError stores 0/1/null correctly", () => {
  const w = makeWriter(db);
  w.add([
    ev({ uuid: "ok", kind: "tool_result", isError: false }),
    ev({ uuid: "nul", kind: "text", isError: null }),
  ]);
  w.flush();
  const ok = db.query("SELECT is_error FROM event WHERE uuid='ok'").get() as any;
  const nul = db.query("SELECT is_error FROM event WHERE uuid='nul'").get() as any;
  expect(ok.is_error).toBe(0);
  expect(nul.is_error).toBe(null);
});

test("idempotent: re-flushing identical events inserts 0", () => {
  const w = makeWriter(db);
  const evs = [ev({ uuid: "x", blockIdx: 0 }), ev({ uuid: "x", blockIdx: 1 })];
  w.add(evs);
  expect(w.flush()).toBe(2);
  w.add(evs);
  expect(w.flush()).toBe(0);
  const count = (db.query("SELECT COUNT(*) c FROM event").get() as { c: number }).c;
  expect(count).toBe(2);
});

test("add auto-flushes at batchSize", () => {
  const w = makeWriter(db, 2);
  w.add([ev({ uuid: "p", blockIdx: 0 }), ev({ uuid: "p", blockIdx: 1 })]);
  // buffer reached 2 → auto-flush already happened
  const count = (db.query("SELECT COUNT(*) c FROM event").get() as { c: number }).c;
  expect(count).toBe(2);
});

test("setCursor upserts", () => {
  const w = makeWriter(db);
  w.setCursor("/p/a.jsonl", 100, 42);
  let row = db
    .query("SELECT offset, inode FROM ingest_cursor WHERE path='/p/a.jsonl'")
    .get() as any;
  expect(row.offset).toBe(100);
  expect(row.inode).toBe(42);
  w.setCursor("/p/a.jsonl", 250, 42);
  row = db.query("SELECT offset FROM ingest_cursor WHERE path='/p/a.jsonl'").get() as any;
  expect(row.offset).toBe(250);
});

test("upsertSession keeps max last_ts and min first_ts", () => {
  const w = makeWriter(db);
  w.upsertSession({
    sessionId: "s1",
    project: "p",
    cwd: "/c",
    path: "/f",
    ts: 500,
    gitBranch: "main",
  });
  w.upsertSession({
    sessionId: "s1",
    project: "p",
    cwd: null,
    path: "/f",
    ts: 1500,
    gitBranch: null,
  });
  w.upsertSession({
    sessionId: "s1",
    project: "p",
    cwd: null,
    path: "/f",
    ts: 200,
    gitBranch: null,
  });
  const row = db
    .query("SELECT first_ts, last_ts, cwd, git_branch FROM session WHERE session_id='s1'")
    .get() as any;
  expect(row.last_ts).toBe(1500);
  expect(row.first_ts).toBe(200);
  // COALESCE keeps prior non-null cwd / git_branch
  expect(row.cwd).toBe("/c");
  expect(row.git_branch).toBe("main");
});

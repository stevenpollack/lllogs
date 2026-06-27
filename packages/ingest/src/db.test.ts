import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "./db";

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lllogs-db-"));
  dbPath = join(dir, "nested", "lllogs.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("openDb creates the expected tables", () => {
  const db = openDb(dbPath);
  const names = new Set(
    (
      db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  expect(names.has("event")).toBe(true);
  expect(names.has("session")).toBe(true);
  expect(names.has("ingest_cursor")).toBe(true);
  expect(names.has("meta")).toBe(true);
  db.close();
});

test("openDb records schema_version=2", () => {
  const db = openDb(dbPath);
  const row = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as {
    value: string;
  } | null;
  expect(row?.value).toBe("2");
  db.close();
});

test("journal_mode is wal", () => {
  const db = openDb(dbPath);
  const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(row.journal_mode).toBe("wal");
  db.close();
});

test("openDb is idempotent (second open does not throw)", () => {
  expect(() => {
    const db = openDb(dbPath);
    db.close();
  }).not.toThrow();
});

test("openDb migrates a pre-v2 DB: adds role column, builds event_role, bumps schema_version", () => {
  const legacyPath = join(dir, "legacy", "old.db");
  mkdirSync(dirname(legacyPath), { recursive: true });
  // Simulate a v1 DB: an `event` table WITHOUT the `role` column and a stale
  // schema_version=1 meta row.
  const seed = new Database(legacyPath, { create: true });
  // The v1 `event` shape: every current column EXCEPT `role` (and no event_role
  // index). NOT NULL columns must be present so exec(SCHEMA_SQL)'s indexes build.
  seed.exec(
    `CREATE TABLE event (
       id INTEGER PRIMARY KEY, uuid TEXT NOT NULL, block_idx INTEGER NOT NULL,
       parent_uuid TEXT, session_id TEXT NOT NULL, project TEXT NOT NULL,
       ts INTEGER NOT NULL, kind TEXT NOT NULL, tool TEXT, command TEXT, corr TEXT,
       is_error INTEGER, input_json TEXT, result TEXT, stderr TEXT, diff TEXT,
       result_head TEXT, text TEXT, dur_ms INTEGER, git_branch TEXT, raw TEXT NOT NULL,
       UNIQUE (uuid, block_idx))`,
  );
  seed.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  seed.query("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  seed
    .query(
      "INSERT INTO event (uuid, block_idx, session_id, project, ts, kind, raw) VALUES ('old', 0, 's1', 'proj', 1000, 'text', '{}')",
    )
    .run();
  seed.close();

  // openDb must ALTER in `role` BEFORE exec(SCHEMA_SQL) creates event_role,
  // otherwise the index build would fail on a missing column.
  const db = openDb(legacyPath);
  const cols = (db.query("PRAGMA table_info(event)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).toContain("role");
  const idx = db
    .query("SELECT name FROM sqlite_master WHERE type='index' AND name='event_role'")
    .get();
  expect(idx).not.toBeNull();
  // The pre-existing row survives with role NULL (additive, non-destructive).
  const row = db.query("SELECT role FROM event WHERE uuid='old'").get() as { role: string | null };
  expect(row.role).toBeNull();
  // The stale schema_version is upgraded to 2 (authoritative DO UPDATE stamp).
  const ver = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as {
    value: string;
  };
  expect(ver.value).toBe("2");
  db.close();
});

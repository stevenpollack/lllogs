import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

/**
 * Open (creating if needed) the SQLite DB at `path`, applying the schema
 * idempotently and recording the schema version. WAL/synchronous pragmas live in
 * SCHEMA_SQL and are applied by `exec`.
 */
export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // Additive migrations (CONTRACTS §2): an existing pre-v2 DB has the `event`
  // table but is missing columns added in later versions. ALTER any missing one
  // BEFORE exec(SCHEMA_SQL), because the CREATE INDEX statements in SCHEMA_SQL run
  // after and must build against present columns. Every future additive column
  // goes in BOTH this list (name + type) and SCHEMA_SQL's CREATE TABLE.
  const ADDITIVE_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
    { name: "role", type: "TEXT" },
  ];
  const eventExists = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='event'")
    .get();
  if (eventExists) {
    const have = new Set(
      (db.query("PRAGMA table_info(event)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of ADDITIVE_COLUMNS) {
      if (!have.has(col.name)) db.exec(`ALTER TABLE event ADD COLUMN ${col.name} ${col.type}`);
    }
  }
  db.exec(SCHEMA_SQL);
  db.query(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(SCHEMA_VERSION));
  return db;
}

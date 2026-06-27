export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- holds schema_version, etc.

CREATE TABLE IF NOT EXISTS session (
  session_id TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  cwd        TEXT,
  path       TEXT NOT NULL,
  first_ts   INTEGER,
  last_ts    INTEGER,
  git_branch TEXT
);
CREATE INDEX IF NOT EXISTS session_project ON session(project);

CREATE TABLE IF NOT EXISTS event (
  id          INTEGER PRIMARY KEY,         -- == rowid; the cursor
  uuid        TEXT NOT NULL,
  block_idx   INTEGER NOT NULL,
  parent_uuid TEXT,
  session_id  TEXT NOT NULL,
  project     TEXT NOT NULL,               -- denormalized for fast GROUP BY
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  role        TEXT,
  tool        TEXT,
  command     TEXT,
  corr        TEXT,
  is_error    INTEGER,                     -- 0/1/NULL
  input_json  TEXT,
  result      TEXT,
  stderr      TEXT,
  diff        TEXT,
  result_head TEXT,
  text        TEXT,
  dur_ms      INTEGER,
  git_branch  TEXT,
  raw         TEXT NOT NULL,
  UNIQUE (uuid, block_idx)                 -- idempotency anchor
);
CREATE INDEX IF NOT EXISTS event_ts      ON event(ts);
CREATE INDEX IF NOT EXISTS event_session ON event(session_id, ts);
CREATE INDEX IF NOT EXISTS event_project ON event(project, ts);
CREATE INDEX IF NOT EXISTS event_tool    ON event(tool) WHERE tool IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_corr    ON event(corr) WHERE corr IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_kind    ON event(kind);
CREATE INDEX IF NOT EXISTS event_role    ON event(role) WHERE role IS NOT NULL;

CREATE TABLE IF NOT EXISTS ingest_cursor (
  path       TEXT PRIMARY KEY,
  offset     INTEGER NOT NULL,             -- bytes consumed
  inode      INTEGER,                      -- detect truncate/rotate
  updated_ts INTEGER
);
`;

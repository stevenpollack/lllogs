import type { Database, Statement } from "bun:sqlite";
import type { FlatEvent } from "@lllogs/shared";

export interface Writer {
  /** Buffer events; flushes at batchSize or flush(). Returns inserted count (post OR IGNORE). */
  add(events: FlatEvent[]): void;
  flush(): number;
  setCursor(path: string, offset: number, inode: number | null): void;
  upsertSession(s: {
    sessionId: string;
    project: string;
    cwd: string | null;
    path: string;
    ts: number;
    gitBranch: string | null;
  }): void;
  close(): void;
}

const INSERT_SQL = `INSERT OR IGNORE INTO event
  (uuid, block_idx, parent_uuid, session_id, project, ts, kind, role, tool, command, corr,
   is_error, input_json, result, stderr, diff, result_head, text, dur_ms, git_branch, raw)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const CURSOR_SQL = `INSERT INTO ingest_cursor (path, offset, inode, updated_ts)
  VALUES (?,?,?,?)
  ON CONFLICT(path) DO UPDATE SET
    offset=excluded.offset, inode=excluded.inode, updated_ts=excluded.updated_ts`;

const SESSION_SQL = `INSERT INTO session (session_id, project, cwd, path, first_ts, last_ts, git_branch)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(session_id) DO UPDATE SET
    project=excluded.project,
    cwd=COALESCE(excluded.cwd, session.cwd),
    path=excluded.path,
    last_ts=MAX(COALESCE(session.last_ts, 0), excluded.last_ts),
    first_ts=MIN(COALESCE(session.first_ts, excluded.last_ts), excluded.last_ts),
    git_branch=COALESCE(excluded.git_branch, session.git_branch)`;

export function makeWriter(db: Database, batchSize = 200): Writer {
  const insert: Statement = db.prepare(INSERT_SQL);
  const cursor: Statement = db.prepare(CURSOR_SQL);
  const session: Statement = db.prepare(SESSION_SQL);

  let buffer: FlatEvent[] = [];

  const insertAll = db.transaction((events: FlatEvent[]): number => {
    let inserted = 0;
    for (const e of events) {
      const isError = e.isError === null ? null : e.isError ? 1 : 0;
      const r = insert.run(
        e.uuid,
        e.blockIdx,
        e.parentUuid,
        e.sessionId,
        e.project,
        e.ts,
        e.kind,
        e.role,
        e.tool,
        e.command,
        e.corr,
        isError,
        e.inputJson,
        e.result,
        e.stderr,
        e.diff,
        e.resultHead,
        e.text,
        e.durMs,
        e.gitBranch,
        e.raw,
      );
      inserted += r.changes;
    }
    return inserted;
  });

  return {
    add(events: FlatEvent[]): void {
      for (const e of events) buffer.push(e);
      if (buffer.length >= batchSize) this.flush();
    },
    flush(): number {
      if (buffer.length === 0) return 0;
      const batch = buffer;
      buffer = [];
      return insertAll(batch);
    },
    setCursor(path: string, offset: number, inode: number | null): void {
      cursor.run(path, offset, inode, Date.now());
    },
    upsertSession(s): void {
      session.run(s.sessionId, s.project, s.cwd, s.path, s.ts, s.ts, s.gitBranch);
    },
    close(): void {
      this.flush();
    },
  };
}

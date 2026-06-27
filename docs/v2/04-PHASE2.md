# Phase 2 — Live monitor

Goal: the DB stays live as Claude works, and the UI updates without reload. Builds on Phase 1. Subagent
template + ground rules apply. Gate: T-2.4 green.

---

## T-2.1 — ingest: harden `--watch` (continuous tail + periodic flush) (PG0, needs 1.4)

**Files:** edit `packages/ingest/src/ingest.ts`; add `packages/ingest/src/watch.test.ts`.

**Spec:**
- `mode:"watch"` does: (1) a `full:true, once:true` backfill pass (catch up, persist cursors); (2) then
  `tail({root, full:false, cursors}, sink)` polling forever.
- During watch, flush on a cadence: a `setInterval(() => writer.flush(), flushMs)` with `flushMs=400`,
  **and** persist the cursor for each file after its lines are flushed (so a crash resumes correctly).
  Use the file's current `statSync(path).size`/`.ino` for the cursor (the tailer advances offsets
  internally; align cursor persistence to "after we've flushed everything we read up to size S").
  Simplest correct rule: in the sink, buffer events; on each tailer tick boundary you don't directly
  see — so instead, after `writer.flush()` in the interval, walk the set of files touched since last
  persist and `setCursor(path, statSync(path).size, ino)`. Track "touched paths" in a Set the sink adds
  to.
- Graceful shutdown: on `SIGINT`/`SIGTERM`, `clearInterval`, `writer.flush()`, persist cursors, `db.close()`,
  exit 0.
- **Testability — add `signal?: AbortSignal` to `RunIngestOptions`.** A forever `tail` can't be stopped
  from a `bun:test` process without killing the runner. So the watch loop races the forever-tail against
  `signal`; on abort it flushes + persists cursors + **returns** (NO `process.exit`/`db.close()` — the
  caller owns the passed-in db). Register the `SIGINT`/`SIGTERM` handlers **only when no `signal` is
  supplied** (avoids listener leakage across test runs). The e2e (T-2.4) drives shutdown via `ac.abort()`
  then `await runP`.
- Idempotency must hold across restarts: stopping mid-stream and re-running `--watch` inserts no dupes
  (guaranteed by `UNIQUE(uuid,block_idx)` + resumed cursors).

**Tests (`watch.test.ts`):** start `runIngest({mode:"watch"})` against a temp tree in the background
(don't await; keep a handle); **append** a new line to an existing session file and create a **new**
session file; after a short poll interval, assert the new events appear in `event` (poll the DB up to ~2s).
Then signal shutdown; assert it flushed. (Use a timeout-bounded poll loop; keep it deterministic.)

**Acceptance:** `bun test packages/ingest/src/watch.test.ts` green; `bun run check` green; manual:
`bun run v2:ingest -- --watch` against real `~/.claude/projects` ingests new activity live (orchestrator
spot-checks by triggering any Claude tool call in another session and watching the count rise).

---

## T-2.2 — server: SSE `/api/events/stream` (PG0, needs 1.6)

**Files:** edit `packages/server/src/app.ts` (replace the 501 stub); add `packages/server/src/sse.test.ts`.

**Spec:**
- `GET /api/events/stream?<EventFilter>&lastId=<n>`: open an SSE response (Hono `streamSSE`). Maintain a
  server-side `cursor = lastId ?? maxEventId(db)`. Every `pollMs=1000`: run `queryEvents(db, {...filter,
  afterId: cursor, limit: 500})`; if rows, send `event:"append"`, `data: JSON.stringify({events, lastId: rows[rows.length-1].id})`, set `cursor = that id`; loop until drained (if a poll returns a full page, immediately poll again before sleeping). Send `event:"ping"` every ~15s to keep the connection alive when idle. Stop when the client disconnects (Hono abort signal).
- The server is read-only; it just polls the same DB the ingester writes (WAL → concurrent reads are
  fine, ground rule #4/#5). No DuckDB here.
- **`lastId` is the stream cursor — NOT `afterId`.** The SSE query param is `lastId` (init the cursor
  from it); the REST pagination key is `afterId`. They are distinct. The web client (T-2.3) must build
  the stream URL with `lastId`, not reuse the REST `qs()` blindly (which emits `afterId`) — otherwise the
  server defaults the cursor to `maxEventId` and silently drops the client's intended start id.
- Export the extracted `pollNewEvents(db, cursor, filter)` from `packages/server/src/index.ts` (the e2e
  and any later phase rely on it as a stable export).
- When a short `session` filter expands to null (no match), set a sentinel that matches nothing
  (`filter.session = "\x00"`) so the stream stays open and simply never emits — don't 404 a stream.

**Tests (`sse.test.ts`):** seed a DB; `createApp`; start an SSE request via `app.request("/api/events/stream?lastId=0")`;
read the stream for a bounded time; **insert** a new event into the DB (direct writer); assert the
stream emits an `append` carrying it within ~2 polls. (If testing the live stream is awkward with
`app.request`, instead unit-test the extracted poll function `pollNewEvents(db, cursor, filter)` that the
SSE handler calls, and assert it returns new rows and advances the cursor — and keep the SSE wiring thin.)
Prefer the extracted-function approach for determinism.

**Acceptance:** `bun test packages/server/src/sse.test.ts` green; `bun run check` green; manual: `curl -N
'localhost:7331/api/events/stream?lastId=0'` prints `append` frames while `--watch` ingests.

---

## T-2.3 — web: live tail toggle + dashboard tiles (PG1, needs 2.2, 1.7)

**Files:** edit `packages/web/src/main.ts`, `packages/web/src/api.ts`, `packages/web/index.html`; add
`packages/web/src/live.ts`.

**Spec:**
- `live.ts`: `subscribe(filter, onAppend: (rows: EventRow[]) => void): () => void` — opens an
  `EventSource("/api/events/stream?"+qs)` (carry the active filter + `lastId` = the table's current max
  id), handles `append` events (parse, call `onAppend`), returns an unsubscribe that closes it.
- main.ts: a **Live** toggle in the filter bar. When on: open the subscription; prepend/append new rows
  to the table (respecting `id ASC`); auto-scroll if pinned to bottom. When the filter changes while
  live, resubscribe with the new filter + current max id. When off, close.
- **Dashboard tiles** (a small header strip): total events, events in the last 5 min, current error rate
  (errors/tool_results), top tool — computed from `/api/facets` + a couple of cheap `/api/events`
  windowed queries (or add filter `since=Date.now()-5min`). Refresh tiles on each facet refresh and on
  live append (throttled ~1s).

**Acceptance:** `bun run v2:web:build` ok; `bun run check` green; manual (orchestrator): with `--watch`
running, the live toggle streams new rows in and tiles update.

---

## T-2.4 — e2e: live delivery (PG2, needs 2.1, 2.2)

**Files:** `packages/server/src/e2e-live.test.ts`.

**Spec:** temp tree + DB; start a `--watch` ingest (background handle); open the extracted
`pollNewEvents` (or an `app.request` SSE read); **append** a tool_use+result to a session file; assert
within ~2s that (a) the DB has the new events and (b) a `pollNewEvents(db, cursorBefore, {})` returns
them with the right `corr` pairing. Shut down cleanly.

**Acceptance:** green → **Phase 2 gate** commit `feat(v2): live monitor — watch ingest + SSE stream + live UI`.

### Dispatch: PG0 {T-2.1, T-2.2} ∥ → PG1 {T-2.3} → PG2 {T-2.4}.

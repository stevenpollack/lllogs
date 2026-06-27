import type { Database } from "bun:sqlite";
import { join, normalize, resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Logger } from "pino";
import {
  asArray,
  assertSelectOnly,
  type ErrorFilter,
  type EventFilter,
  type EventKind,
  type EventRow,
} from "@lllogs/shared";
import { nodeLogger } from "@lllogs/shared/node";
import { expandSession, maxEventId, queryEvents, queryFacets } from "./queries";

type AppEnv = { Variables: { log: Logger } };

export interface AppOptions {
  db: Database;
  webDir: string;
  dbPath?: string;
  repoRoot?: string;
  log?: Logger;
}

/** The five metric names the analytics CLI accepts (CONTRACTS §6 / PHASE3 T-3.2). */
const STATS_METRICS = new Set([
  "toolCounts",
  "errorRate",
  "latency",
  "projectRollup",
  "timeBuckets",
]);

const KINDS = new Set<EventKind>(["prompt", "text", "thinking", "tool_use", "tool_result"]);

/** Parse a numeric query param; undefined if absent or NaN. Throws on a present-but-bad value. */
function numParam(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new BadParam(`bad numeric param: ${name}`);
  return n;
}

class BadParam extends Error {}

/** Collapse a 0/1/n-element array to undefined / scalar / array (the EventFilter shape). */
function oneOrMany<T>(vals: T[]): T | T[] | undefined {
  return vals.length === 0 ? undefined : vals.length === 1 ? vals[0] : vals;
}

/**
 * Build an EventFilter from a multi-valued source. `getAll(k)` returns every
 * value supplied for key `k` (repeated query params, or a body array), so the
 * facet dimensions can carry multiple selections. `session` is NOT yet expanded.
 * May throw BadParam.
 */
function parseFilter(getAll: (k: string) => string[]): EventFilter {
  const f: EventFilter = {};
  const one = (k: string): string | undefined => getAll(k)[0];

  const project = oneOrMany(getAll("project"));
  if (project !== undefined) f.project = project;
  const session = oneOrMany(getAll("session"));
  if (session !== undefined) f.session = session;
  const tool = oneOrMany(getAll("tool"));
  if (tool !== undefined) f.tool = tool;

  const kinds = getAll("kind");
  for (const k of kinds) if (!KINDS.has(k as EventKind)) throw new BadParam(`bad kind: ${k}`);
  const kind = oneOrMany(kinds as EventKind[]);
  if (kind !== undefined) f.kind = kind;

  // role is a free-string multi-value dimension (no enum, mirrors project/tool).
  const role = oneOrMany(getAll("role"));
  if (role !== undefined) f.role = role;

  const errors = getAll("error");
  for (const e of errors) if (e !== "error" && e !== "ok") throw new BadParam(`bad error: ${e}`);
  const error = oneOrMany(errors as ErrorFilter[]);
  if (error !== undefined) f.error = error;

  const corr = one("corr");
  if (corr !== undefined) f.corr = corr;
  const since = numParam(one("since"), "since");
  if (since !== undefined) f.since = since;
  const until = numParam(one("until"), "until");
  if (until !== undefined) f.until = until;
  const qq = one("q");
  if (qq !== undefined) f.q = qq;
  const afterId = numParam(one("afterId"), "afterId");
  if (afterId !== undefined) f.afterId = afterId;
  const limit = numParam(one("limit"), "limit");
  if (limit !== undefined) f.limit = limit;
  return f;
}

/**
 * Expand short session ids to full ones in place. Handles single or multiple
 * sessions. A short id with no match is kept as-is — it can never equal a full
 * (36-char) session_id, so it simply matches no rows (no need for a sentinel).
 */
function expandFilterSessions(db: Database, f: EventFilter): void {
  const sessions = asArray(f.session);
  if (sessions.length === 0) return;
  const expanded = sessions.map((s) => (s.length < 32 ? (expandSession(db, s) ?? s) : s));
  f.session = oneOrMany(expanded);
}

const POLL_MS = 1000;
const PING_MS = 15_000;
const PAGE_SIZE = 500;

/**
 * Pure, synchronous poll: fetch events after `cursor` that match `filter`.
 * Returns the new rows and the advanced lastId (unchanged if no rows).
 */
export function pollNewEvents(
  db: Database,
  cursor: number,
  filter: EventFilter,
): { events: EventRow[]; lastId: number } {
  const { rows } = queryEvents(db, { ...filter, afterId: cursor, limit: PAGE_SIZE });
  const lastId = rows.length > 0 ? rows[rows.length - 1]!.id : cursor;
  return { events: rows, lastId };
}

export function createApp(opts: AppOptions): Hono<AppEnv> {
  const { db, webDir, dbPath } = opts;
  const repoRoot = opts.repoRoot ?? resolve(import.meta.dir, "../../..");
  const log = opts.log ?? nodeLogger("server");
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const reqId = crypto.randomUUID().slice(0, 8);
    const rlog = log.child({ reqId, method: c.req.method, path: c.req.path });
    c.set("log", rlog);
    const t0 = performance.now();
    rlog.debug({ evt: "req.start" });
    await next();
    const durMs = Math.round(performance.now() - t0);
    const status = c.res.status;
    rlog[status >= 500 ? "warn" : "debug"]({ evt: "req.end", status, durMs });
  });

  app.get("/healthz", (c) => {
    const events = (db.query("SELECT COUNT(*) c FROM event").get() as { c: number }).c;
    return c.json({ ok: true, dbPath, events, maxId: maxEventId(db) });
  });

  app.get("/api/events", (c) => {
    try {
      const f = parseFilter((k) => c.req.queries(k) ?? []);
      expandFilterSessions(db, f);
      const { rows, nextAfterId } = queryEvents(db, f);
      return c.json({ events: rows, nextAfterId });
    } catch (err) {
      if (err instanceof BadParam) return c.json({ error: err.message }, 400);
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get("/api/facets", (c) => {
    try {
      const f = parseFilter((k) => c.req.queries(k) ?? []);
      expandFilterSessions(db, f);
      return c.json(queryFacets(db, f));
    } catch (err) {
      if (err instanceof BadParam) return c.json({ error: err.message }, 400);
      return c.json({ error: String(err) }, 500);
    }
  });

  // Phase 2 — SSE live stream.
  app.get("/api/events/stream", (c) => {
    const slog = c.get("log");
    let filter: EventFilter;
    try {
      filter = parseFilter((k) => c.req.queries(k) ?? []);
      // Expand short session ids the same way as /api/events. An unmatched short
      // id is kept as-is and matches nothing, so the stream stays open with pings.
      expandFilterSessions(db, filter);
    } catch (err) {
      if (err instanceof BadParam) return c.json({ error: (err as Error).message }, 400);
      return c.json({ error: String(err) }, 500);
    }

    const lastIdParam = c.req.query("lastId");
    const initCursor = lastIdParam !== undefined ? Number(lastIdParam) : maxEventId(db);

    return streamSSE(c, async (stream) => {
      let cursor = Number.isNaN(initCursor) ? maxEventId(db) : initCursor;
      let lastPing = Date.now();
      slog.info({ evt: "sse.open", cursor, filters: Object.keys(filter) });

      stream.onAbort(() => {
        // No-op: stream.aborted is set automatically; the while loop will exit.
      });

      while (!stream.closed && !stream.aborted) {
        // Drain: poll until < PAGE_SIZE rows or abort.
        let sentAppend = false;
        let full = true;
        while (full && !stream.closed && !stream.aborted) {
          // If the DB handle is gone (e.g. a test closed it during teardown, or
          // a shutdown races the poll), end the stream quietly instead of
          // throwing an uncaught RangeError. The client reconnects on its own.
          let events: EventRow[];
          let lastId: number;
          try {
            ({ events, lastId } = pollNewEvents(db, cursor, filter));
          } catch (err) {
            // The DB handle can vanish under us (e.g. a test closes it during
            // teardown) — end the stream quietly in that case. Anything else is a
            // genuine failure: log it so it isn't silently swallowed into a client
            // reconnect loop.
            if (!(err instanceof Error && /closed database/i.test(err.message))) {
              slog.error({ evt: "sse.poll_failed", err: String(err) });
            }
            return;
          }
          full = events.length === PAGE_SIZE;
          if (events.length > 0) {
            cursor = lastId;
            sentAppend = true;
            slog.debug({ evt: "sse.append", n: events.length, lastId });
            await stream.writeSSE({
              event: "append",
              data: JSON.stringify({ events, lastId }),
            });
          } else {
            full = false; // break the drain loop
          }
        }

        // Send a ping if idle long enough and we didn't just send an append.
        const now = Date.now();
        if (!sentAppend && now - lastPing >= PING_MS) {
          await stream.writeSSE({ event: "ping", data: "{}" });
          lastPing = now;
        } else if (sentAppend) {
          lastPing = now;
        }

        if (!stream.closed && !stream.aborted) {
          await stream.sleep(POLL_MS);
        }
      }
      slog.info({ evt: "sse.close" });
    });
  });
  // Phase 3 — analytics proxy. Spawns the DuckDB CLI in a child process so the
  // server process never links DuckDB (ground rule #3).
  app.get("/api/stats", async (c) => {
    const slog = c.get("log");
    const metric = c.req.query("metric");
    if (metric === undefined || !STATS_METRICS.has(metric)) {
      return c.json({ error: "bad metric" }, 400);
    }

    let f: EventFilter;
    try {
      f = parseFilter((k) => c.req.queries(k) ?? []);
    } catch (err) {
      if (err instanceof BadParam) return c.json({ error: err.message }, 400);
      return c.json({ error: String(err) }, 500);
    }
    // Mirror /api/events session expansion: expand short ids; if not found leave
    // the short value as-is (it simply won't match → empty/zero metric). No 404.
    expandFilterSessions(db, f);

    if (dbPath === undefined) {
      return c.json({ error: "dbPath not configured" }, 500);
    }

    const t0 = performance.now();
    slog.info({ evt: "analytics.spawn", mode: "stats", metric });
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "analytics",
        "--",
        "--db",
        dbPath,
        "--metric",
        metric,
        "--filters",
        JSON.stringify(f),
      ],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );

    const TIMEOUT_MS = 20_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = await Promise.race([
      proc.exited.then(() => "done" as const),
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), TIMEOUT_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer); // don't leak the timer on the success path
    if (timed === "timeout") {
      proc.kill();
      slog.warn({ evt: "analytics.timeout", ms: TIMEOUT_MS });
      return c.json({ error: "analytics timed out" }, 504);
    }

    const code = proc.exitCode;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (code !== 0) {
      slog.warn({ evt: "analytics.failed", code, stderr: stderr.trim().slice(0, 500) });
      return c.json({ error: stderr.trim() || "analytics failed" }, 500);
    }
    try {
      const json = JSON.parse(stdout);
      slog.info({ evt: "analytics.exit", code, durMs: Math.round(performance.now() - t0) });
      return c.json(json);
    } catch {
      return c.json({ error: "bad analytics output" }, 500);
    }
  });

  // Phase 5 — SQL query proxy. Wraps the user's SQL in a facet-scoped CTE and
  // spawns the analytics CLI in --query mode. No DuckDB in this process (ground rule #3).
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post("/api/query", async (c) => {
    const slog = c.get("log");
    // Parse JSON body.
    let rawBody: Record<string, unknown>;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const sql = rawBody.sql;
    if (typeof sql !== "string") {
      return c.json({ error: "sql must be a string" }, 400);
    }

    const rawLimit = rawBody.limit;
    const limitNum = typeof rawLimit === "number" && !Number.isNaN(rawLimit) ? rawLimit : undefined;

    // Parse filter from the body object using the same parseFilter machinery as
    // query params — each value becomes a string[] (a facet dim may be an array).
    const rawFilter =
      rawBody.filter !== null && typeof rawBody.filter === "object"
        ? (rawBody.filter as Record<string, unknown>)
        : {};
    let f: EventFilter;
    try {
      f = parseFilter((k) => {
        const v = rawFilter[k];
        if (v === undefined || v === null) return [];
        return Array.isArray(v) ? v.map(String) : [String(v)];
      });
    } catch (err) {
      if (err instanceof BadParam) return c.json({ error: (err as Error).message }, 400);
      return c.json({ error: String(err) }, 500);
    }

    // Expand short session id(s) (mirrors /api/events and /api/stats).
    expandFilterSessions(db, f);

    // Guard sql before spawning — instant 400, no subprocess cost.
    try {
      assertSelectOnly(sql);
    } catch (err) {
      slog.warn({ evt: "query.rejected", reason: (err as Error).message });
      return c.json({ error: (err as Error).message }, 400);
    }

    if (dbPath === undefined) {
      return c.json({ error: "dbPath not configured" }, 500);
    }

    // Effective cap, clamped to [1, 5000] (the CLI re-clamps identically): log + forward the
    // real value so a client `limit: 0`/negative/huge isn't misrepresented in the spawn log.
    const cap = Math.max(1, Math.min(limitNum ?? 1000, 5000));
    const t0 = performance.now();
    slog.info({ evt: "analytics.spawn", mode: "query", sqlLen: sql.length, cap });
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "analytics",
        "--",
        "--db",
        dbPath,
        "--query",
        "--sql",
        sql,
        "--filters",
        JSON.stringify(f),
        "--limit",
        String(cap),
      ],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );

    const QUERY_TIMEOUT_MS = 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = await Promise.race([
      proc.exited.then(() => "done" as const),
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), QUERY_TIMEOUT_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer); // don't leak the timer on the success path
    if (timed === "timeout") {
      proc.kill();
      slog.warn({ evt: "analytics.timeout", ms: QUERY_TIMEOUT_MS });
      return c.json({ error: "query timed out" }, 504);
    }

    const code = proc.exitCode;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (code !== 0) {
      slog.warn({ evt: "analytics.failed", code, stderr: stderr.trim().slice(0, 500) });
      return c.json({ error: stderr.trim() || "query failed" }, 500);
    }
    try {
      const result = JSON.parse(stdout);
      slog.info({
        evt: "analytics.exit",
        code,
        durMs: Math.round(performance.now() - t0),
        rows: result.rows?.length,
        truncated: result.truncated,
      });
      return c.json(result);
    } catch {
      return c.json({ error: "bad query output" }, 500);
    }
  });

  // Static assets: `/` → index.html, anything else → file under webDir. 404 if missing.
  app.get("/*", async (c) => {
    const url = new URL(c.req.url);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    // Prevent path traversal: normalize and reject anything escaping webDir.
    const rel = normalize(path).replace(/^(\.\.(\/|\\|$))+/, "");
    const full = join(webDir, rel);
    if (!full.startsWith(webDir)) return c.json({ error: "forbidden" }, 403);
    const file = Bun.file(full);
    if (!(await file.exists())) return c.json({ error: "not found" }, 404);
    return new Response(file);
  });

  return app;
}

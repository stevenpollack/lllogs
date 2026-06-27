import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlatEvent } from "@lllogs/shared";
import { makeWriter, openDb } from "@lllogs/ingest";
import { createApp } from "./app";

let dir: string;
let db: Database;
let webDir: string;
let app: ReturnType<typeof createApp>;

function ev(over: Partial<FlatEvent>): FlatEvent {
  return {
    uuid: "u",
    blockIdx: 0,
    parentUuid: null,
    sessionId: "s1",
    project: "alpha",
    cwd: "/c",
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
  dir = mkdtempSync(join(tmpdir(), "lllogs-app-"));
  db = openDb(join(dir, "a.db"));
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
    ev({
      uuid: "a",
      blockIdx: 1,
      kind: "tool_result",
      role: "user",
      isError: true,
      result: "x",
      corr: "t1",
    }),
    ev({ uuid: "b", blockIdx: 0, kind: "text", role: "assistant", text: "hi" }),
  ]);
  w.flush();

  webDir = join(dir, "web");
  mkdirSync(join(webDir, "dist"), { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>lllogs</title>");
  writeFileSync(join(webDir, "dist", "main.js"), "console.log('hi')");

  app = createApp({ db, webDir, dbPath: join(dir, "a.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("/healthz returns events count and maxId", async () => {
  const r = await app.request("/healthz");
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.ok).toBe(true);
  expect(body.events).toBe(3);
  expect(body.maxId).toBe(3);
});

test("/api/events?tool=Bash returns only Bash rows", async () => {
  const r = await app.request("/api/events?tool=Bash");
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.events.length).toBe(1);
  expect(body.events[0].tool).toBe("Bash");
  expect(body.nextAfterId).toBe(null);
});

test("/api/facets returns expected buckets", async () => {
  const r = await app.request("/api/facets");
  expect(r.status).toBe(200);
  const f = (await r.json()) as any;
  expect(f.tool).toEqual([{ value: "Bash", count: 1 }]);
  expect(f.error).toEqual(expect.arrayContaining([{ value: "error", count: 1 }]));
  const kinds = Object.fromEntries(f.kind.map((b: any) => [b.value, b.count]));
  expect(kinds).toEqual({ tool_use: 1, tool_result: 1, text: 1 });
  const roles = Object.fromEntries(f.role.map((b: any) => [b.value, b.count]));
  expect(roles).toEqual({ assistant: 2, user: 1 });
});

test("/api/events?role=user returns only user-authored rows", async () => {
  const r = await app.request("/api/events?role=user");
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.events.length).toBe(1);
  expect(body.events[0].role).toBe("user");
});

test("bad numeric param → 400", async () => {
  const r = await app.request("/api/events?limit=abc");
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error).toContain("limit");
});

test("/api/events/stream → 200 SSE headers", async () => {
  // The SSE endpoint no longer returns 501. It streams; just verify status+content-type.
  // We don't read the body here (it would block waiting for events) — sse.test.ts covers the logic.
  const r = await app.request("/api/events/stream?lastId=99999999");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/event-stream");
});

test("/api/stats with no/invalid metric → 400", async () => {
  // Phase 3: the 501 stub is gone; the handler validates `metric` first.
  const r = await app.request("/api/stats");
  expect(r.status).toBe(400);
});

test("/ serves index.html bytes", async () => {
  const r = await app.request("/");
  expect(r.status).toBe(200);
  const txt = await r.text();
  expect(txt).toContain("lllogs");
});

test("missing asset → 404", async () => {
  const r = await app.request("/dist/nope.js");
  expect(r.status).toBe(404);
});

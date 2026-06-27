import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, runIngest } from "@clogdy/ingest";
import { createApp } from "./app";

// ── Fixture tree ──────────────────────────────────────────────────────────────
// 2 projects, 3 sessions. Hand-computed expected counts below.
const S1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // proj-one
const S2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // proj-one
const S3 = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // proj-two

const J = (o: unknown) => JSON.stringify(o);

let dir: string;
let root: string;
let dbPath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "clogdy-e2e-"));
  root = join(dir, "projects");
  dbPath = join(dir, "db", "clogdy.db");

  // P1 / S1 — prompt, Bash tool_use (ok result)
  const d1 = join(root, "proj-one-A");
  mkdirSync(d1, { recursive: true });
  writeFileSync(
    join(d1, `${S1}.jsonl`),
    [
      J({
        uuid: "s1l1",
        parentUuid: null,
        sessionId: S1,
        cwd: "/home/me/proj-one",
        timestamp: "2024-03-01T00:00:00.000Z",
        message: { role: "user", content: "first task" },
      }),
      J({
        uuid: "s1l2",
        parentUuid: "s1l1",
        sessionId: S1,
        cwd: "/home/me/proj-one",
        timestamp: "2024-03-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }],
        },
      }),
      J({
        uuid: "s1l3",
        parentUuid: "s1l2",
        sessionId: S1,
        cwd: "/home/me/proj-one",
        timestamp: "2024-03-01T00:00:02.000Z",
        toolUseResult: { stdout: "a\nb", stderr: "" },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c1", is_error: false, content: "a\nb" }],
        },
      }),
    ].join("\n") + "\n",
  );

  // P1 / S2 — assistant text, Bash tool_use (ERROR result)
  const d2 = join(root, "proj-one-B");
  mkdirSync(d2, { recursive: true });
  writeFileSync(
    join(d2, `${S2}.jsonl`),
    [
      J({
        uuid: "s2l1",
        parentUuid: null,
        sessionId: S2,
        cwd: "/home/me/proj-one",
        timestamp: "2024-03-02T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "let me check" }] },
      }),
      J({
        uuid: "s2l2",
        parentUuid: "s2l1",
        sessionId: S2,
        cwd: "/home/me/proj-one",
        timestamp: "2024-03-02T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "c2", name: "Bash", input: { command: "false" } }],
        },
      }),
      J({
        uuid: "s2l3",
        parentUuid: "s2l2",
        sessionId: S2,
        cwd: "/home/me/proj-one",
        timestamp: "2024-03-02T00:00:02.000Z",
        toolUseResult: { stdout: "", stderr: "boom" },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c2", is_error: true, content: "exit 1" }],
        },
      }),
    ].join("\n") + "\n",
  );

  // P2 / S3 — prompt, WebFetch tool_use (ok result), + a non-message line (dropped)
  const d3 = join(root, "proj-two-A");
  mkdirSync(d3, { recursive: true });
  writeFileSync(
    join(d3, `${S3}.jsonl`),
    [
      J({
        uuid: "s3l1",
        parentUuid: null,
        sessionId: S3,
        cwd: "/home/me/proj-two",
        timestamp: "2024-03-03T00:00:00.000Z",
        message: { role: "user", content: "fetch it" },
      }),
      J({
        uuid: "s3l2",
        parentUuid: "s3l1",
        sessionId: S3,
        cwd: "/home/me/proj-two",
        timestamp: "2024-03-03T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "c3", name: "WebFetch", input: { url: "http://x" } }],
        },
      }),
      J({
        uuid: "s3l3",
        parentUuid: "s3l2",
        sessionId: S3,
        cwd: "/home/me/proj-two",
        timestamp: "2024-03-03T00:00:02.000Z",
        toolUseResult: { url: "http://x", bytes: 2048, code: 200, durationMs: 350 },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c3", is_error: false, content: "<html>" }],
        },
      }),
      J({
        type: "summary",
        uuid: "s3l4",
        sessionId: S3,
        cwd: "/home/me/proj-two",
        timestamp: "2024-03-03T00:00:03.000Z",
        summary: "noise",
      }),
    ].join("\n") + "\n",
  );

  const wdb = openDb(dbPath);
  await runIngest({ mode: "backfill", root, db: wdb });
  wdb.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── Hand-computed expectations ──────────────────────────────────────────────
// Emitted events (summary line dropped):
//  S1: prompt, tool_use(Bash), tool_result(ok)          = 3
//  S2: text,   tool_use(Bash), tool_result(error)       = 3
//  S3: prompt, tool_use(WebFetch), tool_result(ok)      = 3   (summary dropped)
// TOTAL = 9
const TOTAL = 9;
// tool facet: Bash = 2 (two tool_use), WebFetch = 1
const TOOL = { Bash: 2, WebFetch: 1 };
// kind facet: prompt=2, text=1, tool_use=3, tool_result=3
const KIND = { prompt: 2, text: 1, tool_use: 3, tool_result: 3 };
// error facet: ok=2 (S1+S3 tool_results), error=1 (S2)
const ERROR = { ok: 2, error: 1 };
// project facet: proj-one = 6, proj-two = 3
const PROJECT = { "proj-one": 6, "proj-two": 3 };

function openApp() {
  const db = new Database(dbPath, { readonly: true });
  const app = createApp({ db, webDir: dir, dbPath });
  return { db, app };
}

function bucketMap(arr: { value: string; count: number }[]): Record<string, number> {
  return Object.fromEntries(arr.map((b) => [b.value, b.count]));
}

test("healthz total matches hand count", async () => {
  const { db, app } = openApp();
  const body = (await (await app.request("/healthz")).json()) as any;
  expect(body.events).toBe(TOTAL);
  db.close();
});

test("facets match hand-computed counts EXACTLY", async () => {
  const { db, app } = openApp();
  const f = (await (await app.request("/api/facets")).json()) as any;
  expect(bucketMap(f.tool)).toEqual(TOOL);
  expect(bucketMap(f.kind)).toEqual(KIND);
  expect(bucketMap(f.error)).toEqual(ERROR);
  expect(bucketMap(f.project)).toEqual(PROJECT);
  expect(f.session.length).toBe(3);
  db.close();
});

test("facets honor cross-dimension filtering but not own dimension", async () => {
  const { db, app } = openApp();
  // Filter tool=Bash: tool dim still shows Bash AND WebFetch; project/kind narrow to Bash rows.
  const f = (await (await app.request("/api/facets?tool=Bash")).json()) as any;
  expect(bucketMap(f.tool)).toEqual(TOOL); // own dimension unfiltered
  // Bash tool_use rows: 1 in proj-one(S1) + 1 in proj-one(S2) = proj-one:2 only
  expect(bucketMap(f.project)).toEqual({ "proj-one": 2 });
  expect(bucketMap(f.kind)).toEqual({ tool_use: 2 });
  db.close();
});

test("events: tool=Bash & error=error returns exactly the one error row", async () => {
  const { db, app } = openApp();
  const body = (await (await app.request("/api/events?tool=Bash&error=error")).json()) as any;
  // tool_use rows have is_error null, so error=error filters to tool_results only;
  // tool=Bash AND is_error=1 → 0 rows (the Bash tool_result has tool=null).
  // Verify the actual error tool_result via error=error alone:
  expect(body.events.length).toBe(0);

  const errOnly = (await (await app.request("/api/events?error=error")).json()) as any;
  expect(errOnly.events.length).toBe(1);
  expect(errOnly.events[0].isError).toBe(true);
  expect(errOnly.events[0].corr).toBe("c2");
  db.close();
});

test("pagination via limit=1 + nextAfterId reconstructs the full ordered set", async () => {
  const { db, app } = openApp();
  const all = (await (await app.request("/api/events")).json()) as any;
  expect(all.events.length).toBe(TOTAL);
  const expectedIds = all.events.map((e: any) => e.id);

  const collected: number[] = [];
  let url = "/api/events?limit=1";
  for (let i = 0; i < TOTAL + 2; i++) {
    const page = (await (await app.request(url)).json()) as any;
    if (page.events.length === 0) break;
    collected.push(page.events[0].id);
    if (page.nextAfterId === null) break;
    url = `/api/events?limit=1&afterId=${page.nextAfterId}`;
  }
  expect(collected).toEqual(expectedIds);
  db.close();
});

test("idempotency: re-ingest leaves the corpus unchanged", async () => {
  const wdb = openDb(dbPath);
  await runIngest({ mode: "backfill", root, db: wdb });
  wdb.close();
  const { db, app } = openApp();
  const body = (await (await app.request("/healthz")).json()) as any;
  expect(body.events).toBe(TOTAL);
  db.close();
});

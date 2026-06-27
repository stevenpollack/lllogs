import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLogLines, selectEvents } from "@lllogs/shared";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");

// The launcher spawns `ingest --watch` with LLLOGS_LOG_DIR set + stderr
// dropped so the writer's pino output never corrupts the Ink TTY. This asserts
// that contract on the underlying CLI: with LLLOGS_LOG_DIR set, structured logs
// land in the file and stderr stays clean.
test("ingester logs go to LLLOGS_LOG_DIR, not stderr (TTY stays clean)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lllogs-tui-log-"));
  const db = join(dir, "test.db");
  const root = join(dir, "projects");
  const logDir = join(dir, "logs");
  mkdirSync(root, { recursive: true }); // empty root → backfill still logs start/done

  const proc = Bun.spawn(
    ["bun", "packages/ingest/src/cli.ts", "--backfill", "--db", db, "--root", root],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LLLOGS_LOG_DIR: logDir, LLLOGS_LOG_LEVEL: "info" },
    },
  );
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;

  expect(exit).toBe(0);
  // Pino lines were redirected to the file — none leaked to the terminal.
  expect(stderr).not.toContain('"evt":"ingest');

  const logFile = join(logDir, "ingest.jsonl");
  expect(existsSync(logFile)).toBe(true);
  const entries = parseLogLines(readFileSync(logFile, "utf8"));
  expect(selectEvents(entries, { evt: "ingest.start" }).length).toBeGreaterThan(0);
  expect(selectEvents(entries, { evt: "ingest.done" }).length).toBeGreaterThan(0);
});

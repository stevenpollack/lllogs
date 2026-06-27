// Test-only fixture helpers, shared by the analytics + server (and ingest) test
// suites. Reached via the `@clogdy/shared/testing` subpath (NOT the barrel), so it
// never enters production code or the web bundle. Factored out of ~7 near-identical
// copies of the transcript-line builder + ingest-CLI spawn boilerplate.

import { resolve } from "node:path";

// packages/shared/src → repo root. Test files used `resolve(import.meta.dir, "../../..")`
// from packages/<pkg>/src; this file is one level deeper-equivalent (also packages/*/src).
const REPO_ROOT = resolve(import.meta.dir, "../../..");

/**
 * Build a fixture DB by spawning the ingest CLI as a SEPARATE process over a synthetic
 * transcript tree (ground rule #3 / D-3.b: never import bun:sqlite into a DuckDB-loading
 * test). Throws with the captured CLI output on a non-zero exit.
 */
export function ingestFixture(opts: { root: string; db: string }): void {
  const res = Bun.spawnSync(
    ["bun", "run", "v2:ingest", "--backfill", "--root", opts.root, "--db", opts.db],
    { cwd: REPO_ROOT },
  );
  if (res.exitCode !== 0) {
    throw new Error(
      `ingest CLI failed (exit ${res.exitCode}):\n${res.stderr.toString()}\n${res.stdout.toString()}`,
    );
  }
}

/**
 * Build one Claude-transcript JSONL line in the exact shape `flattenLine` parses.
 * `sessionId`/`cwd` are explicit so callers with multiple sessions/projects pass them;
 * single-session suites bind them once via a thin local wrapper. A line ends up in the
 * DB by field name, so key order here is irrelevant to what gets ingested.
 */
export function transcriptLine(o: {
  uuid: string;
  ts: number;
  content: unknown[];
  sessionId: string;
  cwd: string;
  role?: string;
  toolUseResult?: unknown;
  gitBranch?: string;
}): string {
  return JSON.stringify({
    uuid: o.uuid,
    parentUuid: null,
    sessionId: o.sessionId,
    cwd: o.cwd,
    gitBranch: o.gitBranch ?? "main",
    timestamp: new Date(o.ts).toISOString(),
    type: o.role === "user" ? "user" : "assistant",
    message: { role: o.role ?? "assistant", content: o.content },
    // JSON.stringify drops this key when undefined, matching the old per-file builders.
    toolUseResult: o.toolUseResult,
  });
}

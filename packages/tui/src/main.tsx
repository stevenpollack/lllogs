#!/usr/bin/env bun
/**
 * lllogs v2 live-monitor TUI entry point (`bun run tui`).
 *
 * Co-located, zero-network design: opens the SQLite store READ-ONLY via
 * bun:sqlite and renders the Ink app. By default it also spawns the ingester
 * (`ingest --watch`) as the single writer so a bare `tui` is self-contained
 * — run it over SSH / `docker exec` on the box where the transcripts live.
 *
 * The TUI process loads only bun:sqlite (never DuckDB/Hono), so it can read the
 * live WAL DB while the ingester writes (ground rules #3/#5/#9). The spawned
 * ingester's logs are redirected to a file (LLLOGS_LOG_DIR) AND its stderr is
 * dropped, so its pino output can never corrupt the Ink screen.
 */
import { render } from "ink";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePaths } from "@lllogs/shared";
import { App } from "./App";
import { makeSqliteDataSource } from "./datasource";

interface Args {
  db?: string;
  root?: string;
  noIngest: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { noIngest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--no-ingest") out.noIngest = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const HELP = `lllogs tui — terminal live-monitor for Claude Code tool usage

Usage: bun run tui [options]

  --db <path>     SQLite store (default: $LLLOGS_DB or XDG data dir)
  --root <path>   transcripts root to ingest (default: ~/.claude/projects)
  --no-ingest     don't spawn the ingester (attach to an externally-managed one,
                  e.g. when \`bun start\` is already running on the same DB)
  --help, -h      this help

Keys: ↑↓ move · ←→ scroll columns · ↵ detail · / search · f facets ·
      c columns (show/hide · freeze · sort) · p pause · q quit
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const paths = resolvePaths({ db: args.db, root: args.root });
// packages/tui/src → repo root (where the ingest script lives).
const repoRoot = resolve(import.meta.dir, "..", "..", "..");

let ingester: ReturnType<typeof Bun.spawn> | null = null;
if (!args.noIngest) {
  // Send the writer's structured logs to a file and drop its stderr, so nothing
  // it emits reaches the Ink TTY. LLLOGS_LOG_DIR propagates to the child via env.
  const logDir = join(tmpdir(), "lllogs-tui");
  mkdirSync(logDir, { recursive: true });
  const ingestArgs = ["bun", "run", "ingest", "--", "--watch"];
  if (args.db) ingestArgs.push("--db", args.db);
  if (args.root) ingestArgs.push("--root", args.root);
  ingester = Bun.spawn(ingestArgs, {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, LLLOGS_LOG_DIR: logDir },
  });

  // The ingester's openDb creates + migrates the DB on startup; wait for the file
  // before opening it read-only (fresh DBs don't exist yet).
  const deadline = Date.now() + 10_000;
  while (!existsSync(paths.db) && Date.now() < deadline) await Bun.sleep(100);
}

if (!existsSync(paths.db)) {
  process.stderr.write(
    `lllogs tui: no database at ${paths.db}\n` +
      (args.noIngest
        ? "Run the ingester first:  bun run ingest -- --backfill\n"
        : "The ingester did not create it within 10s — check bun/permissions.\n"),
  );
  ingester?.kill();
  process.exit(1);
}

const db = new Database(paths.db, { readonly: true });

// File-existence isn't a usable-schema signal: the ingester's openDb creates the
// file BEFORE running CREATE TABLE, so wait until the `event` table is actually
// present before the app issues its first query (which would otherwise throw
// "no such table" — the initial load isn't guarded like the facet query is).
const tableReady = (): boolean =>
  db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='event'").get() != null;
{
  const tableDeadline = Date.now() + 10_000;
  while (!tableReady() && Date.now() < tableDeadline) await Bun.sleep(100);
}
if (!tableReady()) {
  process.stderr.write(
    `lllogs tui: database at ${paths.db} has no 'event' table.\n` +
      "Run the ingester first:  bun run ingest -- --backfill\n",
  );
  ingester?.kill();
  db.close();
  process.exit(1);
}

const ds = makeSqliteDataSource(db);

const instance = render(<App ds={ds} />);

// Kill the ingester AND unmount Ink (which resolves waitUntilExit + restores the
// terminal). Registering a SIGTERM listener removes Node's default-terminate, so
// without the unmount the TUI would ignore SIGTERM and orphan itself.
const shutdown = (): void => {
  ingester?.kill();
  instance.unmount();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await instance.waitUntilExit();
ingester?.kill();
db.close();

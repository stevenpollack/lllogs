#!/usr/bin/env bun
// Single entry point for clogdy v2: ensure the web bundle and SQLite DB exist,
// start the live ingester (the writer), then serve the app. Replaces the
// three-step `v2:web:build` + `v2:ingest --backfill` + `v2:serve` dance.
//
// Each stage runs as its own child process via Bun.spawn, so the ground rule
// "SQLite is linked once per process" holds: the ingester child writes via
// bun:sqlite, the server child reads via bun:sqlite, and neither loads DuckDB.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePaths } from "@clogdy/shared";
import { nodeLogger } from "@clogdy/shared/node";

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);
const noWatch = has("--no-watch");
const reset = has("--reset");
const forceBuild = has("--build");
const dev = has("--dev");
if (has("--help") || has("-h")) {
  process.stdout.write(
    `clogdy — investigate & monitor Claude Code tool usage\n\n` +
      `Usage: bun start [options]   (alias: bun run v2)\n\n` +
      `  --dev        rebuild the web bundle on source changes (then refresh)\n` +
      `  --reset      rebuild the DB from scratch before serving\n` +
      `  --no-watch   don't tail for new transcripts (serve a static snapshot)\n` +
      `  --build      force-rebuild the web bundle even if present\n` +
      `  --help       show this help\n\n` +
      `Env: CLOGDY_DB, CLOGDY_ROOT, CLOGDY_PORT (default 7331)\n`,
  );
  process.exit(0);
}

const repoRoot = resolve(import.meta.dir, "../../..");
const paths = resolvePaths({});
const webDistMain = resolve(import.meta.dir, "../../web/dist/main.js");
const log = (msg: string): void => {
  process.stdout.write(`clogdy ▸ ${msg}\n`);
};
// pino logger for structured failure events (the `log` helper above stays the human banner).
const logger = nodeLogger("launcher");

/** Run a child to completion, inheriting stdio; exit the launcher on failure. */
function runToEnd(label: string, cmd: string[]): void {
  const { exitCode } = Bun.spawnSync(cmd, {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (exitCode !== 0) {
    logger.error({ evt: "launcher.child_failed", label, code: exitCode });
    process.exit(exitCode ?? 1);
  }
}

const ingestCli = "packages/ingest/src/cli.ts";

// 1. Web bundle. In --dev a watcher rebuilds it on every source change (build it
//    once up front so first paint is current); otherwise build only if missing.
let webWatcher: ReturnType<typeof Bun.spawn> | null = null;
if (dev) {
  // Block-build only if there's nothing to serve yet; the watcher rebuilds on
  // startup and on every change thereafter.
  if (!existsSync(webDistMain)) {
    log("building web assets…");
    runToEnd("web build", ["bun", "run", "packages/web/build.ts"]);
  }
  log("dev mode: watching web sources — edit + refresh to see changes");
  webWatcher = Bun.spawn(["bun", "run", "packages/web/build.ts", "--watch"], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
} else if (forceBuild || !existsSync(webDistMain)) {
  log("building web assets…");
  runToEnd("web build", ["bun", "run", "packages/web/build.ts"]);
}

// 2. Ensure a COMPLETE DB before serving. Backfill synchronously whenever the DB
//    is missing or --reset was asked for — this both guarantees a full snapshot
//    at first paint and does any reset BEFORE the server opens the DB read-only
//    (the watcher must not rmSync the DB out from under a running server).
const dbMissing = !existsSync(paths.db);
if (reset || dbMissing) {
  log(`ingesting transcripts from ${paths.root}…`);
  const cmd = ["bun", "run", ingestCli, "--backfill"];
  if (reset) cmd.push("--reset");
  runToEnd("ingest", cmd);
}

// 3. Live ingester (writer) — tails for new sessions. The DB already exists (step
//    2 guaranteed it), so no --reset here and no need to wait for file creation.
let watcher: ReturnType<typeof Bun.spawn> | null = null;
if (!noWatch) {
  log("starting live ingester (watching for new transcripts)…");
  watcher = Bun.spawn(["bun", "run", ingestCli, "--watch"], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
}

// 4. Serve (reader). Inherit stdio so its "→ http://localhost:PORT" line shows.
const server = Bun.spawn(["bun", "run", "packages/server/src/serve.ts"], {
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  webWatcher?.kill();
  watcher?.kill();
  server.kill();
};
// Ctrl-C / TERM is a clean stop → exit 0.
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

// Wait on whichever child exits first and propagate its code, so a failed boot
// (e.g. port already in use) surfaces as a non-zero `bun start` exit instead of
// being masked. The watcher dying is unexpected, so note it.
const exits = [server.exited.then((code) => ({ who: "server", code }))];
if (watcher) exits.push(watcher.exited.then((code) => ({ who: "watcher", code })));
const { who, code } = await Promise.race(exits);
if (who === "watcher") {
  logger.warn({ evt: "launcher.ingester_exited", code });
}
shutdown();
process.exit(code ?? 0);

#!/usr/bin/env bun
import { rmSync } from "node:fs";
import { resolvePaths } from "@clogdy/shared";
import { nodeLogger } from "@clogdy/shared/node";
import { openDb } from "./db";
import { runIngest } from "./ingest";

interface Args {
  mode: "backfill" | "watch";
  db?: string;
  root?: string;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "backfill", reset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--backfill") args.mode = "backfill";
    else if (a === "--watch") args.mode = "watch";
    else if (a === "--db") args.db = argv[++i];
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--reset") args.reset = true;
    else {
      process.stderr.write(`v2:ingest: unknown arg ${a}\n`);
      process.exit(1);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolvePaths({ db: args.db, root: args.root });

  const log = nodeLogger("ingest");
  log.info({ evt: "ingest.start", mode: args.mode, root: paths.root, db: paths.db });

  if (args.reset) {
    rmSync(paths.db, { force: true });
    rmSync(`${paths.db}-wal`, { force: true });
    rmSync(`${paths.db}-shm`, { force: true });
  }

  const db = openDb(paths.db);
  let inserted = 0;
  const t0 = performance.now();
  await runIngest({
    db,
    root: paths.root,
    mode: args.mode,
    onProgress: (n) => {
      inserted = n;
    },
    log,
  });

  // Report file count from the cursor table (each touched file has a cursor row).
  const fileCount = (db.query("SELECT COUNT(*) c FROM ingest_cursor").get() as { c: number }).c;
  log.info({
    evt: "ingest.done",
    files: fileCount,
    inserted,
    durMs: Math.round(performance.now() - t0),
  });
  db.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  // The ingest CLI's main() doesn't self-handle (openDb/runIngest can throw),
  // so handle the rejection explicitly instead of leaking an unhandled one.
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePaths } from "@clogdy/shared";
import { nodeLogger } from "@clogdy/shared/node";
import { createApp } from "./app";
import { maxEventId } from "./queries";

const log = nodeLogger("server");
const paths = resolvePaths({});
const db = new Database(paths.db, { readonly: true });
const webDir = resolve(import.meta.dir, "../../web");

if (!existsSync(resolve(webDir, "dist", "main.js"))) {
  log.warn({ evt: "server.web_assets_missing", webDir });
}

const app = createApp({ db, webDir, dbPath: paths.db, log });
const port = Number(process.env.CLOGDY_PORT ?? 7331);

Bun.serve({ port, fetch: app.fetch });
// Boot stats are best-effort: a readonly DB that predates the schema (e.g. `v2:serve` before any
// ingest) has no `event` table, and a COUNT here would crash the just-started server. Log boot
// without counts in that case rather than die on a log line.
let events: number | undefined;
let maxId: number | undefined;
try {
  events = (db.query("SELECT COUNT(*) c FROM event").get() as { c: number }).c;
  maxId = maxEventId(db);
} catch {
  /* schema not present yet */
}
log.info({ evt: "server.boot", port, dbPath: paths.db, events, maxId });
process.stdout.write(`clogdy v2 → http://localhost:${port}\n`);

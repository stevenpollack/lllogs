import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dir` is Bun-only; Playwright's Node loader needs `fileURLToPath`.
const HERE = fileURLToPath(new URL(".", import.meta.url)); // packages/web/e2e/

// The log dir lives UNDER Playwright's outputDir (packages/web/test-results) ON
// PURPOSE. Playwright's built-in "clear output" task wipes outputDir BEFORE the
// webServer boots — and that is the ONLY safe moment to clear, because the server
// opens its pino log file descriptor at boot (sync destination). A later rm (e.g.
// from a globalSetup, which Playwright runs AFTER the webServer) would unlink the
// file out from under the server's open fd: subsequent writes land on the orphaned
// inode and the spec reads an empty file. So we let Playwright clear it for us by
// co-locating LOG_DIR with the other test artifacts. (Both repo-root/test-results
// and packages/web/test-results are gitignored.)
export const LOG_DIR = resolve(HERE, "../test-results/lllogs-logs");
export const SERVER_LOG = resolve(LOG_DIR, "server.jsonl");

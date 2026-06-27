import { mkdirSync } from "node:fs";
import { LOG_DIR } from "./logenv";

// Playwright task order (verified in playwright 1.61 runner `createGlobalSetupTasks`):
//   clear-output  →  webServer boot  →  globalSetup
// So by the time this runs the server has ALREADY opened its sync pino log fd and
// emitted `server.boot`. We therefore must NOT rm the dir here — that would unlink
// the live `server.jsonl` out from under the server's open fd (writes would go to
// the orphaned inode and the spec would read nothing). Stale logs are cleared by
// Playwright's own "clear output" task, which runs BEFORE the webServer because
// LOG_DIR lives under outputDir (see logenv.ts). Here we only ensure the dir exists.
export default function globalSetup(): void {
  mkdirSync(LOG_DIR, { recursive: true });
}

import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_DIR } from "./e2e/logenv";

// Fixture DB + port can be overridden by the orchestrator. The small deterministic
// fixture (2 projects, 3 sessions, Bash/Read/Edit, one error) lives in the scratchpad;
// the 56k demo.db is used for the virtualization/perf specs (T-5.3, T-5.7).
const FIXTURE_DB =
  process.env.LLLOGS_FIXTURE_DB ??
  "/tmp/claude-1000/-home-steven-repos-lllogs/84372ce7-8cc7-4a97-b48e-31328543a00b/scratchpad/fixture.db";
const PORT = Number(process.env.LLLOGS_FIXTURE_PORT ?? 7357);
// `import.meta.dir` is Bun-only; the Playwright CLI loads this config under Node,
// where it is undefined. `fileURLToPath(new URL(".", import.meta.url))` is the dir
// of this file (packages/web/) in BOTH runtimes.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

export default defineConfig({
  testDir: "./e2e",
  // Ensures the log dir exists before the spec reads it. Stale logs are cleared by
  // Playwright's built-in pre-webServer "clear output" task (LOG_DIR is under
  // outputDir); globalSetup runs AFTER the webServer, so it must not clear (see
  // e2e/global-setup.ts). The log-evidence spec (logging.pw.ts) is the only one
  // that reads these files; other specs are unaffected by the env below.
  globalSetup: "./e2e/global-setup.ts",
  // Specs use the `.pw.ts` suffix (NOT `.spec.ts`/`.test.ts`) so Bun's test runner
  // — which the lefthook pre-commit gate invokes as `bun test` — does not discover
  // them and crash importing @playwright/test. Playwright runs them via this match.
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    video: "on",
    screenshot: "on",
    trace: "on",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // serve.ts reads LLLOGS_DB / LLLOGS_PORT from the env (DECISIONS D-5.h), not flags.
    command: "bun run serve",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LLLOGS_DB: FIXTURE_DB,
      LLLOGS_PORT: String(PORT),
      // Make the server-under-test (and the analytics children it spawns, which
      // inherit this env) write structured JSONL the spec asserts on. `debug`
      // captures req.start/req.end, sse.append, analytics.attach, etc.
      LLLOGS_LOG_DIR: LOG_DIR,
      LLLOGS_LOG_LEVEL: "debug",
    },
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

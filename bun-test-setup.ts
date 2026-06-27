// Preloaded before every `bun test` (bunfig.toml → [test].preload).
//
// The in-process server/ingest loggers — and the ingest/analytics CLIs that tests
// spawn, which inherit this env — read CLOGDY_LOG_LEVEL when the logger is built.
// Without this, `bun test` emits info-level JSONL to stderr and clutters the run.
// Default it to "silent" UNLESS a value is already set, so a test (or a developer:
// `CLOGDY_LOG_LEVEL=debug bun test`) can still opt into logs. Tests that assert ON
// logs (e.g. analytics log-purity) pass their own CLOGDY_LOG_LEVEL to the children
// they spawn, so this default never hides what they're checking.
if (!process.env.CLOGDY_LOG_LEVEL) process.env.CLOGDY_LOG_LEVEL = "silent";

export {};

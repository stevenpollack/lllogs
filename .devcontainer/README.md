# lllogs devcontainer — subagent sandbox

A host-isolated dev environment whose purpose is to give **future Claude Code
subagents** a protected place to do development work: edit code, run the Bun
toolchain, and make commits, without touching the host filesystem or host
`~/.claude`.

## What's inside

- **Base:** `mcr.microsoft.com/devcontainers/base:debian`.
- **Bun**, pinned to `1.3.14` (the project's developed-against version), installed
  in the `Dockerfile` via the official install script. This is the project runtime.
- **gh** (GitHub CLI) via devcontainer feature.
- **Claude Code**, installed in `postCreateCommand` via its native installer
  (`curl -fsSL https://claude.ai/install.sh | bash`, no Node). The binary lands at
  `~/.local/bin/claude` and is symlinked into `/usr/local/bin` so it resolves in
  every shell. **No Node runtime** is installed — the whole project runs on Bun.
- `bun install --frozen-lockfile` runs on create so the workspace is ready.

## Supplying the API key

Auth is via the `ANTHROPIC_API_KEY` environment variable — the host `~/.claude` is
**not** bind-mounted.

```bash
cp .devcontainer/.env.example .devcontainer/.env
# edit .devcontainer/.env and set ANTHROPIC_API_KEY=sk-ant-...
```

`devcontainer.json` loads this file with `--env-file`, so the key is injected at
run time. `.devcontainer/.env` is gitignored and the key is never baked into an
image layer. **The container will fail to start if `.devcontainer/.env` is
missing** — create it first.

## Opening the container

- VS Code: "Dev Containers: Reopen in Container".
- CLI: `devcontainer up --workspace-folder .` (or `devcontainer build` to just
  build the image).

## Permission bypass (the container is the sandbox)

Network is **open** and there is no egress firewall — isolation comes from the
container boundary, not from restricting Claude. `postCreateCommand` writes a
**container-scoped** `~/.claude/settings.json`:

```json
{ "permissions": { "defaultMode": "bypassPermissions" } }
```

so `claude` runs with permissions bypassed by default inside the container. This
lives in the container's home dir only — it is **not** the project's checked-in
`.claude/settings.json`, so the host is unaffected. (You can still invoke
explicitly with `claude --dangerously-skip-permissions`.)

## Caveats

- **Commits run the lefthook pre-commit hook** (`bun run check`, `bun test`,
  `bun run format:check`, `bun run lint`). Git and the full Bun toolchain are
  present, so commits work; never use `--no-verify`.
- **DuckDB** (`@duckdb/node-api`) downloads a native binary on `bun install`.
  The open network handles this; it needs glibc (the Debian base provides it).
- **Playwright** e2e specs (`*.pw.ts`) are **not** run by `bun test` and browsers
  are intentionally **not** preinstalled (keeps the image lean). If a subagent
  needs to run the UI e2e suite, install browsers on demand:
  `bunx playwright install --with-deps chromium`.

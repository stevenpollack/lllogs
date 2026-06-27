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

## Supplying the secrets

The sandbox needs **two** secrets, both via env vars — the host `~/.claude` is
**not** bind-mounted:

- `ANTHROPIC_API_KEY` — auth for the `claude` CLI.
- `GH_TOKEN` — auth for the `gh` CLI so the agent can open PRs. Use a
  **fine-grained PAT** scoped to only the repo(s) the sandbox should touch
  (Contents + Pull requests, read/write), with a short expiry — a broad classic
  PAT in a bypass-permissions sandbox has a large blast radius.

```bash
cp .devcontainer/.env.example .devcontainer/.env
# edit .devcontainer/.env and fill in ANTHROPIC_API_KEY and GH_TOKEN
```

`devcontainer.json` loads this file with `--env-file`, so the values are injected
at run time. `.devcontainer/.env` is gitignored and never baked into an image
layer. Two fail-fast guards: **the container won't start if `.devcontainer/.env`
is missing** (Docker's `--env-file`), and **`post-create.sh` aborts if either
secret is empty** — so a half-filled `.env` fails loudly at create time instead
of mid-task. (CI builds with no real secrets and sets
`LLLOGS_SANDBOX_SKIP_SECRET_CHECK=1` to bypass the preflight.)

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

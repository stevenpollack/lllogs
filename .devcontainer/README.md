# lllogs devcontainer — subagent sandbox

A host-isolated dev environment whose purpose is to give **future Claude Code
subagents** a protected place to do development work: edit code, run the Bun
toolchain, and make commits, without touching the host filesystem or host
`~/.claude`.

## Host isolation

The workspace is a **named Docker volume**, not a bind mount of your checkout
(`workspaceMount … type=volume` in `devcontainer.json`). **The host filesystem
is never mounted**, so an agent running inside — even with permissions bypassed —
cannot read, modify, or **delete** any file on your machine. The only host
interaction is `--env-file` reading `.devcontainer/.env` at launch to inject
secrets as env vars (it mounts nothing).

Consequences of this model:

- On first launch, `onCreateCommand` **clones `origin` into the volume** (via
  `gh`, using `GH_TOKEN`). The agent's input is origin's state, **not** your
  local uncommitted working tree.
- The agent's work leaves the sandbox **only via pushed branches / PRs** — there
  is no shared directory to write results back to the host.
- The volume persists across container rebuilds; remove it with
  `docker volume rm lllogs-sandbox-src` to start clean.

CI is the exception: `.github/workflows/devcontainer.yml` uses the CI-variant
config (`.devcontainer/ci/devcontainer.json`), which bind-mounts the runner's
checkout so it tests the PR's actual code. CI runners are disposable, so host
isolation is moot there.

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

The sandbox needs secrets via env vars — the host `~/.claude` is **not**
bind-mounted:

- **Claude auth — exactly one of:**
  - `ANTHROPIC_API_KEY` — Console API key (pay-per-token), **or**
  - `CLAUDE_CODE_OAUTH_TOKEN` — Pro/Max subscription token from `claude
    setup-token` (run once on a machine with a browser; ~1-year token).

  Set **only one**. `ANTHROPIC_API_KEY` outranks the OAuth token, so having both
  lets a stale key silently override a valid subscription token — comment out the
  line you're not using.
- `GH_TOKEN` — auth for the `gh` CLI so the agent can open PRs. Use a
  **fine-grained PAT** scoped to only the repo(s) the sandbox should touch
  (Contents + Pull requests, read/write), with a short expiry — a broad classic
  PAT in a bypass-permissions sandbox has a large blast radius.

```bash
cp .devcontainer/.env.example .devcontainer/.env
# edit .devcontainer/.env: one Claude credential + GH_TOKEN
```

`devcontainer.json` loads this file with `--env-file`, so the values are injected
at run time. `.devcontainer/.env` is gitignored and never baked into an image
layer. Two fail-fast guards: **the container won't start if `.devcontainer/.env`
is missing** (Docker's `--env-file`), and **`post-create.sh` aborts unless
exactly one Claude credential and `GH_TOKEN` are set** — so a half-filled or
double-set `.env` fails loudly at create time instead of mid-task. (The CI
variant has no secrets and no `--env-file`; it sets
`LLLOGS_SANDBOX_SKIP_SECRET_CHECK=1` via `containerEnv` to bypass the preflight.)

## Opening the container

- VS Code: "Dev Containers: Reopen in Container".
- CLI: `devcontainer up --workspace-folder .` (or `devcontainer build` to just
  build the image).

On first launch the empty volume is populated by cloning `origin` (see **Host
isolation**); your host checkout is read for config/secrets but never mounted.

## Permission bypass (the container is the sandbox)

Network is **open** and there is no egress firewall — isolation comes from the
container boundary, not from restricting Claude. `postCreateCommand` writes a
**container-scoped** `~/.claude/settings.json`:

```json
{
  "permissions": { "defaultMode": "bypassPermissions" },
  "skipDangerousModePermissionPrompt": true
}
```

so `claude` runs with permissions bypassed by default inside the container
(`skipDangerousModePermissionPrompt` pre-accepts the one-time dialog so a
headless subagent doesn't block on it at startup). This
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

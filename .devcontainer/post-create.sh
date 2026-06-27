#!/usr/bin/env bash
# Runs once after the container is created (devcontainer postCreateCommand).
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo "${PWD}")"

# 0. Preflight: the sandbox is useless without its secrets, so fail fast (before
#    the slow installs) instead of letting the agent hit a 401 mid-task. Secrets
#    come from .devcontainer/.env via --env-file; see .env.example. CI builds the
#    image with no real secrets (it only runs check/test), so it sets
#    LLLOGS_SANDBOX_SKIP_SECRET_CHECK=1 in the stub .env to skip this.
if [ "${LLLOGS_SANDBOX_SKIP_SECRET_CHECK:-}" != "1" ]; then
  errors=()

  # gh PAT — always required (the agent opens PRs).
  [ -n "${GH_TOKEN:-}" ] || errors+=("GH_TOKEN is empty")

  # Claude auth — exactly one of the API key OR the subscription OAuth token.
  # Both set is a real trap: ANTHROPIC_API_KEY outranks CLAUDE_CODE_OAUTH_TOKEN,
  # so a stale/disabled key silently overrides a valid subscription token.
  claude_creds=0
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then claude_creds=$((claude_creds + 1)); fi
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then claude_creds=$((claude_creds + 1)); fi
  if [ "${claude_creds}" -eq 0 ]; then
    errors+=("set exactly one of ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (neither is set)")
  elif [ "${claude_creds}" -eq 2 ]; then
    errors+=("ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are both set — the API key would override the token; provide only one")
  fi

  if [ "${#errors[@]}" -gt 0 ]; then
    echo "ERROR: devcontainer secret preflight failed:" >&2
    for e in "${errors[@]}"; do echo "  - ${e}" >&2; done
    echo "Fix .devcontainer/.env (see .devcontainer/.env.example), then rebuild." >&2
    exit 1
  fi
fi

# 1. Project dependencies — exact, reproducible install from bun.lock.
bun install --frozen-lockfile

# 2. Claude Code CLI for the subagents that work in this sandbox. The native
#    installer (no Node) drops the binary at ~/.local/bin/claude. Symlink it into
#    /usr/local/bin so it resolves in every shell type (login, non-login, bare
#    `docker run`) — the same approach used for Bun in the Dockerfile.
curl -fsSL https://claude.ai/install.sh | bash
sudo ln -sf "${HOME}/.local/bin/claude" /usr/local/bin/claude

# 3. Container-scoped Claude config: bypass permissions by default. The container
#    IS the sandbox, so this lives in the container's ~/.claude — never in the
#    project's checked-in .claude/settings.json (which would affect the host).
mkdir -p "${HOME}/.claude"
cp ".devcontainer/claude-settings.json" "${HOME}/.claude/settings.json"

echo "post-create complete: bun $(bun --version), claude $(claude --version 2>/dev/null || echo 'installed')"

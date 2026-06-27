#!/usr/bin/env bash
# Runs once after the container is created (devcontainer postCreateCommand).
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo "${PWD}")"

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

# lllogs subagent sandbox image.
#
# Why a Dockerfile instead of a pure feature stack:
#   The project runtime is Bun and it must be pinned to the exact version the
#   repo is developed against (1.3.14). The official Bun install script lets us
#   pin deterministically; community Bun *features* lag releases and add a
#   third-party registry dependency. gh is layered via a devcontainer `feature`
#   in devcontainer.json; the Claude Code CLI is installed via its native
#   (no-Node) installer in post-create.sh — no Node runtime is installed.
FROM mcr.microsoft.com/devcontainers/base:debian

# Keep in sync with the project's developed-against Bun version.
ARG BUN_VERSION=1.3.14

# Install Bun for the non-root `vscode` user (the default user of the base image).
USER vscode
ENV BUN_INSTALL=/home/vscode/.bun
ENV PATH=${BUN_INSTALL}/bin:${PATH}
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && bun --version

# Make Bun resolvable from every shell type (login, non-login, postCreate):
#   - symlink into /usr/local/bin (always on PATH)
#   - profile.d snippet so interactive login shells also see ~/.bun/bin.
USER root
RUN ln -sf ${BUN_INSTALL}/bin/bun /usr/local/bin/bun \
    && ln -sf ${BUN_INSTALL}/bin/bunx /usr/local/bin/bunx \
    && printf 'export BUN_INSTALL=%s\nexport PATH=$BUN_INSTALL/bin:$PATH\n' "${BUN_INSTALL}" \
       > /etc/profile.d/bun.sh

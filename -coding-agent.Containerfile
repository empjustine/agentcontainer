FROM docker.io/library/debian:13-slim AS build-mise

ARG BUILD_DATE

RUN apt-get update && \
apt-get -y --no-install-recommends upgrade && \
apt-get -y --no-install-recommends install curl ca-certificates && \
apt-get autoremove && \
apt-get clean && \
rm -rf /var/lib/apt/lists/*

RUN install -dm 755 /etc/apt/keyrings && \
curl -fSs https://mise.en.dev/gpg-key.pub | tee /etc/apt/keyrings/mise-archive-keyring.asc 1>/dev/null && \
echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.asc] https://mise.en.dev/deb stable main" | tee /etc/apt/sources.list.d/mise.list

FROM docker.io/library/debian:13-slim

ARG BUILD_DATE

RUN apt-get update && \
apt-get -y --no-install-recommends upgrade && \
apt-get -y --no-install-recommends install curl ca-certificates && \
apt-get autoremove && \
apt-get clean && \
rm -rf /var/lib/apt/lists/*

COPY --from=build-mise /etc/apt/keyrings/mise-archive-keyring.asc /etc/apt/keyrings/mise-archive-keyring.asc
COPY --from=build-mise /etc/apt/sources.list.d/mise.list  /etc/apt/sources.list.d/mise.list

# [Junie] ERROR: 'unzip' is required to install Junie, but it was not found in PATH.
# tesseract-ocr \
# tesseract-ocr-eng \
# libtesseract-dev \
# libleptonica-dev \
RUN apt-get update && \
apt-get -y --no-install-recommends upgrade && \
apt-get -y --no-install-recommends install \
git \
build-essential \
ripgrep \
jq \
fd-find \
pkg-config \
unzip \
mise

# && \
# apt-get autoremove && \
# apt-get clean && \
# rm -rf /var/lib/apt/lists/*

# ENV MISE_TMP_DIR=/mise/tmp
# ENV MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS=node

ENV \
MISE_INSTALL_PATH=/usr/local/bin/mise \
UV_INSTALL_DIR=/usr/local/bin \
MISE_DATA_DIR=/mise \
MISE_CONFIG_DIR=/mise \
MISE_CACHE_DIR=/mise/cache \
MISE_STATE_DIR=/mise/state \
\
npm_config_prefix=/npm \
npm_config_cache=/npm/cache \
\
UV_CACHE_DIR=/uv/cache \
UV_TOOL_DIR=/uv/tools \
UV_TOOL_BIN_DIR=/uv/bin \
UV_PYTHON_INSTALL_DIR=/uv/python \
UV_PYTHON_BIN_DIR=/uv/bin \
UV_CREDENTIALS_DIR=/uv/credentials \
\
AUBE_MINIMUM_RELEASE_AGE=10080 \
npm_config_ignore_scripts=true \
npm_config_min_release_age=7 \
pnpm_config_minimum_release_age=10080 \
UV_EXCLUDE_NEWER="7 days" \
\
PATH="/mise/shims:/uv/bin:/npm/bin:/root/.local/share/pnpm:/root/.local/bin:$PATH"

WORKDIR /workspace
RUN git config --global --add safe.directory /workspace && \
mise install --system node@22 node@24 node@26 python@3.12 python@3.14 aube uv && \
mise use --global node@24 python@3.14 aube uv
RUN uv tool install mistral-vibe
# RUN uv tool install ruff
RUN aube add --ignore-scripts --global \
@ast-grep/cli \
@biomejs/biome \
@earendil-works/pi-coding-agent \
@getgrit/cli \
@google/gemini-cli \
@openai/codex
RUN AUBE_LOW_DOWNLOAD_THRESHOLD=800 \
AUBE_TRUST_POLICY_EXCLUDE=\
little-coder@1.8.2,\
@mariozechner/clipboard-darwin-arm64@0.3.6,\
@mariozechner/clipboard-darwin-universal@0.3.6,\
@mariozechner/clipboard-darwin-x64@0.3.6,\
@mariozechner/clipboard-linux-arm64-gnu@0.3.6,\
@mariozechner/clipboard-linux-arm64-gnu@0.3.6,\
@mariozechner/clipboard-linux-arm64-musl@0.3.6,\
@mariozechner/clipboard-linux-riscv64-gnu@0.3.6,\
@mariozechner/clipboard-linux-x64-gnu@0.3.6,\
@mariozechner/clipboard-linux-x64-musl@0.3.6,\
@mariozechner/clipboard-win32-arm64-msvc@0.3.6,\
@mariozechner/clipboard-win32-x64-msvc@0.3.6,\
 \
aube add --ignore-scripts --global little-coder
RUN curl -fsSL https://junie.jetbrains.com/install.sh | bash
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

ENTRYPOINT ["/usr/bin/env"]

CMD ["/bin/bash"]

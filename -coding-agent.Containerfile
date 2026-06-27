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
# build-essential \
# pkg-config \

RUN apt-get update && \
apt-get -y --no-install-recommends upgrade && \
apt-get -y --no-install-recommends install \
git \
ripgrep \
jq \
fd-find \
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
RUN uv tool install hf
RUN uv tool install fastmcp-slim[server]
RUN aube add --ignore-scripts --global @earendil-works/pi-coding-agent
RUN curl -fsSL https://junie.jetbrains.com/install.sh | bash

ENTRYPOINT ["/usr/bin/env"]

CMD ["/bin/bash"]

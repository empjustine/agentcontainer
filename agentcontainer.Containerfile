FROM docker.io/library/debian:13-slim AS base

RUN apt-get update && \
apt-get -y --no-install-recommends upgrade && \
apt-get -y --no-install-recommends install curl ca-certificates && \
apt-get autoremove && \
apt-get clean && \
rm -rf /var/lib/apt/lists/*

FROM base as build-mise

RUN install -dm 755 /etc/apt/keyrings && \
curl -fSs https://mise.en.dev/gpg-key.pub | tee /etc/apt/keyrings/mise-archive-keyring.asc 1>/dev/null && \
echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.asc] https://mise.en.dev/deb stable main" | tee /etc/apt/sources.list.d/mise.list

FROM base

COPY --from=build-mise /etc/apt/keyrings/mise-archive-keyring.asc /etc/apt/keyrings/mise-archive-keyring.asc
COPY --from=build-mise /etc/apt/sources.list.d/mise.list  /etc/apt/sources.list.d/mise.list

RUN apt-get update && \
apt-get -y --no-install-recommends upgrade && \
apt-get -y --no-install-recommends install \
git \
build-essential \
ripgrep \
jq \
fd-find \
tesseract-ocr \
tesseract-ocr-eng \
libtesseract-dev \
libleptonica-dev \
pkg-config \
mise \
&& \
apt-get autoremove && \
apt-get clean && \
rm -rf /var/lib/apt/lists/*

ENV MISE_INSTALL_PATH=/usr/local/bin/mise
ENV UV_INSTALL_DIR=/usr/local/bin

ENV MISE_DATA_DIR=/mise
ENV MISE_CONFIG_DIR=/mise
ENV MISE_CACHE_DIR=/mise/cache
ENV MISE_STATE_DIR=/mise/state
ENV MISE_TMP_DIR=/mise/tmp

ENV npm_config_prefix=/npm
ENV npm_config_cache=/npm/cache

ENV UV_CACHE_DIR=/uv/cache
ENV UV_TOOL_DIR=/uv/tools
ENV UV_TOOL_BIN_DIR=/uv/bin
ENV UV_PYTHON_INSTALL_DIR=/uv/python
ENV UV_PYTHON_BIN_DIR=/uv/bin
ENV UV_CREDENTIALS_DIR=/uv/credentials

# ENV MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS=node

ENV AUBE_MINIMUM_RELEASE_AGE=10080
ENV npm_config_ignore_scripts=true
ENV npm_config_min_release_age=7
ENV pnpm_config_minimum_release_age=10080
ENV UV_EXCLUDE_NEWER="7 days"

ENV PATH="/mise/shims:/uv/bin:/npm/bin:/root/.local/share/pnpm:$PATH"

WORKDIR /workspace

RUN mise install --system node@22 node@24 node@26 python@3.12 python@3.14 aube uv
RUN mise use -g node@24 python@3.14 aube uv
RUN uv tool install mistral-vibe
# RUN uv tool install ruff
RUN aube add --ignore-scripts --global @ast-grep/cli @biomejs/biome @getgrit/cli @earendil-works/pi-coding-agent

ENTRYPOINT ["/usr/bin/env"]

CMD ["/bin/bash"]

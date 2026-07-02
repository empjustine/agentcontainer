FROM docker.io/library/debian:13-slim AS base-debian-slim

ARG BUILD_DATE

RUN apt-get update && \
apt-get -y --no-install-recommends upgrade && \
apt-get -y --no-install-recommends install curl ca-certificates && \
apt-get autoremove && \
apt-get clean && \
rm -rf /var/lib/apt/lists/*

FROM base-debian-slim AS intermediate

RUN install -dm 755 /etc/apt/keyrings && \
curl -fSs https://mise.en.dev/gpg-key.pub | tee /etc/apt/keyrings/mise-archive-keyring.asc 1>/dev/null && \
echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.asc] https://mise.en.dev/deb stable main" | tee /etc/apt/sources.list.d/mise.list
WORKDIR /usr/local/bin
# RUN env \
#   TAG="v0.9.0" \
#   OS="$(uname -s | tr '[:upper:]' '[:lower:]')" \
#   ARCH="$(uname -m | sed -e 's/x86_64/amd64/')" \
#   bash -c 'curl -L "https://github.com/scip-code/scip/releases/download/$TAG/scip-$OS-$ARCH.tar.gz"' \
# | tar xzf - scip

FROM base-debian-slim

COPY --from=intermediate /etc/apt/keyrings/mise-archive-keyring.asc /etc/apt/keyrings/mise-archive-keyring.asc
COPY --from=intermediate /etc/apt/sources.list.d/mise.list  /etc/apt/sources.list.d/mise.list
# COPY --from=intermediate /usr/local/bin/scip /usr/local/bin/scip

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
build-essential \
fd-find \
git \
jq \
mise \
ripgrep \
unzip

# && \
# apt-get autoremove && \
# apt-get clean && \
# rm -rf /var/lib/apt/lists/*

ENV \
AUBE_MINIMUM_RELEASE_AGE=4320 \
npm_config_ignore_scripts=true \
npm_config_min_release_age=3 \
pnpm_config_minimum_release_age=4320 \
UV_EXCLUDE_NEWER="3 days" \
MISE_MINIMUM_RELEASE_AGE="3d" \
\
PATH="/root/.local/bin:/root/.local/share/mise/shims:/root/.local/share/pnpm:$PATH"

WORKDIR /workspace
RUN git config --global --add safe.directory /workspace && \
mise install --system node@22 node@24 python@3.12 python@3.14 uv && \
mise use --global node@24 python@3.14 uv
RUN npm install --global @earendil-works/pi-coding-agent little-coder @ataraxy-labs/sem @ataraxy-labs/weave
RUN curl -fsSL https://junie.jetbrains.com/install.sh | bash

ENTRYPOINT ["/usr/bin/env"]

CMD ["/usr/bin/sleep", "infinity"]

FROM ghcr.io/astral-sh/uv:python3.14-trixie-slim

ARG BUILD_DATE

RUN apt-get update && \
apt-get -y --no-install-recommends upgrade && \
apt-get -y --no-install-recommends install curl ca-certificates && \
apt-get autoremove && \
apt-get clean && \
rm -rf /var/lib/apt/lists/*

RUN UV_EXCLUDE_NEWER="7 days" uv tool install huggingface_hub

WORKDIR /root

ENTRYPOINT ["/usr/bin/env"]
CMD ["/bin/bash"]

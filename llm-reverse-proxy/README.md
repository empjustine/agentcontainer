---
id: llm-reverse-proxy
type: reference
status: stable
title: "llm-reverse-proxy — raw passthrough reverse proxy for cloud LLM providers"
parent: architecture
tags: ["serving", "proxy", "go"]
---

# llm-reverse-proxy

A dumb, faithful reverse proxy for LLM APIs. Zero dependencies, one static Go
binary, ~13 MB RSS. It exists because llama-swap's routing machinery
(model swapping, health checks, key injection) accumulated exceptions when
pi-coding-agent / opencode were pointed at it through `llm-reverse-proxy/`;
llm-reverse-proxy is the substrate llama-swap itself uses internally
(`httputil.ReverseProxy`), extracted and stripped of everything else.

Reference code: upstream llama-swap — github.com/mostlygeek/llama-swap
(`internal/router/peer.go`, `internal/process/process_command.go`; docs tree
`docs/kb/` — the canonical source). A local checkout under
`~/Downloads/references/github/` may exist as a read-only verification cache
on some hosts; it is an optimization, not the reference.

## What it does / does not do

| | |
|---|---|
| ✅ Passes all calls as-is | headers, body, query, method, streaming — byte for byte |
| ✅ Provider prefix routing | `http://host:port/{provider}/<path>?<q>` → `<base-url>/<path>?<q>` |
| ✅ Streaming as-is | `FlushInterval: -1` → every upstream read is flushed immediately; SSE, NDJSON, chunked all arrive at upstream cadence |
| ✅ RFC 9457 errors | internal failures → descriptive `application/problem+json` 502 (see below) |
| ✅ Passthrough of upstream errors | provider 4xx/5xx responses are **not** rewritten |
| ❌ No model routing | the path decides; nothing else |
| ❌ No credential handling | requests must already carry valid provider keys; the proxy never touches `Authorization` |
| ❌ No TLS termination | serve plain HTTP; put it on loopback / tailscale |

## Usage

```console
$ cp llm-reverse-proxy.example.json llm-reverse-proxy.json   # edit providers
$ ./llm-reverse-proxy -config llm-reverse-proxy.json
[llm-reverse-proxy] listening on 0.0.0.0:8080; 6 provider(s):
[llm-reverse-proxy]   /anthropic/ → https://api.anthropic.com
...
```

### Config generation (`generate.sh` / `generate.mjs`)

Since docs/d041 the whole generator is `generate.mjs` (the former
`generate-config.mjs`, with the orchestration folded in — docs/d039 had
already inlined the pi-ai/npm tables); `generate.sh` is its 3-line
`node_run` interpreter shim (same invocation model as the sibling folders):


```console
$ ./generate.sh                       # -> llm-reverse-proxy.json (REPLACED
                                      #    by default; DRY_RUN=1 writes a
                                      #    .dry-run preview instead)
```

The generated table is the UNION of three provider sources with an explicit
priority (docs/d038) — pi-ai's built-in registry (the PI_AI_PROVIDERS table
in generate.mjs; d039 folded it in) > the models.dev/ai-sdk catalog
(lib/models.dev.api.json, `api` field, with the AI_SDK_PACKAGE_ENDPOINTS
table as the fallback for records without one) > crush's catwalk catalog
(lib/catwalk-facts.json, `api_endpoint`). Routes are
keyed by provider NAME: the same name in several sources resolves by
priority; distinct names are all served. A representative excerpt (the full
table is ~220 routes):

```json
{ "listen": "0.0.0.0:8080",
  "providers": {
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta",
    "deepseek": "https://api.deepseek.com",
    "together": "https://api.together.ai/v1",
    "togetherai": "https://api.together.xyz/v1",
    "opencode": "https://opencode.ai/zen/v1",
    "opencode-zen": "https://opencode.ai/zen/v1",
    "cline-pass": "https://api.cline.bot/api/v1",
    "hyper": "https://hyper.charm.land/v1",
    "inferx": "https://model.inferx.net/endpoints/v1",
    "mistral": "https://api.mistral.ai",
    "llama-swap": "http://127.0.0.1:8101",
    "models.dev": "https://models.dev",
    "catwalk": "https://catwalk.charm.land"
  } }
```

The routing convention it locks in — full real base URLs, the 404
anti-oracle answer, the RFC 9457 error design, and the known deviations
from "as-is" — is design rationale, kept in [DESIGN.md](DESIGN.md).
A provider in the fact table but missing from the deployed config is
reported as a dead peer route (its clients simply keep direct/built-in
routing); a deployed upstream that drifted from the fact table is reported
as drift.

## Build & run

Building is the root `./build.sh` → `build.mjs` (docs/d041 — the per-folder
`build.sh` files are gone): container images in parallel on podman/docker
hosts, Termux targets strictly serialized. For THIS folder:

- **Termux**: builds the native `android/arm64` binary
  (`llm-reverse-proxy-android`; `GOOS=android` is required so DNS resolves
  via Android's resolver — flag presets in `lib/go-build.mjs`). Needs
  `pkg install golang`.
- **Container hosts**: builds ONLY the OCI image (`Containerfile`:
  MULTI-STAGE `golang:1.27-alpine` → `distroless/static` — the compile
  happens inside the image build, so no host go toolchain is needed, just
  podman/docker; the image ships the CA bundle upstream TLS verification
  needs and is ~10 MB final). `smoke-test.sh` builds the host binary
  (`./llm-reverse-proxy`) itself when go is available.
- **Bare host without a container tool**: host binary only — go is required,
  it is the only thing this host can build and serve.

`./run.sh` picks the matching serve path: the container branch runs in
HOST NETWORK mode listening on `${HOST_PORT:-8080}` (the funnel front) with
`./llm-reverse-proxy.json` mounted read-only (in-container `-listen
0.0.0.0:$HOST_PORT` overrides the config, like llama-swap's port model) —
host networking is what makes the loopback `llama-swap` upstream reachable
from the container; the native branch execs the binary with
`${LISTEN:-:8080}`. The config path differs by branch: the native branch
reads `./llm-reverse-proxy.json`, the container branch mounts the same file
at `/etc/llm-reverse-proxy/llm-reverse-proxy.json` (both are overridable
with `CONFIG`). The proxy holds no secrets — no vault loader, no env
allowlist; requests must already carry valid provider keys.

### Port model (the conflict with llama-swap, docs/d027)

The tailscale funnel serves the whole `https://bazzite…/<funnel-id>` route
on host port **8080**, so the proxy must own 8080 — the port llama-swap
historically held. The swap: llama-swap moves to **8101** (its container
still listens on 8080 internally; `llm-local-inference/run.sh` publishes
`8101 → 8080`), and the deployed config routes it on loopback:

| path under the funnel | backend | routing |
|---|---|---|
| `/<providerId>` | cloud providers | path prefix → provider's FULL real base URL |
| `/llama-swap/…` | `http://127.0.0.1:8101` | llama-swap (LOCAL GGUF, model-id routing) — the loopback hop never leaves the host |

`./smoke-test.sh` runs 32 behavioural checks — TLS failure classes come from
the badssl.com test hosts, so no bundled cert is needed; that section is
skipped automatically if there is no outbound internet.

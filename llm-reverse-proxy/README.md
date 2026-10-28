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

> **Expansion (docs/d073, mode family revised by docs/d077):** modes A
> (today's host allowlist), B (authenticated generic relay — deferred to
> v3), C (h2 streaming POST — default-on behind `-modes` since d084), D
> (`CONNECT`-over-WebSocket tunnel plus a localhost CONNECT/SOCKS5 relay,
> so clients validate the target's real certificate end-to-end and never
> trust the proxy — the deployed v2 shape), E (h1 POST floor — not built). The
> requirements are d073's; negotiation, the framing contract, and adoption
> gates (spikes) are d077's.

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
$ ./generate.sh                       # -> llm-reverse-proxy.json (atomically
                                      #    REPLACED on success — the change
                                      #    is reviewed with git diff)
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
    "synthetic": "https://api.synthetic.new/openai/v1",
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
reported as a dead route (its clients simply keep direct/built-in
routing); a deployed upstream that drifted from the fact table is reported
as drift.

## Repository boundary (docs/d082)

This folder is the unit that becomes its own repository (docs/d082): code,
scripts, image, and the docs in this folder (README, DESIGN, CI)
travel together. Everything it borrows
from the parent repo arrives through one injectable directory — `LIB_DIR`,
default `../lib` (the node runner for generation, the declarative workload
API for `run.sh`, and the lib modules `generate.mjs` imports) — and the
build stays the root `./build.mjs`'s (docs/d041) until the split. The
decision records that travel with the unit are listed in d082 §1.

## Build & run

Building is the root `./build.sh` → `build.mjs` (docs/d041 — the per-folder
`build.sh` files are gone): container images in parallel on podman/docker
hosts, Termux targets strictly serialized. For THIS folder:

- **Termux**: builds the native `android/arm64` binary
  (`llm-reverse-proxy-android`; `GOOS=android` is required so DNS resolves
  via Android's resolver — flag presets in `lib/go-build.mjs`). Needs
  `pkg install golang`.
- **Container hosts**: builds ONLY the OCI image (`Containerfile`:
  MULTI-STAGE `golang:1.27` → `scratch` — the compile happens inside the
  image build, so no host go toolchain is needed, just podman/docker.
  `scratch` is deliberate: the final stage pulls from NO registry, so the
  image builds where non-docker.io registries are blocked; the image ships
  the CA bundle both TLS legs (upstream certs, Funnel `*.ts.net`) verify
  against and is ~7.5 MB final). `smoke-test.sh` builds the host binary
  (`./llm-reverse-proxy`) itself when go is available.
- **Bare host without a container tool**: host binary only — go is required,
  it is the only thing this host can build and serve.

`./run.sh` picks the matching serve path by two selectors. ROLE —
per docs/d088 the two deployments are named by network position, not
protocol role: the **exit node** (`PROXY_MODE=exit`, the default) has
free, unblocked internet plus tsnet connectivity to the actual LLM
endpoints, and traffic exits the local environment through it; the
**relay node** (`PROXY_MODE=relay`, the loopback CONNECT/SOCKS5 proxy
feeding the tunnel, modes C–E; docs/d073 §7) runs locally on a
restricted-internet environment, without direct tsnet to the endpoints.
The env values and the code speak the same names (d088 phase 2 landed).
HOST:
the container branch runs in HOST NETWORK mode; the native branch execs
the binary directly. Exit node: listening on `${HOST_PORT:-8080}` (the
funnel front) with `./llm-reverse-proxy.json` mounted read-only
(in-container `-listen 0.0.0.0:$HOST_PORT` overrides the config, like
llama-swap's port model) — host networking is what makes the loopback
`llama-swap` upstream reachable from the container; native uses
`${LISTEN:-:8080}`. The config path differs by branch: native reads
`./llm-reverse-proxy.json`, the container mounts it at
`/etc/llm-reverse-proxy/llm-reverse-proxy.json` (both overridable with
`CONFIG`). Relay node: NO config file — `VPN_TUNNEL_URL` (ws/wss; the
path is the Funnel mount plus the fixed `/vpn` — docs/d085) and
`VPN_OPERATOR_TOKEN` are its core surface, with `VPN_CLIENT_LABEL` optional (defaults to the hostname),
`MODES` (transport letters to offer — `cd` by default, docs/d084; `c` is
the built h2 POST mode) and
`PROXY_LISTEN`/`SOCKS_LISTEN` defaulting to `127.0.0.1:3128`/`1080`;
host networking is a requirement there too (the loopback listeners must
be the HOST's loopback — VPN-R23 forbids exposing them — and the tunnel
URL needs the host's tailnet routes). Secrets (env-only — VPN-R32/d078;
run.sh never loads secrets itself): mode A serving holds none — requests
must already carry valid provider keys. An armed exit node
(docs/d084/d085: armed when the env carries the operator keyset) holds the
keyset, and the relay node holds the operator token — all reach the
container only through the run.sh env allowlists.

### Port model (the conflict with llama-swap, docs/d027)

The tailscale funnel serves the whole `https://bazzite…/<funnel-id>` route
on host port **8080**, so the proxy must own 8080 — the port llama-swap
historically held. The swap: llama-swap moves to **8101** (its container
still listens on 8080 internally; `llm-local-inference/run.sh` publishes
`8101 → 8080`), and the deployed config routes it on loopback:

| path under the funnel | backend | routing |
|---|---|---|
| `/<upstream-host>/<path>` | allowlisted hosts only (~36 owner-set rows, docs/d047) | host key → scheme://host root; the client carries the full upstream base path after the host (`<base>/api.cline.bot/api/v1`); every other host is denied by absence |
| `/llama-swap/…` | `http://127.0.0.1:8101` | llama-swap (LOCAL GGUF, model-id routing) — the loopback hop never leaves the host; the one allowlist row keyed by a logical route name instead of its host, so client URLs stay loopback-free |

`./smoke-test.sh` runs 34 behavioural checks in the one and only mode —
the v2 host allowlist (docs/d047) — including the deny-by-absence negatives
(unknown host, v1 slug form) answer the plain funnel 404. TLS failure
classes come from the badssl.com test hosts, so no bundled cert is needed;
that section is skipped automatically if there is no outbound internet.

CI: none exists yet, deliberately — the GitHub Actions findings for
this unit (required steps, runner friction, gate flake points) live in
[CI.md](CI.md), deferred until the d082 split moves the unit to its
own repo.

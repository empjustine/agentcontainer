---
id: estige
type: reference
status: stable
title: "estige — raw passthrough reverse proxy for cloud LLM providers"
parent: architecture
tags: ["serving", "proxy", "go"]
---

# estige

A dumb, faithful reverse proxy for LLM APIs. Zero dependencies, one static Go
binary, ~13 MB RSS. It exists because llama-swap's routing machinery
(model swapping, health checks, key injection) accumulated exceptions when
pi-coding-agent / opencode were pointed at it through `estige/`;
estige is the substrate llama-swap itself uses internally
(`httputil.ReverseProxy`), extracted and stripped of everything else.

> **Expansion (docs/d073; transports and names in docs/d077/d105):** the
> allowlist relay (today's host-allowlist front), the authenticated relay
> (generic prefix-route relay — deferred to v3), and the tunnel transports:
> the h2-POST tunnel (HTTP/2 streaming POST — default-on since d084; the
> `-modes`/`MODES` knob retired by d093, the offer is the constant full
> ladder), the WebSocket tunnel (`CONNECT`-over-WebSocket plus a localhost
> CONNECT/SOCKS5 relay, so clients validate the target's real certificate
> end-to-end and never trust the proxy — the deployed v2 shape), and the
> h1.1-POST tunnel (per-exchange windowing — the floor for
> upgrade-stripping gateways; built with no spike ahead of it, d081's L4
> amendment, and part of the default offer `cde`). The requirements are
> d073's; negotiation, framing, and adoption gates are d077's; the names are
> d105's. L4/L1 characterize the h1.1-POST tunnel's provisional constants
> after the fact; they gate nothing (d081).

Reference code: upstream llama-swap — github.com/mostlygeek/llama-swap
(`internal/router/peer.go`, `internal/process/process_command.go`; docs tree
`docs/kb/` — the canonical source). A local checkout under
`~/Downloads/references/github/` may exist as a read-only verification cache
on some hosts; it is an optimization, not the reference.

## What it does / does not do

| | |
|---|---|
| ✅ Passes all calls as-is | headers, body, query, method, streaming — byte for byte |
| ✅ Host prefix routing | `http://host:port/{upstream-host}/<path>?<q>` → `scheme://<host>/<path>?<q>`, host allowlisted (docs/d047) |
| ✅ Streaming as-is | `FlushInterval: -1` → every upstream read is flushed immediately; SSE, NDJSON, chunked all arrive at upstream cadence |
| ✅ RFC 9457 errors | internal failures → descriptive `application/problem+json` 502 (see below) |
| ✅ Passthrough of upstream errors | provider 4xx/5xx responses are **not** rewritten |
| ❌ No model routing | the path decides; nothing else |
| ❌ No credential handling | requests must already carry valid provider keys; the proxy never touches `Authorization` |
| ❌ No TLS termination | serve plain HTTP; put it on loopback / tailscale |

## Usage

```console
$ cp estige.example.json estige.json   # edit providers
$ ./estige -config estige.json
[estige] listening on 0.0.0.0:8080; 36 allowlisted host(s):
[estige]   /ai-gateway.vercel.sh/ → https://ai-gateway.vercel.sh
...
```

### Config generation (`estige generate` — generate.go)

Since docs/d102 the whole generator is the proxy binary's own `generate`
subcommand, written in Go like the rest of this folder — no node, no shim,
no `LIB_DIR` node runner (the fact table is JSON, so the all-Go generator
and every node generator in the parent repo read the SAME bytes):


```console
$ go run . generate                       # → estige.json (atomically
                                          #    REPLACED on success — the change
                                          #    is reviewed with git diff)
$ ./estige generate                       # same, from a built binary
```

The generated table is the owner set — nothing else is routable
(deny-by-absence, docs/d047): pi-ai's built-in registry (the
`piAiProviders` table in generate.go, extracted from the installed pi —
docs/d039 had folded it in) ∪ the `lib/cloud-providers.json` fact table
(docs/d024 — the hand-added rows, the pi-native set, and the local
llama-swap farm keyed by its tsnet serve hostname) ∪ two static metadata
passthroughs (models.dev, catwalk). Each row contributes ONE allowlist
entry per DISTINCT upstream host, key `host[:port]`, value `scheme://host`
— the host root; base paths belong to the client, which is what lets
multi-base hosts (opencode vs opencode-go) share a row. pi-ai rows with no
single fixed upstream (per-region bedrock, per-project vertex, OAuth
backends) are reported as skips with their reason. A representative
excerpt:

```json
{ "listen": "0.0.0.0:8080",
  "allowHosts": {
    "api.anthropic.com": "https://api.anthropic.com",
    "api.deepseek.com": "https://api.deepseek.com",
    "api.openai.com": "https://api.openai.com",
    "api.cline.bot": "https://api.cline.bot",
    "api.mistral.ai": "https://api.mistral.ai",
    "bazzite.coelacanth-barb.ts.net": "https://bazzite.coelacanth-barb.ts.net",
    "generativelanguage.googleapis.com": "https://generativelanguage.googleapis.com",
    "hyper.charm.land": "https://hyper.charm.land",
    "model.inferx.net": "https://model.inferx.net",
    "opencode.ai": "https://opencode.ai",
    "openrouter.ai": "https://openrouter.ai",
    "token-plan.ap-southeast-1.maas.aliyuncs.com": "https://token-plan.ap-southeast-1.maas.aliyuncs.com",
    "models.dev": "https://models.dev",
    "catwalk.charm.land": "https://catwalk.charm.land"
  } }
```

The routing convention it locks in — full real base URLs, the 404
anti-oracle answer, the RFC 9457 error design, and the known deviations
from "as-is" — is design rationale, kept in [DESIGN.md](DESIGN.md).
A fact-table provider whose host is missing from the deployed config is
reported as a dead host route (its clients simply keep direct/built-in
routing); a deployed host no owner source claims is reported as drift.

## Repository boundary (docs/d082)

This folder is the unit that becomes its own repository (docs/d082): code,
scripts, image, and the docs in this folder (README, DESIGN, CI)
travel together. Everything it borrows
from the parent repo arrives through one injectable directory — `LIB_DIR`,
default `../lib` (the JSON fact table the Go generator reads, and the
declarative workload API for the two `vpn-*.sh` entries) — and the
build stays the root `./build.mjs`'s (docs/d041) until the split. The
decision records that travel with the unit are listed in d082 §1.

## Build & run

Building is the root `./build.sh` → `build.mjs` (docs/d041 — the per-folder
`build.sh` files are gone): container images in parallel on podman/docker
hosts, Termux targets strictly serialized. For THIS folder:

- **Termux**: builds the native `android/arm64` binary
  (`estige-android`; `GOOS=android` is required so DNS resolves
  via Android's resolver — flag presets in `lib/go-build.mjs`). Needs
  `pkg install golang`.
- **Container hosts**: builds ONLY the OCI image (`Containerfile`:
  MULTI-STAGE `golang:1.27` → `scratch` — the compile happens inside the
  image build, so no host go toolchain is needed, just podman/docker.
  `scratch` is deliberate: the final stage pulls from NO registry, so the
  image builds where non-docker.io registries are blocked; the image ships
  the CA bundle both TLS legs (upstream certs, Funnel `*.ts.net`) verify
  against and is ~7.5 MB final). `estige smoke-test` (smoke-test.go) runs
  the behavioural suite against that host binary — no node, curl, or
  python3 on the host (docs/d102).
- **Bare host without a container tool**: host binary only — go is required,
  it is the only thing this host can build and serve.

Each deployment is its own entry point (docs/d095): `./vpn-exit.sh` serves
the exit node, `./vpn-relay.sh` serves the relay node — or, given a target,
acts as the CHAIN STEP that points that target at the relay (below). ROLE —
per docs/d088 the two deployments are named by network position, not
protocol role: the **exit node** has free, unblocked internet plus tsnet
connectivity to the actual LLM endpoints, and traffic exits the local
environment through it; the **relay node** (the loopback CONNECT/SOCKS5
proxy feeding the tunnel transports; docs/d073 §7) runs locally on a
restricted-internet environment, without direct tsnet to the endpoints.
The code speaks the same names (d088 phase 2 landed). HOST:
the container branch runs in HOST NETWORK mode; the native branch execs
the binary directly. Exit node: listening on `${HOST_PORT:-8080}` (the
funnel front) with `./estige.json` mounted read-only
(in-container `-listen 0.0.0.0:$HOST_PORT` overrides the config, like
llama-swap's port model) — host networking is what makes the loopback
`llama-swap` upstream reachable from the container; native uses
`${LISTEN:-:8080}`. The config path differs by branch: native reads
`./estige.json`, the container mounts it at
`/etc/estige/estige.json` (both overridable with
`CONFIG`). Relay node: NO config file — `VPN_TUNNEL_URL` (http(s):// or
ws(s):// — the URL's honest wire form, normalized to wss internally,
docs/d090; the path is the Funnel mount plus the fixed `/vpn` —
docs/d085) and `VPN_OPERATOR_TOKEN` are its core surface, with
`VPN_CLIENT_LABEL` optional (defaults to the hostname) and an OPTIONAL chain
proxy via the conventional variables (`SOCKS_SERVER`
beats a scheme-matched `http_proxy`/`https_proxy`, which beats `ALL_PROXY`;
`SOCKS_VERSION` must be `5`; `NO_PROXY` deliberately not read — docs/d094:
the chain is ONE blind TCP tunnel under the tunnel leg only, `Transport.Proxy`
stays nil, provider requests never touch it),
the transport ladder rides whole — h2-POST → WebSocket → h1.1-POST ranked at
dial time, no `-modes`/`MODES` override (docs/d093) — and
`PROXY_LISTEN`/`SOCKS_LISTEN` defaulting to `127.0.0.1:3128`/`1080`;
host networking is a requirement there too (the loopback listeners must
be the HOST's loopback — VPN-R23 forbids exposing them — and the tunnel
URL needs the host's tailnet routes).

`vpn-relay.sh <target>` is the CHAIN STEP (docs/d095): it ensures the relay
is serving, waits for a health answer naming *this* tunnel, exports the
conventional variables pointing at the loopback listeners, and execs the
target — so `./lib/environment.sh ./estige/vpn-relay.sh
./coding-agent/run.sh` hands the sandbox the loopback spelling while the
relay itself keeps the host's upstream chain (docs/d094). A relay that is
not running is started (detached, `--restart=unless-stopped`); an
unreachable or foreign listener refuses the launch by name. Secrets
(env-only — VPN-R32/d078; the launchers never load secrets themselves): the
allowlist relay holds none — requests must already carry valid provider keys.
An armed exit node (docs/d084/d085: armed when the env carries the operator
keyset) holds the
keyset (`VPN_OPERATOR_KEYS`), and the relay node holds the operator token
(`VPN_OPERATOR_TOKEN`) — disjoint since docs/d090, which retired the
keyset's implicit-`default` merge of the token — and all reach the
container only through the launcher env allowlists.

### Port model (the conflict with llama-swap, docs/d027)

The tailscale funnel serves the whole `https://bazzite…/<funnel-id>` route
on host port **8080**, so the proxy must own 8080 — the port llama-swap
historically held. The swap: llama-swap moves to **8101** (its container
still listens on 8080 internally; `llm-local-inference/run.sh` publishes
`8101 → 8080`), and the deployed config routes it on loopback:

| path under the funnel | backend | routing |
|---|---|---|
| `/<upstream-host>/<path>` | allowlisted hosts only (~36 owner-set rows, docs/d047) | host key → scheme://host root; the client carries the full upstream base path after the host (`<base>/api.cline.bot/api/v1`); every other host is denied by absence |
| `/bazzite…ts.net/<path>` | `https://bazzite.coelacanth-barb.ts.net` | llama-swap (LOCAL GGUF, model-id routing) rides in as a plain fact-table row keyed by its tsnet `tailscale serve` hostname (docs/d070) — the loopback hop never leaves the host |

`./estige smoke-test` runs 34 behavioural checks in the one and only mode —
the v2 host allowlist (docs/d047) — including the deny-by-absence negatives
(unknown host, v1 slug form) answer the plain funnel 404. TLS failure
classes come from the badssl.com test hosts, so no bundled cert is needed;
that section is skipped automatically if there is no outbound internet,
and the child process runs with the proxy env stripped so a host chain
(docs/d094) cannot change what the checks observe.

CI: none exists yet, deliberately — the GitHub Actions findings for
this unit (required steps, runner friction, gate flake points) live in
[CI.md](CI.md), deferred until the d082 split moves the unit to its
own repo.

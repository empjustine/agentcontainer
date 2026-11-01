---
id: estige
type: reference
status: stable
title: "estige — reverse proxy (deprecated in direction) + SSL-VPN tunnel transports"
parent: architecture
tags: ["serving", "proxy", "go"]
---

# estige

> **Deprecated (docs/d108):** the reverse-proxy (allowlist relay, legacy
> "mode A") is deprecated as insecure — a TLS-terminating edge sees plaintext
> provider keys — and estige will stop exposing it (`allowHosts`, host-form
> routing, the generated allowlist). The tunnel transports are the supported
> shape. The reference below describes mode A while the removal diff is
> pending; treat it as a description, not an option.

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
| ⚠️ Host prefix routing | `http://host:port/{upstream-host}/<path>?<q>` → `scheme://<host>/<path>?<q>`, host allowlisted (docs/d047) — legacy "mode A", **deprecated as insecure** (docs/d108) and being removed |
| ✅ Streaming as-is | `FlushInterval: -1` → every upstream read is flushed immediately; SSE, NDJSON, chunked all arrive at upstream cadence |
| ✅ RFC 9457 errors | internal failures → descriptive `application/problem+json` 502 (see below) |
| ✅ Passthrough of upstream errors | provider 4xx/5xx responses are **not** rewritten |
| ❌ No model routing | the path decides; nothing else |
| ❌ No credential handling | requests must already carry valid provider keys; the proxy never touches `Authorization` |
| ❌ No TLS termination | serve plain HTTP; put it on loopback / tailscale |

## Usage

The export face is the tunnel (docs/d073/d104): arm it with the operator
credential from the env chain and run the exit-node entry point.

```console
$ ./lib/environment.sh ./vpn-exit.sh     # exit node; VPN_OPERATOR_KEYS arms the tunnel
[estige] listening on :8080; 0 legacy allowlisted host(s)
```

The funnel points at that port. The relay node (`./vpn-relay.sh`) dials in
over the tunnel and serves the loopback CONNECT/SOCKS5 proxies its clients
use. A node with neither a credential nor an allowlist config refuses to start
rather than accepting connections and answering 404 to everything.

### Configuration: none (docs/d108)

There is no generated config any more. `estige generate` — the subcommand that
emitted `estige.json`'s `allowHosts` table from the pi-ai registry and
`lib/cloud-providers.json` — is deleted with the artifact it wrote: the
allowlist reverse proxy (legacy "mode A") is deprecated as insecure, because a
TLS-terminating proxy at the edge sees the client's provider keys and no
credential scheme fixes that (d073's trust table). Its serving code follows in
the removal diff; the routing semantics it documented stay in
[DESIGN.md](DESIGN.md) as the rationale of a mode being retired.

What an operator still supplies:

- **the tunnel credential** — `VPN_OPERATOR_KEYS` (exit node) /
  `VPN_OPERATOR_TOKEN` (relay node), through the env chain, never through the
  file (docs/d078/d084/d085/d090);
- **egress policy** — `tunnel.egress` in a config file, when the default
  `deny` is not what the deployment wants (docs/d084);
- **nothing else.** `-config` still accepts a hand-written allowlist file so a
  not-yet-migrated host keeps serving; absent, the node serves the tunnel
  alone, which is the supported shape.

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
funnel front, `-listen 0.0.0.0:$HOST_PORT` for the container, `${LISTEN:-:8080}`
for native) — host networking is what makes a loopback upstream reachable from
the container. No config is mounted by default; a file is mounted at
`/etc/estige/estige.json` (native: the same path, both overridable with
`CONFIG`) only when one exists on disk, which now means a leftover allowlist
deployment (docs/d108). Relay node: NO config file — `VPN_TUNNEL_URL` (http(s):// or
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
(env-only — VPN-R32/d078; the launchers never load secrets themselves; the
in-progress d104 credential redesign already moves the tunnel keys into the
on-disk key store): the
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

`./estige smoke-test` runs 34 behavioural checks against the v2 host allowlist
(docs/d047) while that code is still present — including the deny-by-absence negatives
(unknown host, v1 slug form) answer the plain funnel 404. TLS failure
classes come from the badssl.com test hosts, so no bundled cert is needed;
that section is skipped automatically if there is no outbound internet,
and the child process runs with the proxy env stripped so a host chain
(docs/d094) cannot change what the checks observe.

CI: none exists yet, deliberately — the GitHub Actions findings for
this unit (required steps, runner friction, gate flake points) live in
[CI.md](CI.md), deferred until the d082 split moves the unit to its
own repo.

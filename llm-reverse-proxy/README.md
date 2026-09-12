# llm-reverse-proxy

A dumb, faithful reverse proxy for LLM APIs. Zero dependencies, one static Go
binary, ~13 MB RSS. It exists because llama-swap's routing machinery
(model swapping, health checks, key injection) accumulated exceptions when
pi-coding-agent / opencode were pointed at it through `llm-reverse-proxy/`;
llm-reverse-proxy is the substrate llama-swap itself uses internally
(`httputil.ReverseProxy`), extracted and stripped of everything else.

Reference code: `~/Downloads/references/github/mostlygeek/llama-swap/`
(`internal/router/peer.go`, `internal/process/process_command.go`).

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

### Config generation (`generate.sh`)

When this proxy is the fleet's cloud peer (docs/d027), don't hand-maintain
the routing table — generate it with the standard wrapper (same invocation
model as `../coding-agent/generate.sh` and `../llm-local-inference/
generate.sh`; it runs `generate-config.mjs` via `node_run` from
`../lib/workload-runtime.sh`):

```console
$ ./generate.sh                       # -> llm-reverse-proxy.json (REPLACED
                                      #    by default; DRY_RUN=1 writes a
                                      #    .dry-run preview instead)
{ "listen": "0.0.0.0:8080",
  "providers": {
    "openrouter": "https://openrouter.ai/api/v1",
    "opencode": "https://opencode.ai/zen/v1",
    "opencode-go": "https://opencode.ai/zen/go/v1",
    "mistral": "https://api.mistral.ai/v1",
    "cline-pass": "https://api.cline.bot/api/v1",
    "hyper": "https://hyper.charm.land/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta",
    "llama-swap": "http://127.0.0.1:8101",
    "models.dev": "https://models.dev",
    "catwalk": "https://catwalk.charm.land"
  } }
```

The convention it locks in: **the upstream value is the provider's FULL
real base URL** (path suffixes included, exactly the `baseUrl` facts in
lib/cloud-providers.mjs), so a client route is deterministic and trivial —
`<peerBase>/<providerId>` (e.g. peer-mode hyper is
`https://…/<funnel-id>/hyper`). The proxy strips `/<providerId>` and
single-joins the rest onto that base, so every wire dialect the provider
speaks (Google's native generative-ai paths, Mistral's non-completions
endpoints, …) passes through untouched — that is the point of replacing
llama-swap's openai-completions-shaped peer routing (docs/d027). The
coding-agent generators probe exactly these routes
(`<peerBase>/<id>/models`) and emit `<peerBase>/<id>` baseUrls.

A provider in the fact table but missing from the deployed config is
reported as a dead peer route (its clients simply keep direct/built-in
routing); a deployed upstream that drifted from the fact table is reported
as drift.

**Every 404 — `/`, unknown provider prefix, garbage path — is the identical
tailscale-funnel answer**: plain-text `404 page not found` (Go-default body,
`text/plain; charset=utf-8`, `nosniff`). No JSON, no URN, no provider names:
a distinctive body would be a probe oracle confirming custom software lives
here. Known provider prefixes forward normally; internal failures still
return RFC 9457 problem details (see below). Unknown-prefix mistakes are
debugged from the proxy log, which records each such request.

## Error reporting (RFC 9457)

Only failures *inside the proxy* (nothing reached the client yet) produce a
502 problem detail. Example for a dead upstream port:

```json
{
  "type": "urn:llm-reverse-proxy:error:tcp-econnrefused",
  "title": "Nothing is listening on the upstream address (ECONNREFUSED)",
  "status": 502,
  "detail": "while proxying refused/v1/chat/completions to 127.0.0.1:1: dial tcp 127.0.0.1:1: connect: connection refused",
  "code": "tcp-econnrefused",
  "upstream_error": "dial tcp 127.0.0.1:1: connect: connection refused",
  "instance": "/v1/chat/completions"
}
```

Classification is best-effort but the verbatim Go error is always attached as
`upstream_error`. Known codes (TLS classes verified against
[badssl.com](https://badssl.com) hosts, which the smoke test uses directly):

| code | trigger |
|---|---|
| `dns-nxdomain` / `dns-servfail` / `dns-refused` / `dns-timeout` | resolver failures (`*net.DNSError`, resolver address included in detail) |
| `tcp-econnrefused` / `tcp-econnreset` / `tcp-etimedout` / `tcp-netunreachable` / `tcp-hostunreachable` / `tcp-broken-pipe` | OS-level connect/write failures |
| `tls-cert-expired` | expired / not-yet-valid cert (`expired.badssl.com`) |
| `tls-hostname-mismatch` | cert not valid for upstream host (`wrong.host.badssl.com`) |
| `tls-unknown-authority` | unknown CA — covers both self-signed (`self-signed.badssl.com`) and untrusted root (`untrusted-root.badssl.com`); Go's x509 error text is identical for both |
| `tls-self-signed-cert` / `tls-verification-failed` | reserved: matched only if the error text says "self-signed certificate", which Go currently never emits |
| `upstream-timeout` / `upstream-disconnected` / `upstream-error` | transport timeouts, premature close, anything else |

Mid-stream upstream disconnects **cannot** produce a 502 (headers already went
out); the stream is cut the way llama-swap does — the `http.ErrAbortHandler`
panic is recovered and logged. Client-side cancels are logged, never answered.

Go's TLS stack performs no revocation (CRL/OCSP) or pinning checks, so
`revoked.badssl.com` and `pinning-test.badssl.com` stream through with 200 —
faithful passthrough; the upstream's own trust decisions are never pre-empted.

## Known deviations from "as-is"

- Outbound `Host` header is the upstream host (required for SNI/virtual
  hosting).
- Inbound `Forwarded` / `X-Forwarded-*` headers are stripped by
  `httputil.ReverseProxy`'s Rewrite mode (anti-spoofing) and `X-Forwarded-For`
  is not added. LLM providers ignore these.
- Hop-by-hop headers (`Connection`, `Transfer-Encoding`, …) are managed per
  RFC by ReverseProxy — this is required for correctness, not a rewrite.

## Build & run

`./build.sh` is dual-mode, detected from the environment (llama-swap style):

- **Termux**: builds the native `android/arm64` binary
  (`llm-reverse-proxy-android`; `GOOS=android` is required so DNS resolves
  via Android's resolver). Needs `pkg install golang`.
- **Container hosts**: builds ONLY the OCI image (`Containerfile`:
  MULTI-STAGE `golang:1.27-alpine` → `distroless/static` — the compile
  happens inside the image build, so no host go toolchain is needed, just
  podman/docker; the image ships the CA bundle upstream TLS verification
  needs and is ~10 MB final). The host binary (`./llm-reverse-proxy`, used
  by `smoke-test.sh` and direct runs) is a convenience extra: built only
  when go happens to be present, skipped with a warning otherwise
  (`smoke-test.sh` builds it itself when go is available).
- **Bare host without a container tool**: host binary only — go is required,
  it is the only thing this host can build and serve.

`./run.sh` picks the matching serve path: the container branch runs in
HOST NETWORK mode listening on `${HOST_PORT:-8080}` (the funnel front) with
`./llm-reverse-proxy.json` mounted read-only (in-container `-listen
0.0.0.0:$HOST_PORT` overrides the config, like llama-swap's port model) —
host networking is what makes the loopback `llama-swap` upstream reachable
from the container; the native branch execs the binary with
`${LISTEN:-:8080}`. The proxy holds no secrets — no vault loader, no env
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

`./smoke-test.sh` runs 28 behavioural checks — TLS failure classes come from
the badssl.com test hosts, so no bundled cert is needed; that section is
skipped automatically if there is no outbound internet.

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
```

The generated table is the UNION of three provider sources with an explicit
priority (docs/d038) — pi-ai's built-in registry (lib/pi-ai-providers.mjs)
> the models.dev/ai-sdk catalog (lib/models.dev.api.json, `api` field, with
lib/ai-sdk-package-endpoints.mjs as the fallback for records without one) >
crush's catwalk catalog (lib/catwalk-facts.json, `api_endpoint`). Routes are
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

The convention it locks in: **the upstream value is the provider's FULL
real base URL** (path suffixes included — pi's built-in base for pi-ai rows,
the catalog's `api` URL for models.dev/catwalk rows), so a client route is
deterministic and trivial —
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
  "type": "econnrefused",
  "title": "Nothing is listening on the upstream address (ECONNREFUSED)",
  "status": 502,
  "detail": "while proxying refused/v1/chat/completions to 127.0.0.1:1: dial tcp 127.0.0.1:1: connect: connection refused",
  "raw": "dial tcp 127.0.0.1:1: connect: connection refused",
  "instance": "/v1/chat/completions"
}
```

The old `type: "urn:…:error:<code>"` URN and the separate `code` member said
the same thing twice; the type IS the bare cause token now (RFC 9457 resolves
relative type URIs, so this is a valid problem type). Classification is
best-effort but the verbatim Go error is always attached as `raw`, and
error families that have one add a canonical, non-secret dump as `details`
(operator-known facts only: host names, resolver addresses, flag booleans —
never keys or request bodies). Known types (TLS classes verified against
[badssl.com](https://badssl.com) hosts, which the smoke test uses directly):

| type | trigger |
|---|---|
| `dnserror` | any resolver failure (`*net.DNSError`, via `errors.As`); `details` carries the canonical dump (host, resolver, resolver error, timeout/temporary/not-found flags) |
| `econnrefused` / `econnreset` / `epipe` / `enetunreach` / `ehostunreach` / `etimedout` | OS-level connect/write failures (the errno name, unprefixed — the errno already says the family; syscall name + number in `raw`) |
| `tls-verification-failed` | certificate verification failed (`expired.badssl.com`, `wrong.host.badssl.com`, `self-signed.badssl.com`, `untrusted-root.badssl.com`); the x509 sub-cause rides along in `raw` |
| `timeout` / `disconnected` / `upstream-error` | transport timeouts, premature close, anything else |

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

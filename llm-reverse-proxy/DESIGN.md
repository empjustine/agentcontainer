---
id: llm-reverse-proxy-design
type: design
status: stable
title: "llm-reverse-proxy — design: routing convention, 404 policy, error taxonomy"
parent: llm-reverse-proxy
depends-on: [lib]
tags: ["serving", "proxy", "design"]
---

# llm-reverse-proxy — design rationale

Implementation rationale that is not graspable from `main.go` at a glance:
why the routing table looks the way it does, why unknown paths answer the way
they do, and how errors are classified. Operation (usage, build, ports) lives
in the module reference, [README.md](README.md); the requirement statement is
FR-S5 in [../docs/requirements.md](../docs/requirements.md).

## The routing convention: full real base URLs

**The upstream value is the provider's FULL real base URL** (path suffixes
included — pi's built-in base for pi-ai rows, the catalog's `api` URL for
models.dev/catwalk rows), so a client route is deterministic and trivial —
`<peerBase>/<providerId>` (e.g. peer-mode hyper is
`https://…/<funnel-id>/hyper`). The proxy strips `/<providerId>` and
single-joins the rest onto that base, so every wire dialect the provider
speaks (Google's native generative-ai paths, Mistral's non-completions
endpoints, …) passes through untouched — that is the point of replacing
llama-swap's openai-completions-shaped peer routing (docs/d027). The
coding-agent generators probe exactly these routes
(`<peerBase>/<id>/models`) and emit `<peerBase>/<id>` baseUrls.

## The 404 policy: nothing distinctive at the funnel edge

**Every 404 — `/`, unknown provider prefix, garbage path — is the identical
tailscale-funnel answer**: plain-text `404 page not found` (Go-default body,
`text/plain; charset=utf-8`, `nosniff`). No JSON, no URN, no provider names:
a distinctive body would be a probe oracle confirming custom software lives
here. Known provider prefixes forward normally; internal failures still
return RFC 9457 problem details (below). Unknown-prefix mistakes are
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

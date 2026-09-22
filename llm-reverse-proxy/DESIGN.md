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

## The routing convention: host allowlist, client-carried base path (v2, docs/d047)

**The allowlist key is the upstream HOST (DNS name) and the value is its
scheme://host root** — path suffixes move into the CLIENT's base URL, so a
client route is `<peerBase>/<upstream-host><full-upstream-base-path>`
(peer-mode hyper is `https://…/<funnel-id>/hyper.charm.land/v1`). The proxy
strips `/<host>` and single-joins the rest onto the root, so every wire
dialect and every base path the provider speaks passes through untouched —
and hosts that share a DNS name (opencode vs opencode-go on `opencode.ai`,
minimax's `/anthropic` variants) stay routable under ONE allowlist row,
because the distinguishing path belongs to the client that owns it. The
coding-agent generators probe exactly these routes
(`<peerBase>/<host><base>/models`, peerProviderUrl) and emit the same shape
as baseUrls. Hosts NOT in the allowlist are denied by absence — the same
plain funnel 404 as any garbage path; a catalog row can no longer mint a
routable endpoint.

**One row is the exception: the llama-swap loopback learner.** It is keyed
by the stable logical route name `llama-swap` (value still
`http://127.0.0.1:8101`), so client configs never embed a loopback address
in the request path. `peerProviderUrl` emits the same name for it; every
other row keeps `key === host`. The generator's drift check re-states this
exception rather than deriving it from `hostKey` (docs/d047).

There is no other mode: the v1 provider-slug table (`providers`,
`/<providerId>` addressing) is retired — main.go only reads `allowHosts`,
and the generator only emits it (docs/d047).

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

---
id: d073
type: architecture-design
status: proposed
title: "d073 — llm-reverse-proxy → three-mode SSL VPN: requirements and feasibility"
parent: llm-reverse-proxy
depends-on: [llm-reverse-proxy, d027, d047, d070, d071]
references: [d031, d038, d063, d064, d072]
tags: ["serving", "proxy", "vpn", "ssl-vpn", "websocket", "tailscale", "requirements", "proposed"]
---

# d073 — llm-reverse-proxy → three-mode SSL VPN: requirements and feasibility

**Status:** proposed — requirements and feasibility only; no code is decided by
this record. It exists so the question d072 deliberately left open ("a TLS-level
VPN (ssl-vpn style) or a non-HTTP-proxy transport") has a written, checkable
target instead of a sentence in a review. Normative language is RFC 2119
(MUST / SHOULD / MAY). Requirement IDs are `VPN-R*`; when a mode is accepted
they fold into the BRD (docs/requirements.md) as `FR-S*` rows and this record
stays the history of the decision.

## Verdict (the feasibility question, answered)

- **Native HTTP `CONNECT` through Tailscale Funnel is not available.** Funnel's
  HTTP path is a Go `httputil.ReverseProxy` (ingress lives in
  `ipn/ipnlocal/serve.go`); `CONNECT` appears in tailscale/tailscale only in
  internal contexts (the Windows log proxy in `ipnserver/proxyconnect.go`,
  `derper`'s control-plane ACE handling), never as a general user-tunnel
  mechanism. A tunnel mode built on the `CONNECT` method would depend on an
  undocumented behaviour.
- **`CONNECT`-inside-WebSocket is feasible, and is the right shape.** The outer
  hop is an ordinary HTTP `GET` with `Upgrade: websocket` — the one upgrade
  Go's `httputil.ReverseProxy` (and therefore Funnel's serve handler) supports
  natively — and the `CONNECT` semantics ride *inside* the tunnel as an
  application-level control frame, not as the HTTP method. Verified against the
  tailscale/tailscale source via DeepWiki (third-party reading; the spikes re-confirm it on the deployed tailnet before implementation).
- **The certificate property the request asks for holds.** Funnel terminates the
  `wss` leg with its Let's Encrypt `*.ts.net` certificate (a public CA, so
  the client needs no custom trust store), and the *payload* TLS is end-to-end
  between the client and the target host. The local proxy is a blind TCP relay:
  it never holds a certificate for the target, never MITMs, and therefore never
  has to be trusted. That is the whole point of the tunnel over mode B.

## 1. What "SSL VPN" means here — and what it does not

The request is for a **TLS-tunnelled TCP relay** (the sense in which
AnyConnect/OpenVPN/"SSL VPN" appliances are named), **not** IPsec and **not**
an IP-layer tunnel. This record fixes the vocabulary:

- **TLS VPN** = a client opens a TLS-protected connection to a server; inside
  it, the server relays the client's TCP (or UDP) flows to arbitrary
  destinations. The client's own TLS to the destination rides through untouched.
- It is **not** a TUN/TAP interface, **not** IP routing, **not** an exit node.
  No `tun` device, no routes, no DNS server pushed at the IP layer. A client
  configures a proxy address (or SOCKS5) and is done.
- Tailscale already provides the IP-layer VPN for tailnet members; that is not
  what this is. The point of the tunnel is a client that is **not** on the tailnet
  and that **does not trust the proxy host** with its plaintext.

Non-goals (see §11): IPsec, IP-layer tunnels, exit-node replacement, a
multi-tenant SaaS control plane.

## 2. The three modes

One binary, one listener (the Funnel front on :8080, docs/d027), three
independently enabled modes. Mode A is today's behaviour and MUST keep working
unchanged; modes B–E are additive and MUST default OFF.

| | Mode A — allowlist relay (today) | Mode B — authenticated open relay (v3) | Mode D — tunnelled VPN (CONNECT-over-WSS) |
|---|---|---|---|
| Shape | `/<upstream-host>/<path>` | `https://<proxy>/<prefix>/<schema>/<host><path>` | `wss://<proxy>/<prefix>/vpn` + localhost proxy |
| Client software | none | none | a localhost proxy (same binary, client mode) |
| Upstream set | ~36 allowlisted hosts, deny-by-absence (d047) | any host allowed by egress policy | any host allowed by egress policy |
| Auth | the Funnel id is the capability (d070) | path-capability UUID + operator credential | path capability + operator credential on the tunnel |
| Client trusts the proxy with plaintext? | **yes** | **yes** | **no** — blind relay, end-to-end TLS |
| Termination of client TLS | at the Funnel edge (proxy sees plaintext) | at the Funnel edge (proxy sees plaintext) | **at the target** (proxy sees ciphertext) |
| Certificate the client validates | Funnel `*.ts.net` | Funnel `*.ts.net` | Funnel `*.ts.net` for the tunnel **+ the target's real cert end-to-end** |

Delivery is phased (**this revision**): **v2 = mode A + mode D**; mode B is
specified here in full but deferred to **v3**, so the first implementation
carries one protocol and two roles, not three modes.

The trust column is the reason the tunnel exists. In A and B the Funnel edge
terminates the client's TLS and hands the proxy plaintext on loopback, so the
proxy necessarily sees provider keys (it still does not *store* or *inject*
them — the "no credential handling" invariant is about injection, not
visibility). The tunnel removes that property entirely: the proxy sees ciphertext.

**Mode letters (d077).** [d077](d077-ssl-vpn-transport-ladder.md) splits the
tunnel into a protocol-negotiated family on this one path: **Mode C** (h2
POST, preferred), **Mode D** (the `wss://` shape specified here, deployed as
v2), **Mode E** (h1.1 POST stop-and-wait floor) — letters in preference order
C → D → E. This record has been re-lettered to match: what earlier drafts
called mode C is mode D now. Requirements below that govern the *namespace*
(prefix, auth, egress, client, trust) scope the whole C–E family; the
transport-shaped VPN-R11–R14 bind Mode D as written (d077 §9). Modes C and E
are unbuilt and, like mode B, MUST default OFF.

## 3. Mode A — the allowlist relay (unchanged)

Mode A is docs/d047 and MUST NOT regress.

- **VPN-R1** — Mode A MUST remain the default, MUST require no authentication,
  and MUST keep deny-by-absence: every non-allowlisted host and every garbage
  path answers the identical plain-text `404 page not found` (no route table,
  no route names, no fingerprint — llm-reverse-proxy/DESIGN.md's 404
  camouflage policy).
- **VPN-R2** — Enabling modes B–E MUST NOT widen mode A's reachability or
  change its 404 body; A, B, and the tunnel (C–E) are separate route namespaces.
- **VPN-R3** — Mode A's smoke-test surface (llm-reverse-proxy/smoke-test.sh,
  the deny-by-absence 404 negatives included) MUST stay green with modes B–E
  enabled.

## 4. Mode B — the authenticated generic relay (deferred to v3)

Grammar, with every segment's contract:

```
https://${reverse-proxy}/${prefix}/${schema}/${host}${path}
```

Authentication is **two factors for the whole mode-B namespace**: the
`${prefix}` UUID (a path capability, checked first) plus one operator
credential — a shared-secret bearer token. mTLS is not impossible (it would
mean shipping client certificates through the env chain, VPN-R32) but it is
unwieldy for one operator, so it is deferred until a reason appears. There is
no tenant principal — the path is
the only selector, so there is nothing to enumerate.

- `${prefix}` — a high-entropy UUID capability of the mode A funnel-id kind
  (docs/d070), NOT a readable version namespace. It MUST be a distinct UUID
  from the Funnel id, MUST be vault-sourced and never committed, and it is the
  FIRST authentication factor: an unknown prefix answers mode A's camouflage
  404 (VPN-R34) before credential validation or DNS.
- `${schema}` — `http` or `https`: the scheme the proxy uses for the
  **upstream** leg only. Both are allowed: mode B is authenticated, so the
  scheme is an explicit client choice, not a downgrade an attacker can force.
  The client→Funnel leg is always TLS regardless. A request that uses `http`
  MUST still be logged with its scheme, because the upstream leg (headers,
  including any `Authorization`, and body) is plaintext on the wire.
- `${host}` — `host[:port]` (an RFC 3986 authority with no userinfo). It
  MUST be validated (no `@`, no `%2F` tricks, length-bounded, IDN via
  punycode), and it MUST be the SNI/`Host` presented upstream.
- `${path}` — everything after the host segment, byte-for-byte (query and
  body included), the same passthrough contract as mode A.

Requirements:

- **VPN-R4** — Every mode B request MUST be authenticated before any upstream
  DNS resolution or dial: the `${prefix}` capability first, then the operator
  credential. Failure of either MUST produce the same uniform answer
  (VPN-R34).
- **VPN-R5** — Mode B MUST apply the egress policy (§9) before dialing:
  `${schema}` MUST be one of `http`/`https` (both allowed), and the port and
  every resolved address of `${host}` MUST pass.
- **VPN-R6** — Mode B MUST NOT forward the client's proxy credential upstream;
  it MUST strip `Proxy-Authorization`/`Proxy-Connection` and the
  spoofable `Forwarded`/`X-Forwarded-*` headers (the mode A anti-spoofing
  rule), while preserving the upstream `Authorization` (the provider key the
  client owns).
- **VPN-R7** — Mode B MUST rewrite upstream `Location` headers into mode B
  proxy URLs (the same `<prefix>/<schema>/<host><path>` form), so a redirect
  cannot make the client leave the proxy. Absolute URLs are re-encoded; relative
  values are resolved against the upstream URL reconstructed from the
  request's own proxy path (`<schema>` and `<host>` give the origin, `<path>`
  the path), then re-encoded in proxy form. The
  upstream scheme is preserved (an `https` target stays `https`; VPN-R37).
  `Location` is the first member of the compatibility set (VPN-R53).
- **VPN-R8** — Mode B MUST strip `Alt-Svc` from responses (an origin can
  advertise a direct alternate route that bypasses the proxy).
- **VPN-R9** — Mode B MUST keep the RFC 9457 internal-failure taxonomy for
  proxy-side errors (docs/DESIGN.md), and MUST pass upstream 4xx/5xx through
  untouched.
- **VPN-R10** — Mode B MUST log one Combined-Log-Format line per request
  carrying the resolved upstream host and the scheme (never the credential or
  the prefix, VPN-R44).
- **VPN-R55** — Mode B's `https` upstream leg MUST verify chain and hostname
  and MUST fail closed with the RFC 9457 taxonomy (VPN-R9) on verification
  failure. `InsecureSkipVerify` (or any equivalent skip) MUST NOT appear in
  any mode: in A and B the client already trusts this front with plaintext —
  the one party who *can* verify the upstream MUST NOT skip it.

### Compatibility rewrites (the replay-proxy set)

Mode B terminates the client's TLS, so — unlike mode A (byte-faithful) and the tunnel
(mode D, opaque) — it can and must rewrite the headers that would otherwise leak the
client back to the origin or break through the proxy. The reference set is what
archive-replay proxies (pywb, wabac.js/replayweb.page) do to keep a proxied
page working; the table takes the applicable subset and rejects the
archive-specific rest. `Location` rewriting (VPN-R7) is the first member.

| Header | Replay-proxy behaviour (pywb / wabac.js) | Mode B v2 decision |
|---|---|---|
| `Location` | rewritten to the replay URL | **rewrite** to the mode B URL (VPN-R7) |
| `Refresh` | redirect-equivalent | **rewrite** the header; `<meta http-equiv=refresh>` is body-level (v3) |
| `Content-Location` | set/rewritten for fuzzy matches | **drop** (no archive/fuzzy semantics) |
| `Link` (preload/preconnect/dns-prefetch) | Memento links added | **strip** the origin hints — they point the client at the origin |
| `Alt-Svc` | — | **strip** (VPN-R8) |
| `Set-Cookie` `Domain`/`Path` | rewritten by the cookie tracker | **rewrite** `Domain` to the proxy host and prefix `Path`, so auth cookies attach through the proxy |
| `Content-Security-Policy` (+ `-Report-Only`) | rewritten / hardened (replay adds its own) | **strip** — origin-locked CSP blocks proxied subresources and its `report-uri` leaks to the origin |
| `X-Frame-Options`, CSP `frame-ancestors` | removed so replay can frame | **strip** (embedding through the proxy is a mode B use) |
| `Strict-Transport-Security` | — | **strip** — pins the ORIGIN host; wrong and harmful through the proxy |
| `Cross-Origin-Opener-Policy` / `-Embedder-Policy` / `-Resource-Policy` | CORP forced to `cross-origin` in proxy mode | **strip** COOP/COEP; **set** CORP `cross-origin` (matches pywb's proxy mode) |
| `Service-Worker-Allowed` | — | **strip** (scope is origin-relative; SW scripts are body-level, v3) |
| `Access-Control-Allow-Origin` / `-Credentials` / `-Methods` / `-Headers` | `add_access_control_headers` in proxy mode | **handle**: echo the request `Origin`, add `Vary: Origin`, allow credentials |
| `Content-Encoding` / `Transfer-Encoding` | forced decompression when the client cannot accept the encoding (`is_content_rw`) | **no change** for pass-through (ReverseProxy already decodes/streams); **forced decompression** only once body rewriting lands (v3) |
| `WWW-Authenticate` / `Proxy-Authenticate` | deliberately NOT rewritten | **pass through** |
| HTML `href`/`src`/`srcset`/`action`/`poster`, CSS `url()`/`@import`, JS `import()`/string literals, `<base href>`, `document.write`, importmaps | the wabac.js/pywb body rewriter | **deferred to v3** (VPN-R54) — inert for JSON LLM APIs, needed only if mode B ever serves HTML |

- **VPN-R53** — Mode B MUST apply the header-level set above. It MUST NOT apply
  archive-replay semantics (Memento `Link`, fuzzy-match `Content-Location`,
  replay banners): this is a proxy, not a replay.
- **VPN-R54 (v3)** — Body-level URL rewriting (HTML/CSS/JS) is deferred; it is
  required only if mode B ever serves HTML, and it needs forced decompression
  (the pywb `is_content_rw` precedent) to see decoded text.

### Mode B is a BRD-scope change (authentication, not tenancy)

Mode B introduces a path-capability UUID and **one operator credential**,
touching NFR-5 ("no rate limiting, tenancy, or hardening"); rate limiting
itself is deferred to v3 (§16). It does **not** introduce accounts or tenants,
so the Stakeholders "no accounts, no tenants, no trust boundaries" sentence
stays true. It is still a deliberate scope expansion (the current proxy is
unauthenticated), argued here; accepting mode B means amending NFR-5 when the
mode ships (v3). Until then the BRD stands.

## 5. Mode D — the tunnelled VPN (CONNECT-over-WebSocket)

### 5.1 Transport

- **VPN-R11** — The tunnel transport MUST be `wss://<proxy>/<prefix>/vpn`
  through the existing Funnel front. It MUST NOT depend on the HTTP `CONNECT`
  method (VPN verdict above).
  *Transport revision (proposed): [d077](d077-ssl-vpn-transport-ladder.md)
  refines this requirement — v2's tunnel transport remains this `wss://`
  shape (its Mode D), with Mode C (h2 POST) preferred when ALPN offers it
  and Mode E (h1.1 POST) as the stop-and-wait floor for upgrade-stripping
  gateways, the mode chosen by protocol negotiation rather than by path.
  All non-transport requirements stand. R11 binds until d077 is accepted.*
- **VPN-R12** — The server MUST authenticate the tunnel before relaying
  anything. The credential rides an `Authorization` header on the WebSocket
  handshake itself — the handshake is HTTPS, so the credential is protected
  in transit, and an upgrade without valid credentials is rejected with
  mode A's camouflage 404 (VPN-R34) before any `101`. There is no in-protocol
  auth exchange in v2: the client-side proxy is ours, so the browser-client
  and first-frame-auth variants are deliberately out (§12). This also
  satisfies VPN-R39's cheap-rejection rule for the tunnel — an
  unauthenticated upgrade never becomes a hijacked connection.
- **VPN-R13** — The server MUST accept the upgrade via the existing
  `httputil.ReverseProxy` path. The `loggingResponseWriter` wrapper MUST
  keep `Unwrap()` (and therefore `http.NewResponseController`'s hijack)
  reachable, so a `101 Switching Protocols` can be hijacked; this is the same
  wrapper mechanism that already keeps `Flush` working for SSE (see
  main.go's wrapper comment). A 101 regression test is required (S3).
- **VPN-R14** — The tunnel MUST survive Funnel's DERP-relayed path: the protocol
  MUST define an application keepalive/`PING` interval and an idle timeout,
  because the Funnel ingress may reap idle upgraded connections (S1 measures
  the real budget).

### 5.2 Tunnel protocol (application layer)

- **VPN-R15** — The protocol MUST be a small, versioned, documented framing
  (length-prefixed binary frames; a fixed magic/version in the opening
  `HELLO`). It MUST be implementable in Go and Node with no third-party
  dependency, matching the repo's zero-dependency stance (d031 F1).
- **VPN-R16** — Control frames MUST include at least: `HELLO`/`HELLO_OK`
  (magic, version, non-secret **client label** — the label lives here because
  authentication already happened at the handshake, VPN-R12), `CONNECT`
  (host, port), `CONNECTED`, `CONNECT_ERR`, `CLOSE` (with a half-close
  distinction), `PING`/`PONG`. Data frames carry opaque bytes. The client
  label exists so the connection log can attribute *who* (VPN-R19).
- **VPN-R17** — Multiplexing: the v2 MVP opens one `wss` per `CONNECT` (the
  literal "CONNECT-over-WebSocket" shape — simplest to reason about and to
  audit; unmuxed is the accepted v2 choice). A stream-multiplexed single tunnel
  (yamux/smux-style stream ids) is deferred to v3 once connection churn
  matters; the framing MUST reserve a stream id from version 1 so the change is
  additive.
- **VPN-R18** — The relay MUST implement backpressure end-to-end (no unbounded
  per-stream buffering), bounded frame size, and half-close semantics so an
  HTTP request that ends its body but still awaits a response is not torn down.
- **VPN-R19** — The relay MUST NOT inspect, decrypt, buffer, or log payload
  bytes: it stays a blind byte pipe, and the end-to-end TLS is never touched.
  It MUST log the shallow, payload-free metadata the connection lifecycle makes
  available — **who** (the authenticated principal plus the `HELLO` client
  label, never the credential) and **where** (the `CONNECT` target
  `host:port`, the tunnel/prefix, bytes in/out, duration, and outcome).
  Nothing in that log may require reading the stream; this is deliberately
  lower-level data that survives the no-MITM property.

### 5.3 The target connection

- **VPN-R20** — On `CONNECT`, the server MUST resolve `host` itself (remote
  resolution — the client does not resolve), apply the egress policy to every
  resolved address, pin the chosen address, and dial it while presenting the
  client's original `host` as SNI / `Host`. This is what makes the flow a
  VPN rather than a client-side split-DNS arrangement, and it is what prevents
  a DNS-rebinding bypass.
- **VPN-R21** — The server MUST support at least TCP/443 and TCP/80 targets;
  arbitrary ports MUST be governed by the egress policy (§9). UDP is out of
  scope for v2; the assessment and the requirements it would add are §17.
- **VPN-R22** — The client MUST request a target by name so VPN-R20 holds.
  A `CONNECT` whose target host is a literal IP address (the pre-resolved
  form) MUST be rejected with `CONNECT_ERR`: resolution and pinning stay
  server-side, and there is no second path that dials an unchecked address.

## 6. Tunnel client (Modes C–E) — the localhost proxy

- **VPN-R23** — The client is the same binary in a client mode (`-mode client`
  / a `llm-reverse-proxy-client` entry point — one static Go artifact, same
  build, matching d031's zero-dep model). It MUST run with no privileges and
  bind only loopback.
- **VPN-R24** — The client MUST offer an HTTP proxy listener that implements
  `CONNECT host:port` (for `HTTPS_PROXY`), and MUST offer SOCKS5 with
  remote-name resolution (`SOCKS5h`, for `ALL_PROXY` and non-HTTP TCP).
  Plain-HTTP absolute-URI requests MAY be translated into a tunneled HTTP
  exchange; they are not required in v2.
- **VPN-R25** — The client MUST NOT terminate TLS, MUST NOT hold a certificate
  for any target, and MUST NOT be a MITM. Its loopback listener is plaintext
  (an HTTP proxy on `127.0.0.1` needs no certificate; a locally-trusted cert
  is explicitly *not* required).
- **VPN-R26** — The client MUST authenticate to the server with the operator
  credential (from plain env, never a file it manages) and MUST fail closed:
  no credential, no tunnel; no tunnel, no proxying. A "kill switch" behaviour
  (refuse to fall back to a direct connection) SHOULD be the default so a
  dropped tunnel cannot silently leak.
- **VPN-R27** — The client SHOULD expose a health/status surface on loopback
  (tunnel state, last error) so a coding agent's tooling can tell "proxy down"
  from "upstream down".

## 7. Certificates and the trust model

This is the requirement the request centres on. The phrase "the `CONNECT`
should present safe, valid certificates" resolves into two independent
certificates, not one: the **tunnel** leg presents Funnel's valid Let's Encrypt
`*.ts.net` certificate (so no custom trust anchor), and the **payload**
presents the *target's own* valid certificate, validated end-to-end by the
client because the proxy never terminates it. A tunnel mode that presented a
proxy-minted certificate for the target would be a MITM and would violate
VPN-R29. The table below is per-leg for that reason.

| Leg | Mode A | Mode B | Modes C–E (tunnel) |
|---|---|---|---|
| client → Funnel edge | TLS, `*.ts.net` (public CA) | TLS, `*.ts.net` | TLS, `*.ts.net` |
| Funnel edge → proxy (loopback) | plaintext HTTP | plaintext HTTP | plaintext HTTP |
| proxy → upstream | TLS, proxy verifies | TLS, proxy verifies | **payload TLS is client↔upstream** |
| client validates | Funnel cert | Funnel cert | Funnel cert **and** the target's real cert |
| client trusts the proxy? | yes | yes | **no** |

- **VPN-R28** — The tunnel modes (C–E) MUST NOT require the client to install any CA or trust
  anchor beyond the public one Funnel already presents. The tunnel leg uses
  Funnel's Let's Encrypt certificate.
- **VPN-R29** — The tunnel modes (C–E) MUST preserve end-to-end certificate validation: a
  target with an invalid certificate (e.g. `self-signed.badssl.com`) MUST fail
  **at the client**, not at the proxy. This is the acceptance test that proves
  no MITM.
- **VPN-R30** — The proxy MUST NOT need to terminate TLS for any mode. The
  current "no TLS termination" property of llm-reverse-proxy
  (README) is preserved by all of them.

## 8. Authentication and secrets

- **VPN-R31** — Modes B–E MUST authenticate the *operator* (one credential,
  shared by the B and tunnel namespaces alike) and, in mode B, the `${prefix}` path capability;
  never the upstream. Credentials are the proxy's own, distinct from provider
  keys (which stay client-owned and are never injected).
- **VPN-R32** — Secrets MUST arrive through the one explicit chain
  (`./lib/environment.sh`, docs/d046) and be read as plain env. This is a
  real departure from llm-reverse-proxy's current "holds no secrets, no vault
  loader, no env allowlist" stance (d031/d052): accepting B–E means adding the
  proxy to the env-consumer set, with the same allowlist discipline as every
  other runner. The record MUST NOT pretend the stance survives.
- **VPN-R33** — Credential comparison MUST be constant-time; credentials MUST
  NOT appear in logs, the Combined Log Format line, or error bodies.
- **VPN-R34** — An unauthenticated request to the B or tunnel namespace — wrong
  prefix, missing credential, an unauthenticated tunnel upgrade, or any mix —
  MUST answer mode A's camouflage 404: the identical plain-text body, status,
  and Content-Type (VPN-R1). There is deliberately no 401: a uniform 401
  confirms that a second service lives behind the front, which is exactly the
  existence leak the 404 camouflage exists to deny. Uniformity still does the
  anti-oracle work — A, B, and the tunnel are indistinguishable from outside, and the
  namespace boundary is invisible (a B-shaped path with a wrong prefix is
  byte-identical to mode A garbage). Supersedes the draft review's 401
  resolution (§15).

## 9. Egress policy (SSRF and abuse)

Mode B and the tunnel modes accept arbitrary targets by design, so the policy is the security
boundary that deny-by-absence used to be for mode A.

- **VPN-R35** — Default-deny egress: loopback (`127.0.0.0/8`, `::1`),
  link-local (`169.254.0.0/16`, `fe80::/10`), cloud metadata
  (`169.254.169.254`, `fd00:ec2::254`), unspecified (`0.0.0.0`, `::`),
  multicast, and RFC 1918/ULA ranges MUST be denied unless the operator policy
  explicitly allows a CIDR.
- **VPN-R36** — Resolution MUST be pinned and re-checked: policy is applied to
  every resolved address; the dial uses a validated address, not a fresh
  lookup; redirects/rebinds MUST NOT be able to escape the validated set.
- **VPN-R37** — Ports MUST be policy-controlled (default: 80/443). Both
  `${schema}` values are allowed: `http` is not downgrade-gated, because mode
  B is authenticated (VPN-R5) and the client→Funnel leg is TLS in every case.
- **VPN-R38** — The policy MUST be data, not code: the same generated-table
  discipline as `allowHosts` (a reviewed config diff, not a code path).
- **VPN-R39** — Abuse bounds that are not rate limiting: the Funnel front is
  public, so unauthenticated upgrades/requests MUST be rejected cheaply
  (before significant allocation), and the protocol MUST bound frame size and
  idle duration; VPN-R12's handshake-header auth satisfies this for the
  tunnel (no unauthenticated upgrade reaches a `101`). Throughput/concurrency
  budgets are deferred to v3 (VPN-R45..R47).

## 10. Interaction with existing invariants

- **VPN-R40** — The proxy still MUST NOT store or inject provider credentials
  in any mode. The tunnel strengthens this (payload is opaque); modes A/B forward
  client-supplied keys as-is.
- **VPN-R41** — Deny-by-absence (d047) remains mode A's contract; modes B–E
  replace it with authenticated egress policy for their own namespaces only.
  A single config MUST be able to run A-only (today), A+B, A+D, or A+B+D.
- **VPN-R42** — All modes share the one Funnel front / one listener; mode
  dispatch is by PATH for namespaces (A's `/<host>/…`, B's
  `/<prefix>/<schema>/<host><path>`, the tunnel's `/<prefix>/vpn` — which
  serves modes C–E, separated from each other by protocol negotiation, not by
  path: d077 §4). No new hostname, DNS record, or certificate is required. The port model (proxy owns :8080,
  llama-swap on 8101) is unchanged.
- **VPN-R43** — Mode B MUST use the existing single Funnel host: its only
  selector is the `${prefix}` path capability, so no wildcard DNS, wildcard
  certificate, or per-tenant hostname is required. The grammar fits inside the
  route the Funnel already serves to :8080 (docs/d027).
- **VPN-R44** — Each `${prefix}` MUST be a capability key carrying at least
  ~100 bits of captured entropy (a UUID's 122 is the recommended shape),
  distinct from the Funnel id and from each other, vault-sourced through the
  same chain step (VPN-R32), and never committed. Because it is part of
  authentication, the proxy's own access log MUST redact it (the request still
  reaches the Funnel's edge logs, which are capability-bearing by the same
  argument as d070). The tunnel's `${prefix}` (modes C–E) MUST satisfy the same rules with its
  own distinct key.

## 11. Non-goals

- Not IPsec, not an IP-layer tunnel, not a TUN device, not an exit-node
  replacement (Tailscale already owns that).
- Not a UDP tunnel in v2 (assessment in §17).
- Not a multi-tenant SaaS control plane: mode B uses one operator credential
  and one path capability, like every other credential in this repo — no
  accounts, no signup.
- Not a general web proxy for unauthenticated traffic: modes B–E are
  authenticated-only, full stop.
- Not a way to make the proxy hold provider keys: it never does.

## 12. Alternatives considered

- **Native HTTP `CONNECT` through Funnel.** Rejected — Funnel's HTTP path
  does not implement CONNECT tunnelling (Verdict). The WebSocket upgrade is the
  supported primitive.
- **`tailscale funnel --tcp` raw TCP transport.** Funnel supports raw /
  TLS-terminated TCP forwarding on 443/8443/10000, but it is not needed: the
  HTTP front already carries the `wss` upgrade, and raw TCP would move TLS
  termination onto the proxy (VPN-R30).
- **A full TUN/TAP TLS VPN (OpenVPN-shaped).** Rejected — needs root and a
  virtual interface on every client, which defeats "just set `HTTPS_PROXY`",
  and it is the IP-layer model the request explicitly did not ask for.
- **SSH `-D` / SOCKS over the tailnet.** Rejected as the built-in design: it
  requires tailnet membership and an SSH stack on the client, i.e. it is
  strictly more setup than the localhost proxy for the same result, and it does
  not compose with the existing Funnel front.
- **One `wss` per CONNECT vs a muxed tunnel.** Both viable; VPN-R17 picks
  per-CONNECT for v1 and reserves a stream id for the mux.
- **Reusing the Funnel id as the mode B or tunnel prefix or credential.** Rejected —
  the id is already a semi-credential in the base URL (d070) and is shared by
  all clients; the prefix MUST be its own capability UUID (VPN-R44) and the
  credential a distinct, rotatable secret.
- **mTLS as the operator credential.** Deferred, not rejected — it would work
  only by shipping client certificates through the env chain (VPN-R32), which
  is unwieldy for one operator; a shared-secret bearer token carries the same
  single-principal model with none of the transport.
- **In-protocol / browser-client tunnel auth** (first-frame `AUTH` with a
  grace window, or a bearer `Sec-WebSocket-Protocol` subprotocol). Rejected —
  the v2 client is our own localhost proxy and can set a handshake header, so
  a grace window would buy an unauthenticated-connection period for a client
  that does not exist (VPN-R12).

## 13. Spikes (each blocks a decision)

- **S1 — tunnel lifetime through Funnel.** Hold a `wss` open idle for
  30/60 min through the Funnel ingress; measure reaping and required
  keepalive. Blocks VPN-R14 defaults.
- **S2 — streaming through the tunnel.** Measure SSE/NDJSON latency and
  buffering for a tunneled LLM stream against a direct one; confirm the
  `FlushInterval: -1` cadence survives WebSocket framing, and record the
  numbers. There is no performance bar — feasibility, not speed, is the v2
  requirement (§14) — and mode A is the fallback if the numbers are terrible.
- **S3 — 101 hijack through `loggingResponseWriter`.** Prove the wrapper
  lets `ReverseProxy` hijack the connection (VPN-R13) on the pinned Go
  version.
- **S4 — SSRF policy mechanics.** Pick the resolve-pin/redirect approach and
  prove it against metadata/RFC1918/rebinding probes (VPN-R35/36), and settle
  the egress policy artifact's format and home (VPN-R38's "data, not code"
  file).
- **S5 — client distribution.** Same binary in client mode vs a second binary;
  confirm the build matrix (Termux `android/arm64`, container, bare host —
  d031/build.mjs) still yields one artifact per target.
- **S6 — real clients.** `curl -x`, `curl --socks5-hostname`, a browser,
  and a coding agent behind the localhost proxy.

## 14. Acceptance criteria (how we know it works)

Acceptance here is the feasibility and correctness of the v2 shape (A + D),
not a performance bar: S2's numbers are recorded as data, and if tunneled
performance proves terrible in practice, mode A remains the fallback
transport for the same traffic (VPN-R3 keeps it working).

Mode A (regression): the llm-reverse-proxy smoke test stays green, including
the 404 camouflage negatives (VPN-R3).

Mode B (v3 — acceptance applies when the mode ships):
- no credential or wrong prefix → mode A's camouflage 404, byte-identical to
  mode A garbage (VPN-R34);
- `169.254.169.254`, `127.0.0.1`, RFC 1918, and a rebinding name are
  refused (VPN-R35/36);
- `http` to a public host is allowed (authenticated mode B) and reaches
  the upstream; `https` verifies the upstream certificate and fails closed
  on an invalid one (VPN-R55); the request log records which scheme was
  used;
- `Alt-Svc` absent from the response; `Proxy-Authorization` never reaches
  the upstream (VPN-R6/8).

Mode D (tunnel; Modes C/E share this client surface — d077 §5):
- `curl -x http://127.0.0.1:<port> https://api.anthropic.com/v1/models`
  returns the provider's response and
  `openssl s_client -proxy 127.0.0.1:<port> -connect api.anthropic.com:443`
  shows the **real upstream chain**, not a proxy cert (VPN-R29);
- `self-signed.badssl.com` fails **at the client** (VPN-R29);
- `curl --socks5-hostname 127.0.0.1:<port> …` works (VPN-R24);
- a packet capture on the proxy host shows only TLS ciphertext for the
  tunneled stream, and the proxy's logs/config contain no provider key
  (VPN-R19/40);
- the tunnel log records who (principal + client label) and where (target
  `host:port`, bytes in/out, duration, outcome) with no payload
  (VPN-R19);
- killing the tunnel makes the client fail closed, not fall back to direct
  (VPN-R26).

## 15. Draft-review resolutions and open questions

Resolved in the v2 draft review (the requirements above are the record; the
first bullet is superseded by this revision, below):

- **Unauthenticated B–E answers 401** — superseded: the camouflage 404 won
  (VPN-R34).
- **Mode B rewrites `Location`** into its own proxied URLs, and takes the
  applicable replay-proxy compatibility rewrites (§4, VPN-R53).
- **v2 is unmuxed** — one `wss` per `CONNECT` (VPN-R17); the mux is v3.
- **The client proxy lives in `llm-reverse-proxy/`** for v2 — same project,
  same folder (VPN-R23, §18).

Resolved in this revision:

- **Uniform camouflage 404 for unauthenticated B–E** — one byte-string for
  the whole front; a uniform 401 would confirm that a second service lives
  behind it (VPN-R34).
- **Mode B is deferred to v3** — v2 is A + D, so the first implementation is
  one protocol and two roles (§2, §18).
- **The operator credential is a shared-secret bearer token** — mTLS deferred
  as unwieldy, not impossible (§4, §12).
- **Tunnel auth rides the WebSocket handshake header** — the client is our
  localhost proxy, so the browser-client and first-frame-auth variants are
  out (VPN-R12).
- **Prefixes are entropy-bounded keys (~100+ bits captured entropy), the
  tunnel's included** — the property that matters is entropy, not UUID form
  (VPN-R44).
- **Upstream TLS verification is mandatory; `InsecureSkipVerify` is
  forbidden** — the client's blind trust is not to be betrayed further
  (VPN-R55).
- **SOCKS5 is a MUST** on the client (VPN-R24).
- **Relative `Location` resolution is pinned to the upstream URL
  reconstructed from the proxy path** (VPN-R7).
- **Pre-resolved targets are detectable and rejected** — a literal-IP
  `CONNECT` target fails closed (VPN-R22).
- **Acceptance is feasibility, not performance** — S2's numbers are data; if
  they are terrible, mode A is the fallback (§14).

Still open:

- Does the per-CONNECT model hold up under a coding agent's many short
  connections? Measured by S2, judged with mode A as the fallback (§14); the
  muxed tunnel (VPN-R17) is the v3 answer if it does not.
- Body-level URL rewriting (§4, VPN-R54) — needed only if mode B ever serves
  HTML; the header set is enough for the LLM-API use.
- The rename (§18) — decided later, not in this record.

## 16. Deferred to v3: rate limiting and abuse budgets

**Version note:** delivery generations: v2 = mode A (shipped, d047) + mode D
(this record's implementation target); v3 = mode B plus everything deferred
here (mux, body rewriting, rate limiting, UDP). Tunnel-protocol versions are
named explicitly in VPN-R17.

v2 does **not** rate-limit the tunnel modes C–E (v3's mode B is born the same way). The
public front is authenticated, the model is single-user economy (NFR-5), and
no throughput/latency baseline
exists until S2 (streaming through the tunnel) is measured — shipping an
arbitrary budget now would be a guess. The bounds that stay in v2 are the
correctness/DoS ones (cheap rejection of unauthenticated upgrades, bounded
frame size, idle timeout — VPN-R39), not throughput quotas.

The deferred requirements, recorded so they are not lost:

- **VPN-R45 (v3)** — Mode B MUST be rate-limited on requests and bytes (one
  global budget for the operator credential).
- **VPN-R46 (v3)** — Authenticated traffic MUST be capped on concurrent
  tunnels, streams per tunnel, and connect rate.
- **VPN-R47 (v3)** — The budgets MUST be tunable from measured data (metrics
  or log-derived counts), not hard-coded from intuition.

## 17. UDP proxying (assessment; deferred)

VPN-R21 excludes UDP from v2. Two hard facts at the edge force the shape of
any future UDP support:

- **Funnel is TCP-only.** Its ingress accepts `tcp` (`tsnet.ListenFunnel`
  rejects any other network, and `ServeConfig` has only `TCPPortHandler`;
  the one UDP-capable mode is L3 `ServiceConfig.Tun`, which Funnel does not
  expose). There is no UDP ingress to hang a UDP relay on.
- **The serve ingress has no HTTP/2 extended CONNECT (RFC 8441) and no
  CONNECT-UDP / MASQUE (RFC 9298).** The standardized datagram-over-HTTP
  shapes are therefore unavailable, and Funnel has no HTTP/3/UDP path either.

**Consequence:** UDP, if added, must be **datagrams encapsulated in the
existing `wss` tunnel** — an unreliable, unordered message service carried
over a reliable, ordered byte stream. That mismatch is the whole problem, not
an implementation detail.

### What it would require (all deferred to v3)

- **VPN-R48 (v3)** — Tunnel protocol: a UDP association (`UDP_ASSOCIATE`/
  `UDP_ASSOCIATED`/`UDP_CLOSE` control frames) plus length-prefixed
  **datagram frames** carrying `(association id, target host:port, length,
  payload)`. Target addressing is needed because one SOCKS5 UDP association
  multiplexes many targets (a per-flow tunnel avoids it, but DNS makes that
  churny). Datagram boundaries MUST be preserved; SOCKS5 `FRAG` is
  unsupported (`FRAG=0` required); datagrams exceeding the frame cap MUST be
  rejected, not fragmented.
- **VPN-R49 (v3)** — Client: SOCKS5 **UDP ASSOCIATE** on the loopback listener
  (the HTTP `CONNECT` listener cannot carry UDP at all). The client hands the
  application a loopback UDP relay address and tunnels the SOCKS5 UDP request
  headers. Browser/application support for SOCKS5 UDP is sparse — DNS and
  QUIC-aware clients are the realistic consumers.
- **VPN-R50 (v3)** — Server: per-association UDP sockets, reply demux back to
  the association, association lifetime tied to the `wss`, idle timeout.
- **VPN-R51 (v3)** — Egress policy for UDP: the §9 default-deny set, a port
  policy, and **amplification controls** — cap response bytes, rate-limit
  replies, and connect each socket to its target so unsolicited sources cannot
  inject. UDP is a reflection/amplification vector in a way TCP is not.
- **VPN-R52 (v3)** — Semantics: the tunnel's reliability **hides loss and
  reorders delivery**, which distorts the RTT/loss signals QUIC and real-time
  protocols depend on; the relay MUST NOT add UDP-layer retransmission beyond
  TCP's own and MUST document the distortion. On backpressure it MUST **drop
  datagrams, not block the tunnel** (head-of-line blocking across datagrams
  otherwise stalls every flow). VPN-R19's no-payload rule is unchanged
  (metadata-only logs: who, where, bytes, drops).

### Alternatives, all blocked at the edge

- **MASQUE CONNECT-UDP / HTTP/2 extended CONNECT** — not implemented by the
  Funnel ingress.
- **QUIC as the tunnel transport** (RFC 9221 datagrams) — no HTTP/3/UDP
  ingress on Funnel.
- **`funnel --tcp` / Tun-mode L3** — Tun mode is L3 forwarding, not a
  Funnel-exposed UDP relay, and it would reintroduce proxy TLS/certificate
  custody (VPN-R30).

### Value assessment

The compelling case is **tunneled DNS** (avoid a client-side resolver leak and
let the server resolve — which VPN-R20 already does for `CONNECT` targets)
and QUIC/HTTP3. But QUIC over a reliable tunnel is strictly worse than forcing
HTTP/2 (head-of-line blocking defeats QUIC's own loss recovery), and most
applications do not speak SOCKS5 UDP. If DNS is the real need, a DNS-over-TCP
or DoT target on the existing TCP `CONNECT` tunnel is simpler than a UDP
datagram layer — so UDP should be added only if a non-DNS UDP requirement
appears.

## 18. Scope and naming

Everything stays in `llm-reverse-proxy/` — same project, same folder, one
protocol with two roles (VPN-R23): v2 adds the tunnel's client role; v3 adds mode
B. But the module's name no longer describes it. A host allowlist relay, an
authenticated generic relay, and a CONNECT-over-WebSocket tunnel with a
localhost client proxy are a small SSL VPN, not "a reverse proxy". A rename is
expected when the work lands (candidates: a gateway/tunnel name, not a proxy
name); it is deliberately not decided here so the v2 MVP ships under the
existing name and the docs/links churn once.

## Consequences

- If accepted, this record's requirement IDs move into the BRD as `FR-S*`
  rows. The tunnel modes (C–E, v2) update the "no TLS termination" note to "the proxy never
  terminates client TLS — the Funnel edge does, for the tunnel leg, and the
  payload TLS is end-to-end". Mode B (v3) adds NFR-5's authentication
  exception when it is accepted for delivery, and keeps the Stakeholders "no
  tenants" sentence as written.
- llm-reverse-proxy's dependency-free, single-concern shape (d031 F1) is the
  property at risk. Deferring mode B to v3 halves the first increment, but a
  tunnel protocol and a client role are still more than one router. The
  mitigation this record proposes is **one protocol, two roles, one folder**,
  with the mode split in config and the tunnel protocol in its own file — but
  the decision to grow the binary at all is exactly what is being asked here.
- The egress policy (§9) becomes the new security surface. Mode A's
  deny-by-absence is untouched, and the unauthenticated face of B–E is the
  same 404 (VPN-R34); what changes is that an authenticated arbitrary-egress
  namespace exists behind the front, bounded by §9 instead of by
  deny-by-absence.

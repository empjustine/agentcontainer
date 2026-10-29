---
id: d094
type: decision
status: implemented (all three phases landed: record + index, relaychain.go code, relaychain_test.go suite)
title: "d094 — the relay node's tunnel leg chains through the conventional proxy environment variables"
parent: llm-reverse-proxy
depends-on: [d073, d088, d090, d093]
references: [d046, d079]
---

# d094 — the relay node's tunnel leg chains through the conventional proxy env

## Problem

The relay node is defined as the deployment on a restricted-internet
network (d088): its one egress is the tunnel dial to the exit node's URL.
But "restricted" is rarely "nothing works" — the usual reality is a
network where the ONLY way out is somebody else's proxy: a corporate
HTTP proxy, a bastion SOCKS gateway, a sandbox egress filter. Today the
relay node has no answer for that network. Every carrier (the ALPN probe,
modes C/D/E) dials the tunnel host directly, so an environment that
requires a proxy simply cannot deploy a relay node at all — the ladder
ranks transports, not routes, and no rank survives a refused TCP connect.

The obvious fix — http.Transport.Proxy = http.ProxyFromEnvironment —
was deliberately refused (modec.go/modee.go: "Proxy is nil on purpose").
That refusal is right about the wrong thing: the fear was a *forwarding*
proxy that an ambient setting silently hands the bearer to (a cleartext
hop, a credential-visible MITM). It answered that fear by removing the
route, which also removed the deployment. What was missing is the repo's
standing answer to "ambient configuration": the lib/environment.sh law —
an explicit chain step, parsed once, owned here, fail-closed before any
bind (docs/d046).

## Decision

1. **The tunnel leg may ride one chained upstream proxy, declared only
   through the conventional proxy environment variables**, parsed once in
   relayConfigFromEnv (the one configuration path, d072's law) and
   owned entirely by relaychain.go:
   - SOCKS_SERVER (+ SOCKS_VERSION=5) — the explicit SOCKS5 gateway
     spelling (libproxy/GNOME convention). Version unset or 5 is
     accepted; anything else refuses startup (fail-closed, NFR-2).
   - https_proxy/HTTPS_PROXY — the chain for a TLS tunnel URL
     (wss/https); http_proxy/HTTP_PROXY — for a cleartext one
     (ws/http). Both spellings accepted, uppercase first (Go
     httpproxy's order).
   - all_proxy/ALL_PROXY — the catch-all, consulted when the
     scheme-matched variable is unset.
   - Precedence: SOCKS_SERVER > scheme-matched {http,https}_proxy >
     ALL_PROXY. The proxy value's own scheme picks the chain
     protocol: http:// = RFC 9110 CONNECT, socks5:// or socks5h://
     = SOCKS5 (we never resolve locally, which is what socks5h means).
     A bare host:port means http://; SOCKS_SERVER is host:port (or any
     accepted proxy URL). Userinfo becomes Proxy-Authorization (Basic)
     on CONNECT, RFC 1929 credentials on SOCKS5.
   - NO_PROXY is deliberately NOT read: the chain's only destination
     is the tunnel endpoint — one host the operator chose — so the
     correct way to opt out is to unset the proxy variable.

2. **The chain is a blind TCP tunnel, never a forwarding proxy.** Every
   carrier's TCP leg rides one chainProxy.dial — the ALPN probe's,
   mode C's transport, mode D's wsDial, mode E's transport — which dials
   the proxy and completes CONNECT or SOCKS5 by hand, returning a raw
   TCP conn. TLS still happens end-to-end over that conn with the exit
   node's own certificate and system roots (VPN-R28/R55 untouched).
   http.Transport.Proxy stays nil: this is a route, not a policy
   object, and no ambient variable can become one. The chain proxy sees
   SNI and nothing else — the bearer it forwards is opaque bytes.

3. **A cleartext tunnel URL through a chain is accepted, loudly.**
   Refusing would buy nothing: ws:// already assumes every on-path
   observer records the bearer, and a blind CONNECT/SOCKS chain puts the
   proxy operator in exactly that already-assumed position. The startup
   log says so in a warning line; TLS tunnel URLs (the normal case) get
   no such exposure.

4. **Fail-closed at startup, like everything else.** Unparseable proxy
   values, unsupported schemes (https:// to the proxy, socks4, …), a
   missing host, or a non-5 SOCKS_VERSION are relayConfigFromEnv
   errors — before any listener binds (VPN-R26). The startup log names
   the chain (host only, never userinfo); /healthz reports it beside
   the tunnel endpoint.

## Alternatives rejected

- **Transport.Proxy = ProxyFromEnvironment** — ambient, per-transport,
  silently applies to whatever a future refactor dials; for a cleartext
  URL it hands the request (bearer included) to the proxy as a
  forwarding request. The chain belongs in one dial function with one
  parse, not three transports' worth of implicit behavior.
- **A VPN_CHAIN_PROXY-style new spelling** — the point of the chain
  is that the *network* dictates it, and every tool on such a network
  already speaks the conventional variables; inventing a repo-private
  name would guarantee the deployment that works with curl fails with
  us (and d079's proxy-first harnesses depend on the same vars).
- **Resolving NO_PROXY** — one destination, chosen by the operator's
  own VPN_TUNNEL_URL; a suppression list for a single host is a
  second spelling of "unset the variable".
- **TLS-to-proxy (https:// proxy URLs)** — real but rarer; refused
  fail-closed with a named error rather than half-supported. Extension
  point recorded here.

## Phases

1. **This record + index** (this file; README index row; unit README's
   relay-node surface sentence; the relay launcher's header/allowlist —
   `run.sh` at the time, since replaced by `vpn-relay.sh`, docs/d095).
2. **Code** — relaychain.go (parse + chainProxy.dial: CONNECT + SOCKS5
   clients, bounded handshakes, buffered-conn wrapper); relaynode.go
   (config field, tunnelDial() threading into dialTransport, startup
   chain/warning log lines, /healthz chain); modec.go/websocket.go
   (alpnNegotiate/wsDial take the dial func; shared dialTLS); modee.go
   (transport dial); the relay launcher forwards the proxy vars to the
   relay container (`run.sh` then; `vpn-relay.sh` since docs/d095).
3. **Tests** — relaychain_test.go: precedence/version/scheme table on
   relayChainFromEnv; a CONNECT-chain e2e (mode D rides the chain, the
   proxy records the tunnel CONNECT and never a credential); a
   SOCKS5-chain e2e (D-refused → E demotion rides the chain); the ALPN
   probe over a CONNECT chain (mode C's leg). TestMain clears the proxy
   vars for the whole suite — an ambient value must not re-route
   unrelated e2es.

## Acceptance

- On a network whose only route is a proxy: set the conventional vars,
  relay node serves; unset them, it dials direct (existing suite green
  unchanged).
- The chain proxy's recorded view: CONNECT/SOCKS to the tunnel host:port
  only, zero Authorization/Proxy-Authorization unless the operator put
  userinfo in the proxy value itself.
- Bad chain config refuses startup before any bind, naming the variable.
- SOCKS_VERSION=4 and https:// proxy URLs: loud refusal, no fallback.

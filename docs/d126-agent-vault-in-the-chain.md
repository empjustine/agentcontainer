---
id: d126
type: module-design
status: draft
title: "d126 — agent-vault in front of estige: three code gaps, and the workarounds that hold today"
parent: estige
depends-on: [d094, d103, d120]
references: [d073, d108, d123, d127, d129]
tags: ["estige", "agent-vault", "mitm", "proxy-chain", "restricted-network", "findings"]
---

# d126 — agent-vault in front of estige

**Status: draft.** Everything below is a read of the upstream source at
`infisical/agent-vault` — `17b2473 docs: reroute traffic to infisical agent
vault (#462)` — from the local bare mirror
(`~/Downloads/references/github.com/Infisical/agent-vault.git`). No patch has
landed, no build was run, and the gap has not been reproduced against a live
deployment.

**Successor.** The limitations catalogued here are the requirements for a
different product, not a patch to this one: what a brokering proxy on an honest
substrate looks like — no CA, declarative rewrites, h2 carried rather than
brokered — is recorded in [d129](d129-agent-vault-2.md). Nothing here is
superseded; d126 remains the fastest path to putting the *current* vault behind
the chain.

## Problem

The coding agent's containers hold provider keys in their environment, which is
what [d073](d073-ssl-vpn-three-modes.md)'s trust table says a component in the
TLS path must not do. Infisical's **agent-vault** removes that: it is a
credential-injecting MITM forward proxy, so the workload speaks plain HTTPS to
a local proxy and the real secret is added (or swapped) on the upstream leg.
`AGENT_VAULT_*` plus `vault run` also hand the child a CA bundle, so the
workload needs no TLS trust gymnastics of its own.

The deployment we want is a chain, and the order is not free:

```
agent/container → agent-vault (MITM, credential injection)
                → estige relay (blind tunnel client)
                → [tunnel] → estige exit → SSL VPN → corporate proxy → target
```

The MITM must be **innermost** (it terminates TLS between the workload and
itself) and the tunnel **outermost** (estige must never be in the trust path —
[d073](d073-ssl-vpn-three-modes.md), `estige/DESIGN.md`, VPN-R25). That
ordering is what makes the pair compose at all, and it is also why the vault is
the hop that has to learn about a chain: from the vault's position, "the
upstream is not the internet, it is another proxy" is the only new fact.

**The chain does not close today.** The vault's outbound legs do not consult
the ambient proxy environment, so the vault has to dial its targets directly —
which is exactly what a restricted network forbids.

## Finding: the vault's upstream legs do not read proxy env

The repository is asymmetric in a way that hides the gap. Its *control-plane*
legs honor the standard variables; its *data-plane* legs do not.

| Leg | Where | Honors `HTTPS_PROXY`/`ALL_PROXY`? |
| --- | --- | --- |
| Infisical control-plane client | `internal/infisical/client.go` (transport built with `http.ProxyFromEnvironment`) | **yes** |
| OAuth token refresher | `internal/oauth/oauth.go` | **yes** |
| `vault run` / CLI helpers | `cmd/helpers.go` | **yes** |
| **MITM upstream (HTTPS + CONNECT)** | `internal/mitm/proxy.go` `New` — the upstream `http.Transport` sets `DialContext: netguard.SafeDialContext(...)` and carries **no `Proxy` field** | **no** |
| **MITM upstream (WebSocket)** | `internal/mitm/websocket.go` `dialWebSocketUpstream` — dials `outReq.URL.Host` through `p.upstream.DialContext`, so it never consults `Transport.Proxy` even if one were set | **no** |
| Server-side OAuth refresher transport | `internal/server/server.go` — clones `http.DefaultTransport`, then sets `oauthTransport.Proxy = nil` **deliberately**, paired with netguard, as its SSRF posture | **no, on purpose** |

The first three rows make the trap: export `HTTPS_PROXY` on the vault and the
Infisical sync, `/health`, and every `vault run` child all succeed through the
chain — while every *proxied* request dials the target directly. On an open
host the chain then silently looks deployed and isn't; in a restricted network
the proxied traffic hangs or fails with an upstream error that names the target,
not the missing hop. That asymmetry is the whole finding, and it is why "set the
env and see if it works" is not a test.

## Gap catalogue

Each gap is a separate obstacle with a separate workaround; only the first is
code.

### G1 — no upstream proxy support on the data plane (blocking, code)

Three call sites, one missing concept: a chain-aware **dial** seam. Not
`Transport.Proxy` — Go's `ProxyFromEnvironment` cannot express a SOCKS5 chain,
skips localhost/`NO_PROXY` destinations by design, does not fail closed at
startup, and would not cover the WebSocket path anyway
([d094](d094-relay-chain-proxy.md) rejected the same shape for the relay and
for the same reasons).

### G2 — the vault's own SSRF guard blocks the loopback hop (config)

`internal/netguard/netguard.go`'s `SafeDialContext` blocks private and reserved
ranges by default; the allowlist is read from `AGENT_VAULT_NETWORK_ALLOWLIST`
**only when** `AGENT_VAULT_ALLOW_PRIVATE_RANGES` is not set. So pointing the
vault's upstream at a proxy on `127.0.0.1` needs the narrow knob
(`AGENT_VAULT_NETWORK_ALLOWLIST=127.0.0.1/32`), not the broad one — see the
rejected alternatives.

### G3 — the relay's listeners are structurally loopback-only (deployment)

`estige/relaynode.go`'s `requireLoopback` refuses any non-loopback listen
address (VPN-R23 is made structural, not configurable), and `handleSOCKS` says
why it carries no credential: *"the listener is loopback-only, VPN-R23 — a
credential check here would be theater."* Consequence: the only way the vault
reaches the relay is **sharing its network namespace**. Two shapes, both fine:

- podman `--network container:<relay>` (the vault joins the relay's netns), or
- systemd `JoinsNamespaceOf=` / `NetworkNamespacePath=` on the vault unit.

Note the direction of the safety argument: the vault may bind a non-loopback
address (`--host`, default `127.0.0.1`), but it *must* be loopback-bound when it
shares a namespace with a listener that has no credential check of its own.

### G4 — three environment scopes, and the relay refuses to chain to itself

`relaychain.go` resolves the relay's own chain and refuses startup when that
chain names the relay's own listener (`errSelfChained`, mapped to exit **94** in
`main.go`). A single shared environment therefore cannot work: the vault needs
`HTTPS_PROXY` pointing at the relay's loopback listener while the relay needs
`HTTPS_PROXY` pointing at the corporate proxy, and merged they trip the
self-chain guard.

| scope | `HTTPS_PROXY` / chain vars | other |
| --- | --- | --- |
| `estige-relay.service` | the corporate proxy, or `SOCKS_SERVER`+`SOCKS_VERSION=5` | tunnel/exit identity per [d104](d104-mutual-exit-relay-credential.md), `PROXY_LISTEN`, `SOCKS_LISTEN` |
| agent-vault server | `http://127.0.0.1:<relay-proxy-port>` | `AGENT_VAULT_MASTER_PASSWORD`, `AGENT_VAULT_NETWORK_ALLOWLIST=127.0.0.1/32`, `--host`, `--mitm-port 14322` |
| agent / `vault run` child | the vault's `:14322` | `AGENT_VAULT_ADDR`, the vault token, the CA vars `vault run` exports |

### G5 — the exit's egress policy is `:80`/`:443`

`estige/egress.go`'s `defaultEgressPorts` is `{80, 443}` with private/metadata
ranges denied, and the operator opts ranges and ports in through
`VPN_TUNNEL_EGRESS` (`allowCidrs`/`ports`, refused when all-empty per
[d123](d123-go-suite-in-the-sweep.md)). SMTP `:587`, Postgres `:5432`, or a
private-IP store therefore needs an explicit opt-in, and the vault's own
credential endpoints are subject to the same policy as anything else in the
tunnel.

### G6 — the chain is exactly one hop (prerequisite, not a gap in either codebase)

[d094](d094-relay-chain-proxy.md) gives the relay **one** chain hop: one `http`
(CONNECT) or one `socks5` endpoint, resolved at startup, fail-closed. The
corporate proxy is therefore the hop estige must consume, which means the SSL
VPN has to terminate *locally* (a tun/route, or a localhost SOCKS5 the relay
dials) rather than be consumed as `HTTPS_PROXY` — otherwise two proxies compete
for one slot. Confirm the corporate proxy also permits
`CONNECT <exit-host>:<port>` toward the funnel, not only plain HTTPS origins.

### G7 — credentials are minted, never captured (code, by design)

The vault maintains a genuinely *current* credential — the credential's stored
value **is** the live access token (`UpdateCredentialOAuthTokens` writes it into
`credentials.ciphertext`), with expiry, refresh token and client credentials in
the companion `credential_oauth` row (`internal/store/sql_store.go`). Injection
re-resolves it at request time, so every rule naming that key (`auth.type` or a
`__name__` substitution) follows the rotation with no agent involvement. What it
cannot do is **derive** a credential from traffic: the only two grants
implemented are `authorization_code` and `refresh_token`
(`internal/oauth/oauth.go`), and the response path has no rewrite or capture
hook at all — `internal/mitm/forward.go` streams `resp.Body` through and touches
response headers only to strip hop-by-hop fields.

That rules out brokering a legacy **Resource Owner Password** (ROPC) IdP the
obvious way. Injecting the password leg is easy (a `body`-surface substitution
on the token endpoint); the problem is the *return* leg — the token comes back
in the response, the vault does not look, so it lands in the agent's process and
layer 2 leaks anyway. Two smaller traps compound it: ROPC frequently returns no
refresh token, and `internal/brokercore/credential.go` returns early when
`RefreshTokenCT` is empty, so such a token can never be renewed; and `ROPC` is
absent from the design rather than merely unimplemented, because adopting "the
credential is whatever JSON the upstream just returned" would let the agent
poison its own token by pointing a request at a responder of its choosing.

The shape that works is to let the **vault** drive the grant (`password` added
alongside `Refresh`, reusing the 5-minute buffer, the singleflight refresher and
the existing 401 retry), or to mint out-of-band and deposit into token-upload
mode (`AuthorizationURL == ""`). Either way the agent sees only the placeholder.
Neither is a change this record asks for; the constraint is recorded so a
future deployment does not discover it after wiring the chain.

#### Where a non-standard flow is fine

The vault tolerates a bespoke protocol exactly on the surfaces where it never
parses one: header injection (strip the client's value, then `Set` —
`internal/brokercore/brokercore.go` `ApplyInjection`), placeholder substitution
(literal `strings.ReplaceAll` on the declared surfaces only —
`internal/brokercore/substitution.go`), and `passthrough` services (no credential
at all). A credential there is just a string that lands in a header, a path
segment, a query value or a body offset; the vault neither knows nor asks which
specification produced it. That is why the password leg of a bespoke flow works
today, and why any opaque blob an operator deposits works too.

#### Where it is not: the token client is an OAuth 2.0 client

Every surface where the vault must *interpret* the flow is `internal/oauth`, and
there it is a strict RFC 6749 client: an `application/x-www-form-urlencoded`
request, client authentication limited to `client_secret_post` or
`client_secret_basic` (no mTLS, no DPoP, no assertion), and a JSON response
unmarshalled into `TokenResponse{access_token, refresh_token, token_type, scope,
expires_in}`. A bespoke IdP that deviates is not "supported with caveats": it
lands in one of two outcomes, and the quiet one is the dangerous one.

| deviation from RFC 6749 | what the vault does |
| --- | --- |
| non-2xx, or a 2xx body that is not that JSON shape | hard `oauth_refresh_failed` → **502** to the agent with a generic message; the IdP's actual body is written to `LastRefreshError`, never returned |
| `expires_in` absent or `0` (the parameter is only RECOMMENDED by §5.1) | `ExpiresAt` stays zero, `credential.go` persists `TokenExpiresAt = nil`, and its refresh decision **returns early on nil** — so the token is never refreshed again. No error, no log line, nothing in the agent's response: requests simply start failing upstream while the vault believes it has no work to do |
| `token_type` anything but `Bearer` | unmarshalled into `TokenResponse.TokenType` and **read nowhere in the tree** (the field has no second reference); injection hardcodes `"Bearer " + value` (`internal/broker/broker.go`) |
| refresh response omits `refresh_token` | the stored one is kept (`newRefreshCT` stays nil) — correct, RFC 6749 §6 permits either |

Compliance is therefore never *asserted*, only *assumed*: the vault validates
none of it, so an IdP that satisfies half the spec fails as a refused request or,
worse, as a silent stop. The text the agent receives — "OAuth token expired and
refresh failed — reconnect in the Agent Vault dashboard"
(`internal/brokercore/brokercore.go`) — points at the wrong component: the vault's
state is intact, the IdP is not speaking the dialect. This is the same shape as
the [G1](#g1--no-upstream-proxy-support-on-the-data-plane-blocking-code) trap: a
partial fit makes the deployment *look* wired while one leg silently does the
wrong thing.

#### Consequence: a bespoke flow is operator tooling, not a vault feature

No support path exists, and none should be inferred. An IdP whose flow diverges
from the spec — however reasonable its own design — can only be brokered by
containing that protocol in something that is not the vault:

- **out-of-band minter** (preferred): a sidecar or job speaks the bespoke
  protocol and deposits the result into token-upload mode (`AuthorizationURL ==
  ""`) with an explicit `TokenExpiresAt`. The vault then does only what it is
  good at — substitution and header injection — and the non-standard part lives
  in the one component written for it. The vault will still not refresh it (no
  `RefreshTokenCT`), so the minter owns the schedule.
- **a fork of `internal/oauth`**: add the grant and force the result to fit the
  vault's assumptions (`expires_in` filled in, `Bearer` scheme). It works, but it
  is a maintained patch against a package whose whole contract is "standard
  OAuth", and it inherits the table above on every upgrade.

Either way, do not read a working injection as evidence that anything was
validated: the vault happily forwards a credential it cannot reason about, which
is a feature for static secrets and a blind spot for a credential lifecycle the
IdP invents for itself.

## Workarounds that hold today

### W-A — the ~40-line patch (recommended)

One chain-aware dial seam in the vault, reused by both data-plane sites, taken
from the ambient environment **with [d094](d094-relay-chain-proxy.md)'s spelling
and precedence** (`SOCKS_SERVER` > scheme-matched `{http,https}_proxy` >
`ALL_PROXY`; one hop; `NO_PROXY` deliberately unread) so an operator has exactly
one vocabulary for "the chain" across both binaries. `Transport.Proxy` stays
nil, `DialContext` becomes the chain dial, which means:

- `internal/mitm/proxy.go` `New` — the upstream transport's `DialContext` is the
  seam; HTTPS and `CONNECT` both ride it;
- `internal/mitm/websocket.go` `dialWebSocketUpstream` — already calls
  `p.upstream.DialContext`, so it is covered by the same change (this is the
  reason to patch the dialer rather than the transport's `Proxy`);
- `internal/server/server.go` — leave `Proxy = nil`; SSRF posture is a
  deliberate choice there, not an oversight, unless the token endpoint itself
  must ride the chain.

Non-negotiables for that patch:

- **fail closed at startup**, like the relay: a chain that is configured but
  unresolvable/bad-scheme refuses to start, and an unreachable chain at request
  time fails the request — never a direct dial. A "compose when possible" chain
  is a bypass with extra steps.
- the chain dial still passes through `netguard.SafeDialContext` for the
  **proxy's own address** (that is what G2's narrow allowlist covers), so the
  SSRF guard loses nothing except the one hop the operator named.
- an http-CONNECT chain and a SOCKS5 chain stay two implementations behind one
  seam (a CONNECT cannot speak SOCKS5 — the reason estige keeps them apart).

Tests worth adding where there is no coverage today (`internal/mitm` has a
proxy test harness but no chain case):

- upstream through an http-CONNECT chain, including `Proxy-Authorization`
  userinfo;
- upstream through a SOCKS5 chain, with the domain passed unresolved;
- the WebSocket CONNECT-pipe through a chain (frames and close both survive);
- chain configured, proxy down ⇒ request fails, and a direct dial is never
  attempted (assert on the dialer, not on the error string).

### W-B — move the vault to the exit node (zero patch, more moving parts)

The vault sits beside the exit, where egress is open by design, so its direct
dials are correct and G1 never arises. The cost is elsewhere: the workload's
proxy env would have to name a host:port reachable *only through the tunnel*,
which means the workload's client must speak proxy-inside-a-tunnel — two proxy
levels — and stock HTTP clients speak exactly one. Making it work needs either
a forwarder process on the agent side or an estige feature that composes
forward-proxy-into-forward-proxy; plus `VPN_TUNNEL_EGRESS` would have to expose
the exit's `127.0.0.1:14322` to every relay client (G5 turned into a policy
hole). Judged not worth it: the patch is smaller than the deployment.

### W-C — the status quo: no chain composition at all

Run the vault where it has unrestricted egress (an open network, or the exit
node) and let the restricted-network chain be estige's business alone. This is
what ships today, and it is honest — but it means a workload on a restricted
network cannot have its credentials outside its own environment, which is the
requirement that started this.

## Alternatives rejected

- **`AGENT_VAULT_ALLOW_PRIVATE_RANGES=true`.** Drops the private-range guard on
  *every* leg, including OAuth and the Infisical client, to reach one loopback
  port. The allowlist exists for this.
- **`Transport.Proxy = http.ProxyFromEnvironment`.** Not fail-closed, cannot
  express SOCKS5, silently skips `NO_PROXY`/localhost destinations, and the
  WebSocket path does not use it.
- **Put the relay's listener on a non-loopback address** so a vault in another
  netns can reach it. VPN-R23 is structural on purpose, and a credential-less
  forward proxy on a routable address is an open relay for anything that can
  reach the host.
- **Run the vault inside the agent's container.** The workload then holds the
  master password and the vault's memory — the requirement was the opposite.
- **Skip the chain while the relay is down.** That is a bypass with a
  justification attached; see fail-closed above.

## Consequences

- Under W-A, **estige needs no change at all** — every gap lands in the vault,
  its deployment, or its environment.
- The deployment grows a constraint that cannot be seen in either config: the
  vault must share the relay's netns, so one unit restarting starts both, and a
  port collision between them is now possible.
- Two untested seams become load-bearing: WebSocket frames through a CONNECT
  pipe, and the h1.1-POST floor transport when the chain proxy requires
  authentication. Both are the sort of thing that works until a corporate proxy
  meets it.
- The container side of the story — why a workload may only reach the vault and
  nothing else, and what each container backend can actually enforce — is
  [d127](d127-proxy-only-container-egress.md). It is also the reason the vault,
  not the relay, is the right thing to put on the workload's network — and the
  reason the word is "network", not "internet": upstream's own guidance is
  that `14322` stays private to the agents' network because the token *inside*
  `HTTPS_PROXY` is expected to leak, so reachability — not the credential — is
  what makes a leaked value useless. Only the management API on `14321` is
  documented as publicly exposable (behind TLS and an IP allowlist), never the
  MITM port.

## Verification status

Nothing was executed. Source-level only: the vault at `17b2473`
(`internal/mitm/proxy.go`, `internal/mitm/websocket.go`,
`internal/server/server.go`, `internal/netguard/netguard.go`,
`cmd/defaults.go`, `cmd/server.go`), and estige's `relaynode.go`,
`relaychain.go`, `egress.go`, `main.go` in this tree. Kernel/systemd/podman
shapes for G3 are recorded but undeployed; the two tests named under W-A do not
exist yet in either direction.

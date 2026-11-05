---
id: d135
type: module-design
status: draft
title: "d135 — why the container-facing proxy cannot be the estige relay: the tunnel's loopback constraint meets a bridge"
parent: estige
depends-on: [d127]
references: [d094, d103, d126]
tags: ["estige", "proxy", "container", "egress", "loopback", "agent-vault", "mechanics"]
---

# d135 — why the container-facing proxy is agent-vault, not the relay

**Constraint analysis companion to [d127](d127-proxy-only-container-egress.md).**
d127 decides that container egress is proxy-only and installs that rule in the
kernel; it must then name ONE proxy the container can reach. This record is why
that cannot be the estige relay: the relay's listeners are structurally loopback
(VPN-R23) and a rootless bridge cannot reach them, while `host.containers.internal`
only reaches non-loopback binds. That forces agent-vault, which authenticates
with `Proxy-Authorization` — the only identity a bridge can check.

Split out because it is a single narrow argument a reader needs exactly when
reconsidering the proxy choice, and d127's kernel-rule discussion dwarfs it.

## Which proxy, and why it is agent-vault and not the estige relay

The rule above names one address. Choosing it exposes a constraint that is
easy to miss:

- **The estige relay's listeners cannot be that address.** `relaynode.go`'s
  `requireLoopback` refuses any non-loopback listen (VPN-R23, structural), and
  `handleSOCKS` states the consequence: _"the listener is loopback-only,
  VPN-R23 — a credential check here would be theater."_ A container's netns
  does not share the host's loopback, so the relay is unreachable from a
  workload **by construction**. That is a good property, not a problem — but it
  also means the relay can never be the container-facing proxy. (Do not "fix"
  this with pasta's `--map-host-loopback`/`--tcp-ns`: those exist to let a
  container reach host loopback on purpose, and here that would hand a
  credential-less forward proxy to the workload while bypassing the whole
  point.) Note also that the commonly expected `host.containers.internal`
  (169.254.1.2) reaches only host services bound to a _non-loopback_ address —
  a service on `127.0.0.1` is not reachable through it, which is exactly what
  keeps a loopback-bound relay out of reach.
- **agent-vault can be, and it authenticates.** Its bind is a plain `--host`
  flag (default `127.0.0.1`, `cmd/defaults.go`) with the MITM proxy on
  `--mitm-port 14322`, and its proxy surface requires `Proxy-Authorization`
  with a `407` challenge (`internal/mitm/connect.go`,
  `internal/mitm/forward.go`). That authentication matters here for two
  reasons a bare address rule cannot cover: inside a bridge the source IP is
  spoofable by anything holding `CAP_NET_RAW`, and in rootless mode every
  container's traffic shares the invoking uid — so the only identity the proxy
  can actually check is a credential.

  **But the credential is scoping and attribution, never the boundary**, and
  getting that backwards is the one mistake that would make this record
  actively dangerous. The token travels _inside_ `HTTPS_PROXY`
  (`http://token:pw@vault:14322`) — it is handed to the untrusted party by
  design, and upstream says so in as many words: _"Anyone with a leaked
  `HTTPS_PROXY` value (a single `printenv` from a prompt-injected agent) can
  call through Agent Vault from anywhere they can reach `14322`. Keeping
  `14322` unreachable from the public internet is what makes a leaked value
  useless to an attacker"_ (`examples/nginx-public-ui-proxy/README.md`). Three
  code facts make the consequence concrete: the unmatched-host policy
  **defaults to `passthrough`** (`internal/brokercore/credential.go` —
  `PolicyPassthrough` "is the system-wide default"), so a token is not even
  host-restricted unless the operator opts into `deny`; the CA mints a leaf for
  **any** SNI the client asks for (`internal/ca/provider.go` `MintLeaf`); and
  there is **no inbound peer allowlist** on the MITM port —
  `AGENT_VAULT_TRUSTED_PROXIES` serves only the management API's
  `X-Forwarded-For` handling, while the proxy keys its rate limits off the
  direct peer (`internal/mitm/connect.go` `mitmIPKey`: _"X-Forwarded-For
  doesn't exist at this layer"_). The network rule is the lock; the token only
  decides whose traffic it is once you are through it.

  That the token is revocable is what makes the _inside_ case containable —
  `agent-vault agent rotate` invalidates it immediately, and the placeholders
  stay "inert without a valid agent token" (`docs/guides/hermes-on-vps.mdx`).
  But revocation is a _reaction_: it needs someone to notice, and it bounds the
  future, never the requests already made. A kernel ruleset needs nobody
  watching. That asymmetry — not any doubt about the token's strength — is why
  this record constrains packets rather than identities.

Put together, the composition is:

```
workload container → agent-vault (--host <container-facing addr>, :14322, auth)
                   → estige relay (127.0.0.1:<proxy port>, same netns)
                   → tunnel → exit → SSL VPN → corporate proxy → target
```

The estige half of that chain, and the vault's inability to ride it today, are
[d126](d126-agent-vault-in-the-chain.md)'s subject.

**Where that pair has to live depends on the backend, and rootless bridge is the
awkward one.** usernet (`pasta`/`slirp4netns`) and a rootful netavark bridge both
leave a host-side address to bind: pasta maps the guest address to a host bind
that is _not_ loopback (which is exactly why a `127.0.0.1` service is
unreachable through `host.containers.internal` and a `0.0.0.0` one is not), and
a rootful bridge gateway is a real host address. A **rootless** netavark bridge
does not — its bridge and gateway live in the shared rootless netns, which is
what `podman unshare --rootless-netns` exists to reach: _"It can be used to
connect to a rootless container via IP address (bridge networking). This is
otherwise not possible from the host network namespace."_ A host-bound vault is
therefore invisible to a rootless-bridge workload, and the honest shape there is
relay + vault as a **gateway container on the workload's `--internal` network**,
reachable by name, with the relay's own egress leaving from the rootless netns —
the one egress that is supposed to exist.

Two consequences belong here: the vault's bind is chosen per backend (gateway
address where one exists, the pasta mapping otherwise, `0.0.0.0` only where the
mapping forces it and the kernel rule carries the exposure control), and
**"proxy-only" is HTTP(S)-only** — a MITM HTTP proxy is a protocol filter as
much as an address filter, so SMTP, raw TCP, and certificate-pinned clients fail
closed. That should be stated as the policy, not discovered per task.

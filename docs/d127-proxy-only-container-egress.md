---
id: d127
type: architecture-design
status: draft
title: "d127 — container egress is proxy-only: what each backend can actually enforce, and what voids it"
parent: architecture
depends-on: [d113, d119]
references: [d069, d073, d094, d126, d135]
tags: ["containers", "network", "egress", "proxy", "isolation", "backends", "podman", "docker"]
---

# d127 — container egress is proxy-only

**Status: draft.** This workstation has neither `podman` nor `docker`
(`command -v` finds neither; the session runs with `CapEff: 0000000000000000`),
so nothing below was executed here. The claims about engine behaviour come from
engine documentation, the OCI runtime spec, and the podman-farm recipe cited
inline; the per-backend checklist at the end is what a host with an engine must
run before any of this counts as verified.

## Problem

The requirement is one line: **a workload container may reach exactly one
destination — the vetting proxy — and nothing else.** No host services, no
sibling containers, no resolver, no direct internet. Every byte of TCP the
workload emits must pass a process that can see it (credentials injected,
policy applied, traffic logged).

What the repo has today is the *spelling* of that, not the boundary:
`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` handed to the child
([d001](d001-proxy-env-and-namespace.md), [d074](d074-native-node-env-proxy.md),
estige's `proxy-env`, [d094](d094-relay-chain-proxy.md) for the chain's own
resolution), and `--network user` in the VM bench, which is the host's egress
NATted with no policy at all. A client process is free to ignore every one of
those variables, and the ones that matter most routinely do:

- a client with no proxy support at all (most database clients, SMTP, raw TCP,
  `nc`, a language runtime's signal library);
- an explicit dial to an IP literal, which needs no DNS and no proxy;
- `curl --noproxy '*'`, `GIT_CURL_VERBOSE`-era `http.sslVerify`, a package
  manager with its own config file;
- HTTP/3: anything that could speak QUIC would ride UDP/443 past every HTTP
  proxy by design;
- a child that simply unsets the variable (a subprocess spawned by a build
  script).

None of those are exotic — they are the normal operation of a package manager,
a git remote helper, or a tool the agent installs to solve its task. So the
answer is not a better environment; it is a kernel rule installed before the
workload's first instruction.

## Decision

**Enforcement is a netns property, installed at container creation, and the
proxy is the only permitted destination.** Environment variables stay as the
*convention* that makes well-behaved clients work; the rule is what makes the
convention binding.

Four invariants:

1. **Installed before the workload runs, from outside the image.** The
   mechanism must not depend on an entrypoint, a wrapper, or a binary inside
   the container — the workload owns all of those.
2. **Un-undoable from inside.** The workload must not hold the capability that
   would flush the ruleset. Any shape that keeps `CAP_NET_ADMIN` (or
   `CAP_SYS_ADMIN`, or `--privileged`) inside the workload voids the guarantee
   outright, not partially.
3. **Default drop, one accept.** Not an allowlist of "things we thought of" —
   a policy `drop` with exactly one destination, so a protocol nobody
   considered fails closed.
4. **IPv4 and IPv6 in one table.** `inet`-family rules, because a v6 default
   route is a full bypass of a v4-only policy and every rootless backend treats
   v6 differently.

### The rule set (shape, not a tested file)

```nft
table inet workload_egress {
	chain output {
		type filter hook output priority 0; policy drop;
		oifname "lo" accept                                  # nothing leaves the host
		ct state established,related accept                  # return path
		ip daddr 169.254.1.2 tcp dport 14322 accept          # the proxy, nothing else
		icmp type { destination-unreachable, time-exceeded, packet-too-big } accept
		icmpv6 type { destination-unreachable, packet-too-big, time-exceeded,
		              nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert } accept
	}
	chain forward { type filter hook forward priority 0; policy drop; }
	chain input   { type filter hook input   priority 0; policy drop;
	                ct state established,related accept; oifname "lo" accept; }
}
```

Three things in that block are deliberate and each has a reason:

- **No DNS rule.** Port 53 is dropped like everything else, and that is a
  feature: an HTTP proxy carries the *hostname* in `CONNECT host:port`, so the
  workload never needs to resolve anything — the proxy resolves, at its own
  position in the chain. A workload that cannot resolve cannot name a
  destination it was not given, and a leak through a DNS resolver (or DoH on
  UDP/443) is closed by the same policy. The podman-farm recipe shows the same
  effect as an artifact: with only one IP allowed, name lookups fail before
  connect does.
- **UDP is dropped wholesale** by the policy (no `udp` accept anywhere), which
  is what kills QUIC/HTTP3 and UDP-based DNS. An HTTP-proxy-only egress is
  TCP-only by construction; making that explicit beats discovering it when a
  client silently retries over QUIC.
- **ICMP is carved out, not allowed.** Dropping *all* ICMP breaks PMTU
  discovery and produces the classic "big uploads hang" bug; allowing the
  control types above while dropping echo keeps the workload unable to probe
  reachability.

The proxy's address in the example is the rootless-usernet gateway; per backend
it is the bridge gateway or the network's own address (see below). What matters
is that it is **one address and one port**, and that it is the proxy's, not the
gateway's in general.

## The three backends

The mechanism differs per backend, and so does the answer to "who can undo it" —
which is the part that decides whether the rule is a boundary or a speed bump.

### docker rootful

Rules live in the host netns; Docker writes its own there and appends
unconditional jumps to `DOCKER-USER` → `DOCKER-FORWARD` → `DOCKER` in
`FORWARD`, so **`DOCKER-USER` is the documented insertion point** and anything
appended to `FORWARD` directly is processed after Docker's own rules. Two
gotchas, both from Docker's own packet-filtering documentation:

- packets reaching `DOCKER-USER` have **already been DNAT'd**, so the rule must
  match the container's internal address/port (or use the `conntrack`
  extension to match the original destination);
- public ports are easier than egress: an `--internal` network has no gateway
  route out at all, which is a *cleaner* starting point than a firewall rule —
  put the proxy on an internal network with the workload and the only reachable
  address is the proxy's, by routing rather than by policy.

What voids it: `--network=host`, `--privileged`, `--cap-add NET_ADMIN`,
`--network=container:<id>` of a host-networked container, the daemon's
`iptables: false`, and — the one people forget — **the Docker socket mounted
into the workload**, because anything that can talk to the socket can start a
privileged, host-networked container.

### podman rootful

Same topology (netavark writes host-netns rules), but there is **no documented
user-hook chain** equivalent to `DOCKER-USER`; netavark owns its own chains in
the `filter` table. Two supported ways, in order of robustness:

1. `podman network create --internal` plus the proxy as the only other member —
   routing, not policy, so there is nothing to order against netavark's rules.
2. A base chain of your own on the `forward` hook with a **lower priority
   number** than netavark's, so yours is evaluated first (same-hook base chains
   run in ascending priority order — the nft-native equivalent of
   `DOCKER-USER`), plus the mirrored `output` rule for host-networked shapes
   that must be rejected anyway.

What voids it: the docker list, word for word (`--net=host`, `--privileged`,
`--cap-add NET_ADMIN`, `--network=container:`, the podman socket mounted in),
plus `--iptables=false` at network-create time.

### podman rootless

This is the case that needed the research, and it has a clean answer:
**a `createContainer`-stage OCI hook that runs host binaries against the
container's own netns.** The OCI runtime spec is explicit — the hook's `path`
MUST resolve in the runtime namespace, and the hook MUST execute in the
container namespace — so at that stage the namespace exists, the workload has
not started, and `CAP_NET_ADMIN` has not been dropped yet. The podman-farm
recipe demonstrates the three properties that make this the right mechanism:

- after the hook, the workload's `capsh --print` shows `!cap_net_admin`, so the
  workload cannot flush what the hook installed;
- a "malicious" `iptables` planted in the image cannot subvert it, because the
  hook used the **host's** `iptables`, and the rule is already in place;
- the rules take effect on the workload's own egress path (its packets traverse
  this netns's `output` chain), which is why it works with `pasta` and
  `slirp4netns` alike even though the forwarding happens outside the netns.

The important corollary: in rootless **bridge** (netavark) mode the same hook
still binds the app, because the app's packets still traverse its own netns
first. What changes is the *other* half — cross-container traffic and ingress —
which is decided in the shared **rootless netns**
(`podman unshare --rootless-netns nft …`), and that namespace belongs to the
invoking uid. So rootless-netns rules are **not** a boundary against the user's
own host shell; they close the sibling-container path and nothing more. Use
them as a complement, never as the guarantee.

What voids it: `--cap-add NET_ADMIN`, `--privileged`, `--network=host`,
`--network=ns:<path>` (no container netns is created, so there is nowhere to
install the rule — this is the shape that silently disables the hook), and
`pasta`'s opt-in host-loopback mapping described below.

| backend | rule lives in | enforced by | undone by |
| --- | --- | --- | --- |
| docker rootful | host netns (`DOCKER-USER`, or `--internal` routing) | dockerd/root | root or the socket |
| podman rootful | host netns (own chain before netavark, or `--internal`) | podman/root | root or the socket |
| podman rootless, usernet | container netns (`output`) | `createContainer` OCI hook | only `CAP_NET_ADMIN` in that netns (i.e. nothing) |
| podman rootless, bridge | container netns (`output`) **+** shared rootless netns (forward/ingress) | OCI hook (+ `isolate=true` / `--internal`) | the hook's half: nothing; the rootless-netns half: the invoking uid |
## Which proxy, and why it is agent-vault and not the estige relay

**Moved to [d135](d135-container-proxy-choice.md)** — the constraint analysis
behind the one address the rule names: the relay's listeners are structurally
loopback (VPN-R23) so a rootless bridge cannot reach them, `host.containers.internal`
reaches only non-loopback binds, and what is left is a proxy the container can
authenticate to with `Proxy-Authorization`.

## Escape hatches that void all of it

Collected in one place because they are spread across three engines' flags and
one of them is not a flag at all:

- `--network=host` / `--net=host` / `--network=ns:<path>` — there is no
  container netns to install a rule into.
- `--network=container:<another>` — inherits whatever that container has; only
  safe if the target is itself the locked-down shape.
- `--privileged`, `--cap-add NET_ADMIN`, `--cap-add SYS_ADMIN` — restore the
  ability to flush, or to reach the host netns.
- The engine socket mounted into the workload (`podman.sock`/`docker.sock`) —
  equivalent to root, and it starts a *new* container that is not locked down;
  this voids the guarantee even when the running container is perfect.
- Adding a second network to the workload after creation (`podman network
  connect`), and any `--publish` that lands the workload on a shared bridge
  where a trusted container with open egress sits (`isolate=true` exists to
  drop exactly that forwarding).
- Daemon-level `iptables: false` / `--iptables=false`, which leaves the engine's
  own rules out of the picture and, worse, makes them easy to reason about
  wrongly.
- Running the workload as the *host* uid with access to the rootless netns
  (i.e. not a container boundary at all) — the reason the rootless-bridge half
  of the table above is not the guarantee.

## Verification — the checklist that must pass on a host with an engine

Positive and negative in one session, because a policy that blocks everything
also "blocks the bad thing":

- `curl -x http://<vault>:14322 https://example.com` with the proxy credential →
  `200`; the vault's log shows the injected credential and the target.
- `curl https://example.com` (no `-x`, env cleared) → fails.
- `curl --noproxy '*' https://example.com`, `curl https://1.1.1.1`,
  `nc -z 1.1.1.1 53`, `dig @1.1.1.1 example.com`, `getent hosts example.com`
  → all fail (the last one proves DNS is closed).
- `curl --http3 https://example.com` / any QUIC client → fails (UDP is gone).
- Tamper: inside the container, `nft flush ruleset` / `iptables -F` → permission
  denied. If this succeeds, the guarantee is void and everything above was
  luck.
- Ingress: from a sibling container on the same network, connect to a port the
  workload listens on → refused; then repeat with `isolate=true` /
  `--internal` to confirm which of the two is doing the work.
- The proxy itself: `curl -x` from a *second* container without the credential →
  `407`. A proxy that accepts anonymous clients is an open relay behind the
  rule, and the rule still "passes".

## What changes in this repo

- The workload runtime (`workload-runtime.mjs` and the shell/jq backends it
  replaced, [d119](d119-coding-agent-workload-runtime-in-node.md)) grows an
  egress-lockdown step, keyed by the backend it already detects.
- Backend detection ([d069](d069-backend-detection-path.md)) grows a fourth
  category, and the split is not cosmetic: `podman` rootless-usernet,
  rootless-bridge, and rootful take three different mechanics, so the detection
  table has to answer which one it is rather than just which binary exists.
- `docs/container-tooling.md` records the rootless constraints it currently
  lists only two of (sub-1024 ports, `mknod`) — the third is that the *engine*
  cannot firewall a rootless container from the host netns, so the hook is the
  only route.
- The VM/micro-VM backend ([d020](d020-libvirt-qemu-sandbox.md)) needs none of
  this per container: the same policy belongs one level up, on the VM's tap.

## Alternatives rejected

- **Environment variables only (the status quo).** Unenforceable, for the five
  reasons in the Problem; a boundary that any client can decline is a
  convention.
- **`--network=none` for everything.** Correct and trivial for workloads with
  no network need, useless for the one case that matters here (a workload that
  must reach a proxy).
- **Enforce only in the rootless bridge netns.** It is owned by the invoking
  uid, so it does not survive the threat model that motivates all of this —
  a workload that is not privileged but whose *host* is the same user.
- **Firewall inside the image.** The workload has (or can be given) the
  capability to flush, and by definition it controls its own entrypoint.
- **Rely on the MITM proxy as the boundary.** A MITM is a policy engine; the
  vault's `netguard` protects *the vault's* legs (its own SSRF surface), not
  the container's. Without the kernel rule the container simply dials around it.
- **eBPF cgroup socket-redirect / `connect()` filtering.** The one mechanism
  that could cover all three backends uniformly and also bind non-netns shapes;
  rejected *for now* only because it is kernel- and daemon-dependent
  (`cgroup/connect4` support, a loader in the loop before the workload starts)
  and nothing in this repo loads BPF today. This is the natural next step, not
  a wrong answer.

## Open questions

- `pasta`'s `--map-guest-addr` / `--map-host-loopback` defaults across podman
  4.x and 5.x — the reason the "loopback is unreachable" claim above is stated
  with the mechanism (no host-loopback mapping by default) rather than as a
  version assertion.
- Whether Docker's nftables backend changes the `DOCKER-USER` advice; the
  documented insertion point is stated for the iptables path.
- Whether the hook fires before capabilities are dropped on the podman version
  the fleet pins — a property of the runtime spec, but the spec is implemented.
- IPv6: `pasta` may hand out a `fd00::/64`, so the `inet` table above must be
  the default rather than a v4 table plus a note.
- `isolate=true` availability across netavark versions, and whether it is the
  right default for every network this repo creates.

## Verification status

Nothing executed — no engine on this host, and the session has no capabilities
(`CapEff: 0000000000000000`, `uid=1000`). Sources: Docker Engine
packet-filtering/firewall documentation (`DOCKER-USER` ordering, DNAT-before-
filter, `--internal`); `podman-unshare(1)` (`--rootless-netns`); the
`createContainer` hook contract as quoted in the OCI runtime spec and
demonstrated in [the podman-farm firewalling recipe](https://jerabaul29.github.io/jekyll/update/2025/10/17/Firewall-a-podman-container.html)
(non-root `capsh` output, hostile-`iptables` test, DNS failing first);
podman discussions on `host.containers.internal` not reaching host loopback
(`containers/podman` #28456, #28435). The checklist above is the gate: until it
runs green on each of the three backends, this record is a plan, not a property.

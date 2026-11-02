---
id: estige
type: module-design
status: active
title: "estige — SSL-VPN tunnel transports (exit node + relay node)"
parent: architecture
tags: ["serving", "proxy", "go"]
---

# estige

One self-contained Go binary, two network positions: an **exit node** at the edge that
terminates tunnels and opens egress under a reviewed policy, and a **relay
node** on a restricted network that dials in and serves localhost CONNECT/SOCKS5
proxies to unmodified clients. Clients validate the target's real certificate
end to end and never trust the node in the middle.

> **What left (docs/d108):** the v2 host-allowlist reverse proxy — legacy
> "mode A", docs/d047 — is deleted. A TLS-terminating edge sees plaintext
> provider keys and no credential scheme fixes that (docs/d073's trust table).
> Gone with it: `allowHosts`/host-form routing, the generated allowlist,
> `estige generate`, the smoke-test suite, and the install-time route
> substitution it forced on the generators. What remains of that shape is the
> funnel's plain 404, which every non-tunnel path still answers.

> **Transport family (docs/d073/d077/d105):** the h2-POST tunnel (HTTP/2
> streaming POST — default-on since d084), the WebSocket tunnel
> (`CONNECT`-over-WebSocket, the deployed v2 shape), and the h1.1-POST tunnel
> (per-exchange windowing — the floor under an upgrade-stripping gateway). The
> offer is always the whole ladder, ranked per dial by the relay node; the
> `-modes`/`MODES` knob retired with docs/d093. Requirements are d073's,
> negotiation/framing d077's, names d105's, the credential redesign d104's.

Historical reference for the deleted proxy: llama-swap,
github.com/mostlygeek/llama-swap (`internal/router/peer.go`) — estige was
that substrate (`httputil.ReverseProxy`) with everything else stripped. The
rationale stays in [DESIGN.md](DESIGN.md).

## Install

Packages are the supported deployment. `./estige/build.sh estige-packages`
writes both artifacts to `estige/packaging/out/`; the binary is self-contained
(no node, jq, or infisical inside the package). The env file belongs to the
operator and to the service manager: the binary reads no file.

**Termux (aarch64, exit node, runit via termux-services)**

```console
$ pkg install termux-services
$ dpkg -i estige_<version>_aarch64.deb
$ $EDITOR $PREFIX/etc/estige/env        # mode 0600
$ sv-enable estige && sv start estige
```

The service ships `down`, so installing starts nothing. Logs are Combined Log
Format on stdout (docs/d106), collected by `svlogd` under
`$PREFIX/var/log/sv/estige`.

**Oracle Linux 8/9 (x86_64, systemd)**

```console
$ sudo rpm -i estige-<version>-1.x86_64.rpm
$ sudoedit /etc/estige/estige.env       # exit node; mode 0600 root:root
$ sudo systemctl enable --now estige
# relay node, on a restricted network:
$ sudoedit /etc/estige/estige-relay.env
$ sudo systemctl enable --now estige-relay
```

The units are separate files, not an `estige@.service` template: the exit node
reads `VPN_OPERATOR_KEYS` and binds `PORT`; the relay reads
`VPN_OPERATOR_TOKEN` and binds only loopback listeners (docs/d090). Both env
files are conffiles, so `rpm -U` never overwrites operator edits. The units are
left disabled, so installing starts nothing. The unit has an empty
`CapabilityBoundingSet`; a `PORT` below 1024 needs an operator
drop-in with both `CapabilityBoundingSet=CAP_NET_BIND_SERVICE` and
`AmbientCapabilities=CAP_NET_BIND_SERVICE` (the packaged default is 8080).

**Container (image still built; the operator launches it)**

```console
$ ./estige/build.sh estige-image
$ podman run -d --name estige-exit --network=host \
    --env-file ~/.config/estige/exit.env localhost/estige:latest -mode exit
```

The in-process container launch (`vpn-exit.sh`/`vpn-relay.sh` plus the
workload library) is deleted: the runtime is the operator's service manager,
not this unit.

## Usage

The exit node, armed by the env chain (a direct run; a package sources the same
names from its env file):

```console
$ ./estige -version                          # the packaged artifact identity
$ ./environment.sh ./estige -mode exit      # VPN_OPERATOR_KEYS arms the tunnel
[estige] listening on :8080; tunnel at /vpn
$ PORT=8443 ./environment.sh ./estige -mode exit   # the one port knob (docs/d110)
```

The funnel points at that port. The relay node (`./estige -mode relay`, or the
packaged `estige-relay.service`) dials in and serves the loopback proxies its
clients use. A node with no operator credential refuses to start — there is no
other face left to serve (docs/d084's kill-switch law, docs/d108).

The loopback chain step is `estige proxy-env` (docs/d095): it prints
`export KEY='value'` lines for the relay's listeners so the operator can hand a
consumer the spelling without starting anything.

```console
$ eval "$(estige proxy-env)"
$ ./coding-agent/run.sh
```

### Configuration: none the binary reads — the env chain is the whole surface

There is **no config file the binary reads** (docs/d108 slice 5: the last one,
the policy file, died with the allowlist). A package ships an env file for its
service manager; that is the same environment surface, not a second one. Every
fact the exit node needs comes from its environment, which the service manager
or operator already owns:

| fact | spelling |
|---|---|
| arming credential (the capability) | `VPN_OPERATOR_KEYS` — no credential, no tunnel, no boot (docs/d084) |
| egress opt-ins (VPN-R38) | `VPN_TUNNEL_EGRESS`, JSON `{"allowCidrs": ["10.0.0.0/8"], "ports": [443]}`; unset = the requirement's defaults (deny RFC 1918/metadata/loopback, allow 80/443) |
| bind | `PORT` (docs/d110) |

Why no file: a file holding a credential is a second, unkeyed copy of it
(VPN-R32), and with the allowlist gone there was nothing else a file needed to
say. The policy half's permanent home is docs/d104's role store — its
`exit.json` carries egress beside the admitted relays — and until that store
lands, the env chain carries it. Nothing here can *grant* the capability: only
the credential does.

## Build & run

Building is **this folder's own** `./build.sh` → `build.mjs` (docs/d083/d113 —
there is no root builder any more; each folder is a copy unit). Targets:

- `estige-native` — the host binary (`estige-android` on Termux; `GOOS=android`
  is required so DNS resolves via Android's resolver — flag presets in this
  folder's own `lib/go-build.mjs`). Needs a working go toolchain.
- `estige-packages` — the pure-Go `.deb` + `.rpm` writer (`packaging/`). It
  cross-compiles both payloads (android/arm64, linux/amd64), so the build host
  needs only go. Artifacts land in `packaging/out/` (gitignored).
- `estige-image` — the OCI image (`Containerfile`: multi-stage `golang:1.27`
  → `scratch`); registered only when a container backend exists and the naive
  cloud probe answers. The compile happens inside the image, so the host needs
  no go toolchain. `scratch` is deliberate: the final stage pulls from NO
  registry, so the image builds where non-docker.io registries are blocked;
  the image ships the CA bundle both TLS legs verify against and is ~7.5 MB
  final.
- `termux-provisioning` — the repo-root device provisioner, run first on
  Termux. It installs the infisical CLI (the operator's env chain) plus the
  `node`/`jq` the *other* Termux units still need (`llm-local-inference`'s
  generators and its shell workload runtime). estige needs neither: the binary
  is self-contained Go and the packages carry no runtime dependency. Not
  selectable: it is environment provisioning, not an artifact.

The behavioural suite is `go test ./...` in this folder — no node, curl, or
python3 on the host (docs/d102).

Each process is still its own entry point (docs/d095), but now the **service
unit** is the deployment identity, not a shell script: a Termux runit service
or an `estige.service`/`estige-relay.service` pair. ROLE — per docs/d088 the
two deployments are named by network position, not protocol role: the **exit
node** has free, unblocked internet plus tsnet connectivity to the actual LLM
endpoints, and traffic exits the local environment through it; the **relay
node** (the loopback CONNECT/SOCKS5 proxy feeding the tunnel transports;
docs/d073 §7) runs locally on a restricted-internet environment, without
direct tsnet to the endpoints. The code speaks the same names (d088 phase 2
landed).

Exit node: listening on `${PORT:-8080}` (env `PORT` is the only bind spelling,
docs/d110). No config file is read (docs/d108): `VPN_OPERATOR_KEYS`, `PORT`
and — when the operator opens an egress range — `VPN_TUNNEL_EGRESS` are the
whole surface, handed over by the service manager's env file or the operator's
shell.

Relay node: likewise no config file — `VPN_TUNNEL_URL` (http(s):// or
ws(s):// — the URL's honest wire form, normalized to wss internally,
docs/d090; the path is the Funnel mount plus the fixed `/vpn`, docs/d085) and
`VPN_OPERATOR_TOKEN` are its core surface, with `VPN_CLIENT_LABEL` optional
(defaults to the hostname) and an OPTIONAL chain proxy via the conventional
variables (`SOCKS_SERVER` beats a scheme-matched `http_proxy`/`https_proxy`,
which beats `ALL_PROXY`; `SOCKS_VERSION` must be `5`; `NO_PROXY` deliberately
not read — docs/d094: the chain is ONE blind TCP tunnel under the tunnel leg
only, `Transport.Proxy` stays nil, provider requests never touch it). The
transport ladder rides whole — h2-POST → WebSocket → h1.1-POST ranked at dial
time, no `-modes`/`MODES` override (docs/d093) — and the listeners default to
`127.0.0.1:3128`/`1080` (`-proxy-listen`/`-socks-listen`; VPN-R23 forbids
exposing them). The relay refuses to start if the ambient proxy env already
names its own listener (exit 94) — a self-chain would dial a loop.

`estige proxy-env [-proxy-listen ADDR] [-socks-listen ADDR]` is the CHAIN STEP
(docs/d095): it prints `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`
(loopback direct plus the host's entries) and `NODE_USE_ENV_PROXY=1` as
single-quoted `export` assignments for `eval "$(estige proxy-env)"`. It starts no
relay and waits for no health answer: the service manager already owns the
relay, and the relay's own upstream chain is read from the ambient env before
that spelling is exported.

Secrets (env-only — VPN-R32/d078; the service manager loads the env file, the
binary never does; the in-progress d104 credential redesign moves the tunnel
keys into the on-disk key store): an armed exit node (docs/d084/d085: armed
when the env carries the operator keyset) holds the keyset
(`VPN_OPERATOR_KEYS`), and the relay node holds the operator token
(`VPN_OPERATOR_TOKEN`) — disjoint since docs/d090, which retired the keyset's
implicit-`default` merge of the token.

### Port model (the single knob, docs/d110)

The tailscale funnel serves the whole `https://bazzite…/<funnel-id>` route on
host port **8080**, so the exit node must own 8080. The path table it used to
serve is down to one mount:

| path under the funnel | backend |
|---|---|
| `/vpn` (the mount prefix, stripped at the edge, docs/d085) | the tunnel namespace — the only face |
| anything else | the plain funnel 404, byte for byte (VPN-R34) |

The bind has exactly one knob (docs/d110): env `PORT`, unset → `8080`, bound
on all interfaces. No `-listen`/`-port` flag and no config field of our own —
the standard name is the only spelling, so a coordinator that speaks `PORT`
steers the exit node without editing files or argv.

The suite that used to run against this table (`estige smoke-test`, 34 checks
including the badssl TLS taxonomy) is deleted with it (docs/d108). What
survives is the in-process tunnel suite — `go test ./...`, hermetic, no
outbound internet required.

CI: none exists yet, deliberately — the GitHub Actions findings for
this unit (required steps, runner friction, gate flake points) live in
[CI.md](CI.md), deferred until the d082 split moves the unit to its
own repo.

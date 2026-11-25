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
> allowlist relay, docs/d047 — is deleted. A TLS-terminating edge sees plaintext
> provider keys and no credential scheme fixes that (docs/d073's trust table).
> Gone with it: `allowHosts`/host-form routing, the generated allowlist,
> `estige generate`, the smoke-test suite, and the install-time route
> substitution it forced on the generators. What remains of that shape is the
> funnel's plain 404, which every non-tunnel path still answers.

> **Transport family (docs/d073/d077/d105/d222):** **h2-post-unbounded**
> (one long-lived HTTP/2 streaming POST), **websocket**
> (`CONNECT`-over-WebSocket, the deployed v2 shape), **h2-post-windowed**
> (the same h2 POST split into size-bounded windows for an edge that caps a
> single request body), and **h1.1-post-windowed** (per-exchange HTTP/1.1
> POSTs — the floor under an upgrade-stripping gateway). Carriers are named
> by mechanism, never by letters (docs/d105). The relay offers
> h2-post-unbounded first; a capped-edge port refuses it at request
> initiation and the relay switches to websocket → h2-post-windowed →
> h1.1-post-windowed for the rest of the process (docs/d222). The
> `-modes`/`MODES` knob retired with docs/d093. Requirements are d188's, negotiation/framing d077's, names
> d105's, the blind `e-auth` credential d104/d131/d236's, and the inner TLS
> channel d169/d236's. v5 is the generation in this binary: every admitted
> exchange carries a mutual single-use proof and every carrier runs an inner
> TLS 1.3 session — one per window on the windowed carriers. The front-door
> mTLS of d211 (v6) remains a design on record.

> **Key store (docs/d236).** `estige keygen -principal <name>` mints the
> Ed25519 key and its self-signed certificate in `prv/<principal>.der` and
> `<principal>.crt`, printing the `{name, public}` row to paste into the peer's
> `relay.json`/`exit.json`. `estige public -f <key>` reprints that row from an
> existing key; `estige key check` loads the role stores with the same strict
> parser boot uses. A re-mint is a pin change, not an in-place rotation.

Historical reference for the deleted proxy: llama-swap,
github.com/mostlygeek/llama-swap (`internal/router/peer.go`) — estige was
that substrate (`httputil.ReverseProxy`) with everything else stripped. The
rationale stays in [DESIGN.md](DESIGN.md).

## Install

Packages are the supported deployment. `./node-run.sh estige/build.mjs estige-packages`
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
reads `VPN_OPERATOR_KEYS` and binds `PORT` (plus optional `PORT_CLOUDFLARE`); the relay reads
`VPN_OPERATOR_TOKEN` and binds only loopback listeners (docs/d090). Both env
files are conffiles, so `rpm -U` never overwrites operator edits. The units are
left disabled, so installing starts nothing. The unit has an empty
`CapabilityBoundingSet`; a `PORT` below 1024 needs an operator
drop-in with both `CapabilityBoundingSet=CAP_NET_BIND_SERVICE` and
`AmbientCapabilities=CAP_NET_BIND_SERVICE` (the packaged default is 8080).

**Container (binary built on the host; the operator launches the image)**

```console
$ go build .                     # the one compile
$ go run build.go                # packages ./estige into localhost/estige:<VERSION>
$ mkdir -p /var/lib/estige && chown 65532:65532 /var/lib/estige
$ ESTIGE_ENV_FILE=~/.config/estige/exit.env go run run.go -mode exit
```

`build.go` and `run.go` are standalone Go files (d236): `go run <file>`
compiles that file alone, so the image path has no second build
implementation and no node prerequisite. The image is Debian trixie-slim
with `ca-certificates` and `busybox-static`, runs as uid 65532, and reads its
store from `/var/lib/estige` (bind `ESTIGE_STORE_DIR` to move the host path).
Env reaches the container by name from `--env-file` when set, otherwise as
explicit `-e` names; argv after the image is forwarded to the binary. There
is no restart policy — the operator's service manager owns supervision.

The in-process container launch (`vpn-exit.sh`/`vpn-relay.sh` plus the
workload library) is deleted: the runtime is the operator's service manager,
not this unit.

## Usage

The exit node, armed by the env chain (a direct run; a package sources the same
names from its env file):

```console
$ ./estige -version                          # the packaged artifact identity
$ ./environment.sh ./estige -mode exit      # VPN_OPERATOR_KEYS arms the tunnel
[estige] listening on :8080 (tailscale edge: h2-post-unbounded allowed); tunnel at /vpn
$ PORT=8443 ./environment.sh ./estige -mode exit   # the tailscale-edge port (docs/d110)
$ PORT=8443 PORT_CLOUDFLARE=8444 ./environment.sh ./estige -mode exit
[estige] listening on :8444 (cloudflare edge: h2-post-unbounded refused; windowed carriers only)
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
$ ./node-run.sh coding-agent/run.mjs
```

### Configuration: none the binary reads — the env chain is the whole surface

There is **no config file the binary reads** (docs/d108 slice 5: the last one,
the policy file, died with the allowlist). A package ships an env file for its
service manager; that is the same environment surface, not a second one. Every
fact the exit node needs comes from its environment, which the service manager
or operator already owns:

| fact                               | spelling                                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| arming credential (the capability) | `VPN_OPERATOR_KEYS`, JSON id → token; no credential, no tunnel, no boot (docs/d084)                                                                            |
| per-principal egress (optional)    | a keyset value may instead be `{"token": "…", "egress": {…}}` (docs/d078); a string inherits the process table                                                 |
| egress opt-ins (VPN-R38)           | `VPN_TUNNEL_EGRESS`, JSON `{"allowCidrs": ["10.0.0.0/8"], "ports": [443]}`; unset = the requirement's defaults (deny RFC 1918/metadata/loopback, allow 80/443) |
| bind (tailscale edge)              | `PORT` (docs/d110): the Funnel-facing port, where h2-post-unbounded is allowed                                                                                 |
| bind (capped edge, optional)       | `PORT_CLOUDFLARE`: a second port whose connector fronts an edge that caps a request body; h2-post-unbounded is refused there at request initiation (docs/d222) |

Why no file: a file holding a credential is a second, unkeyed copy of it
(VPN-R32), and with the allowlist gone there was nothing else a file needed to
say. The policy half's permanent home is docs/d104's role store — its
`exit.json` carries egress beside the admitted relays — and until that store
lands, the env chain carries it. Nothing here can _grant_ the capability: only
the credential does.

**This env surface is v3's, and `VPN_*` is deprecated.** v5 (docs/d236)
keeps the tunnel transports and moves identity and admission into the merged
host store at `$XDG_DATA_HOME/estige`: one Ed25519 key and its self-signed
certificate in `prv/<principal>.der`, peers pinned by the certificate's
`public` row in `relay.json`/`exit.json`. The `VPN_*` credential and URL
spellings retire with that generation; `PORT` and non-secret runtime knobs
stay. Older wire generations fail closed — no fallback or downgrade path.

## Build & run

Building is **this folder's own** `./node-run.sh estige/build.mjs` (docs/d083/d113 —
there is no root builder any more; each folder is a copy unit). Targets:

- `estige-native` — the host binary (`estige-android` on Termux; `GOOS=android`
  is required so DNS resolves via Android's resolver — flag presets in this
  folder's own `lib/go-build.mjs`). Needs a working go toolchain.
- `estige-packages` — the pure-Go `.deb` + `.rpm` writer (`packaging/`). It
  cross-compiles both payloads (android/arm64, linux/amd64), so the build host
  needs only go. Artifacts land in `packaging/out/` (gitignored).
- `estige-image` has moved to Go (d236): `go build .` then
  `go run build.go` (and `go run run.go` to launch). It packages the built
  binary into Debian trixie-slim; the node builder no longer registers an
  image target.
- `termux-provisioning` — the repo-root device provisioner, run first on
  Termux. It installs the infisical CLI (the operator's env chain) plus the
  `node`/`jq` the _other_ Termux units still need (`llm-local-inference`'s
  generators and its shell workload runtime). estige needs neither: the binary
  is self-contained Go and the packages carry no runtime dependency. Not
  selectable: it is environment provisioning, not an artifact.

The behavioural suite is `go test ./...` in this folder — no node, curl, or
python3 on the host (docs/d102). Static analysis is `./lint.sh`'s
golangci-lint leg against `.golangci.yml` (docs/d137): strict-from-standard,
with the rejected linters recorded there rather than re-litigated.

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

Exit node: listening on `${PORT:-8080}` (docs/d110), plus `PORT_CLOUDFLARE`
when a second edge's connector points at this exit (docs/d222). No config file
is read (docs/d108): `VPN_OPERATOR_KEYS`, the two ports and — when the
operator opens an egress range — `VPN_TUNNEL_EGRESS` are the whole surface,
handed over by the service manager's env file or the operator's
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
carrier ladder rides whole — h2-post-unbounded → websocket →
h2-post-windowed → h1.1-post-windowed, ranked per dial, no `-modes`/`MODES`
override (docs/d093). The h2 half is learned: an exit port serving a capped
edge refuses h2-post-unbounded at request initiation, and that one refusal
switches the process to websocket → h2-post-windowed for later CONNECTs
(docs/d222) — and the listeners default to
`127.0.0.1:3128`/`1080` (`-proxy-listen`/`-socks-listen`; VPN-R23 forbids
exposing them). `-legacy-ip-relay` (off by default) passes address targets to
the exit's gate instead of refusing them at the door, and both doors refuse
the `localhost` name family (`localhost`, the whole `.localhost` TLD, and
the `/etc/hosts` spellings like `localhost4.localdomain4`) plus
guaranteed-bogon space before any lookup regardless (docs/d163). The relay refuses to start if the ambient proxy env already
names its own listener (exit 94) — a self-chain would dial a loop.

Two postures and one extra listener are argv, not env: `-insecure-exit`
(docs/d171) is the only way to skip tunnel-leg verification or accept a
cleartext `ws://` URL — without it the URL is refused at boot — and while it
is set the parsed cleartext-forward door refuses and the blind doors close a
client that opens with an HTTP request line. On the exit node, `-status-listen
127.0.0.1:8081` (loopback only, off by default) serves `GET /status` with the
live session set (docs/d106). `-L [<bind>:]<port>:<host>:<port>`
(docs/d144, repeatable, loopback binds only) adds an ssh-style listener whose
every accepted connection buys its own tunnel. `/healthz` reports the live
session set, the endpoint and the degraded flag; never the credential.

`estige proxy-env [-proxy-listen ADDR] [-socks-listen ADDR]` is the CHAIN STEP
(docs/d095): it prints `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`
(loopback direct only; the host list is ignored) and `NODE_USE_ENV_PROXY=1` as
single-quoted `export` assignments for `eval "$(estige proxy-env)"`. It starts no
relay and waits for no health answer: the service manager already owns the
relay, and the relay's own upstream chain is read from the ambient env before
that spelling is exported.

Every conventional variable is printed in **both cases**, with equal values —
`HTTP_PROXY` and `http_proxy`, and so on — because clients disagree about which
one they read (curl prefers the lowercase for `http://`, GNU wget reads only
the lowercase), and a child reading the case that was not exported dials the
internet **direct**, past the tunnel (VPN-R26). `ALL_PROXY` names
`socks5h://`, not `socks5://`: the relay's SOCKS5 listener refuses a
literal-address target because the exit node owns resolution and pinning
(VPN-R22), so the client must keep the name on the wire (VPN-R24). Both rules
are docs/d130's, pinned by `estige/proxyenv_test.go` and an end-to-end SOCKS
case.

Secrets (env-only — VPN-R32/d078; the service manager loads the env file, the
binary never does; the in-progress d104 credential redesign moves the tunnel
keys into the on-disk key store): an armed exit node (docs/d084/d085: armed
when the env carries the operator keyset) holds the keyset
(`VPN_OPERATOR_KEYS`), and the relay node holds the operator token
(`VPN_OPERATOR_TOKEN`) — disjoint since docs/d090, which retired the keyset's
implicit-`default` merge of the token.

### Logs and the v3 rotation

Every line is still one line: the access line stays stock Combined Log Format
and session records are logfmt (`ts= role= event= id= key= …`, docs/d106).
Under systemd the same lines become journal entries with fields — detected by
`JOURNAL_STREAM`, no flag — so `journalctl -o json` can be queried by `ID`
or `EVENT` while `journalctl -o cat` still parses the access log (docs/d155).

Rotating the v3 bearer is a staged overlap, never a cut: add the new id to the
exit's keyset, move the relay to the new token, restart the exit, remove the
old id, restart the exit again. Each restart drains (`SIGTERM` waits for live
sessions up to 20 s) instead of truncating them, and a session id joins the
exit's and relay's records for the same connection. A per-key egress table
(docs/d078) travels with its id, so a staged rotation stages policy too.

### Port model (the single knob, docs/d110)

The tailscale funnel serves the whole `https://bazzite…/<funnel-id>` route on
host port **8080**, so the exit node must own 8080. The path table it used to
serve is down to one mount:

| path under the funnel                                      | backend                                       |
| ---------------------------------------------------------- | --------------------------------------------- |
| `/vpn` (the mount prefix, stripped at the edge, docs/d085) | the tunnel namespace — the only face          |
| anything else                                              | the plain funnel 404, byte for byte (VPN-R34) |

The bind has one standard name (docs/d110): env `PORT`, unset → `8080`,
bound on all interfaces. No `-listen`/`-port` flag and no config field of our
own. A second, optional listener is `PORT_CLOUDFLARE`: the port a
Cloudflare (or other capped-edge) connector points at, where
h2-post-unbounded is refused at request initiation and the windowed carriers
serve (docs/d222). Both are bare port numbers; the exit refuses a
`PORT_CLOUDFLARE` that repeats `PORT`.

The suite that used to run against this table (`estige smoke-test`, 34 checks
including the badssl TLS taxonomy) is deleted with it (docs/d108). What
survives is the in-process tunnel suite — `go test ./...`, hermetic, no
outbound internet required.

CI: none exists yet, deliberately — the GitHub Actions findings for
this unit (required steps, runner friction, gate flake points) live in
[CI.md](CI.md), deferred until the d082 split moves the unit to its
own repo.

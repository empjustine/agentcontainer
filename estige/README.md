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
> (`CONNECT`-over-WebSocket, the deployed v2 shape), and
> **h2-post-windowed** (the same h2 POST split into size-bounded windows for an
> edge that caps a single request body). Carriers are named by mechanism,
> never by letters (docs/d105). The relay offers h2-post-unbounded first; a
> capped-edge port refuses it at request initiation and the relay switches to
> websocket → h2-post-windowed for the rest of the process (docs/d222). The
> `-modes`/`MODES` knob retired with docs/d093, and the h1.1 windowed floor
> retired with docs/d239 — its window cannot carry a handshake through a
> buffering gateway, so it fails closed instead of serving unprotected bytes;
> the websocket carrier is the h1.1 path for any edge that passes upgrades.
> Requirements are d188's, negotiation/framing d077's, names d105's, the
> blind `e-relay-auth`/`e-exit-auth` proof pair d104/d131/d236's, and the inner TLS channel
> d169/d236's. v5 is the generation in this binary: every admitted exchange
> carries a mutual single-use proof and every carrier runs an inner TLS 1.3
> session — one per window on h2-post-windowed. The front-door mTLS of d211
> (v6) remains a design on record.

> **Key store (docs/d236).** `estige keygen -principal <name>` mints the
> Ed25519 key and its self-signed certificate in `prv/<principal>.der` and
> `<principal>.crt`, printing the `{name, public}` row to paste into the peer's
> `relay.json`/`exit.json`. `estige public -f <key>` reprints that row from an
> existing key; `estige key check` loads the role stores with the same strict
> parser boot uses _and_ compiles their egress tables the way boot does, so the
> pre-enable gate cannot answer "ok" for a store the node then refuses.
>
> A re-mint is a pin change, not an in-place rotation.

Historical reference for the deleted proxy: llama-swap,
github.com/mostlygeek/llama-swap (`internal/router/peer.go`) — estige was
that substrate (`httputil.ReverseProxy`) with everything else stripped. The
rationale stays in [DESIGN.md](DESIGN.md).

## Install

Packages are the supported deployment. `./node-run.sh estige/build.mjs estige-packages`
writes both artifacts to `estige/packaging/out/`; the binary is self-contained
(no node, jq, or infisical inside the package). The env file belongs to the
operator and to the service manager and carries no configuration; everything a
node needs is its **store** under `$XDG_DATA_HOME/estige`, provisioned once with
`estige keygen` (see "Configuration" below).

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
reads `exit.json` and binds `PORT` (plus optional `PORT_CLOUDFLARE`); the relay
reads `relay.json` and binds only loopback listeners (docs/d090/d236). Both
units set `XDG_DATA_HOME=/var/lib/estige/.local/share` and own `/var/lib/estige`
as their `StateDirectory`, so provision the store under `/var/lib/estige` as the
`estige` user (`estige keygen`, then `estige key check`). Both env files are
conffiles, so `rpm -U` never overwrites operator edits. The units are
left disabled, so installing starts nothing. The unit has an empty
`CapabilityBoundingSet`; a `PORT` below 1024 needs an operator
drop-in with both `CapabilityBoundingSet=CAP_NET_BIND_SERVICE` and
`AmbientCapabilities=CAP_NET_BIND_SERVICE` (the packaged default is 8080).

**Container (binary built on the host; the operator launches the image)**

```console
$ go build .                     # the one compile
$ go run build.go                # packages ./estige into localhost/estige:<VERSION>
$ sudo install -d -o 65532 -g 65532 /var/lib/estige
$ sudo -u '#65532' XDG_DATA_HOME=/var/lib/estige/.local/share ./estige keygen -principal exit-home
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

The exit node, armed by its store (a direct run; a package sources `PORT` and
friends from its env file):

```console
$ ./estige -version                          # the packaged artifact identity
$ ./estige -mode exit                       # ~/.local/share/estige is the config (d236)
[estige] listening on :8080 (tailscale edge: h2-post-unbounded allowed); tunnel at /vpn
$ PORT=8443 ./estige -mode exit              # the tailscale-edge port (docs/d110)
$ PORT=8443 PORT_CLOUDFLARE=8444 ./estige -mode exit
[estige] listening on :8444 (cloudflare edge: h2-post-unbounded refused; windowed carriers only)
```

The funnel points at that port. The relay node (`./estige -mode relay`, or the
packaged `estige-relay.service`) dials in and serves the loopback proxies its
clients use. A node with no store, or a store that does not parse, refuses to
start — there is no other face left to serve (docs/d084's kill-switch law,
docs/d108/d236).

The loopback chain step is `estige proxy-env` (docs/d095): it prints
`export KEY='value'` lines for the relay's listeners so the operator can hand a
consumer the spelling without starting anything.

```console
$ eval "$(estige proxy-env)"
$ ./node-run.sh coding-agent/run.mjs
```

### Configuration: the store is the whole surface

There is **no file the binary reads that the operator does not own**, and no
credential in the environment. The store under `$XDG_DATA_HOME/estige`
(default `~/.local/share/estige`; the packaged units use
`/var/lib/estige/.local/share`) holds every fact that used to arrive as `VPN_*`
env (docs/d236):

```
$XDG_DATA_HOME/estige/          0700
├── relay.json                  relay role: the dial endpoint + the pinned exit certificate(s)
├── exit.json                   exit role: admitted relays (+ per-relay egress) + the process egress table
└── prv/
    ├── <principal>.der         0600   this host's Ed25519 key (PKCS#8 DER)
    └── <principal>.crt         0600   its self-signed certificate — derived, pinned by peers
```

| fact                            | spelling                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| arming fact (the capability)    | the store itself; a node with no parseable store refuses to boot (docs/d084/d236)                                                                              |
| relay dial endpoint             | `relay.json` `endpoint` — http(s)/ws(s), normalized once (docs/d090)                                                                                           |
| pinned peers                    | `relay.json` `exit[]` / `exit.json` `relays[]`, each `{"name", "public"}`; `public` is the certificate                                                         |
| per-principal egress (optional) | an `exit.json` relay row's own `egress` block (docs/d078)                                                                                                      |
| egress opt-ins (VPN-R38)        | `exit.json` `egress`: `{"allowCidrs": ["10.0.0.0/8"], "ports": [443]}`; absent = the defaults                                                                  |
| bind (tailscale edge)           | `PORT` (docs/d110): the Funnel-facing port, where h2-post-unbounded is allowed                                                                                 |
| bind (capped edge, optional)    | `PORT_CLOUDFLARE`: a second port whose connector fronts an edge that caps a request body; h2-post-unbounded is refused there at request initiation (docs/d222) |
| relay label (optional)          | `VPN_CLIENT_LABEL`, log metadata only (defaults to the hostname)                                                                                               |

Why: a credential in the environment is a second copy outside the store's
`0700` boundary (VPN-R32), and the pairing line — endpoint ↔ principal ↔
pinned certificate — belongs in one file a reader can audit at a glance
(docs/d132). Nothing in the environment can _grant_ the capability: only the
store does, and older env spellings fail closed — no fallback, no downgrade.

Provisioning is the binary's own verbs:

```console
$ estige keygen -principal exit-home     # mint key + certificate; prints the {name, public} row
$ estige public -f prv/exit-home.der     # reprint that row from an existing key
$ estige key check                       # load the role files and compile their egress like boot
```

## Build & run

Building is **this folder's own** `./node-run.sh estige/build.mjs` (docs/d083/d113 —
there is no root builder any more; each folder is a copy unit). Targets:

- `estige-native` — the host binary (`estige-android` on Termux; `GOOS=android`
  is required so DNS resolves via Android's resolver — flag presets in this
  folder's own `lib/go-build.mjs`). Needs a working go toolchain, and it is
  also the input to the container image (`go build .` then `go run build.go`).
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
when a second edge's connector points at this exit (docs/d222). Its store's
`exit.json` carries the admitted relays and the egress policy
(docs/d108/d236); the environment adds only the two ports.

Relay node: its store's `relay.json` carries the dial endpoint (http(s):// or
ws(s):// — the URL's honest wire form, normalized to wss internally,
docs/d090; the path is the Funnel mount plus the fixed `/vpn`, docs/d085) and
the exit certificate(s) it expects, with `VPN_CLIENT_LABEL` optional (defaults
to the hostname) and an OPTIONAL chain proxy via the conventional
variables (`SOCKS_SERVER` beats a scheme-matched `http_proxy`/`https_proxy`,
which beats `ALL_PROXY`; `SOCKS_VERSION` must be `5`; `NO_PROXY` deliberately
not read — docs/d094: the chain is ONE blind TCP tunnel under the tunnel leg
only, `Transport.Proxy` stays nil, provider requests never touch it). The
carrier ladder rides whole — h2-post-unbounded → websocket →
h2-post-windowed, ranked per dial, no `-modes`/`MODES` override
(docs/d093/d239). The h2 half is learned: an exit port serving a capped
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

Which peer this relay dials is argv too: `-exit <name>` selects a `relay.json`
exit row — its name is the peer's security principal, and every certificate
stored under that name is pinned, so a staged rotation's two rows both verify
(d133) — and `-endpoint <url>` re-routes the dial without changing trust (the
pinned certificate still decides). With neither flag the store's first exit row
and its endpoint are the defaults; row order is special nowhere else (d236).

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

Secrets (store-only — VPN-R32/d078/d236): an armed exit node (docs/d084/d085)
holds its host key and the admitted relays' certificates in `exit.json`; the
relay holds its own key, the dial endpoint and the pinned exit certificate in
`relay.json`. No credential has an environment spelling, the private half
never leaves its host, and only the public certificate crosses the wire.

### Logs and rotation

Every line is still one line: the access line stays stock Combined Log Format
and session records are logfmt (`ts= role= event= id= key= …`, docs/d106).
Under systemd the same lines become journal entries with fields — detected by
`JOURNAL_STREAM`, no flag — so `journalctl -o json` can be queried by `ID`
or `EVENT` while `journalctl -o cat` still parses the access log (docs/d155).

Rotating a principal's key is a staged overlap, never a cut (docs/d133): mint
the new key on its host, add its certificate row **in the peer's store** beside
the old one under the same name (the grammar allows two entries per name, and
either verifies), restart the peer, then remove the old row and restart again.
The name never moves, so no configuration changes; only the certificate does.
A re-mint of the same key is a pin change, not a rotation — the peer's pin must
move with it. Each restart drains (`SIGTERM` waits for live sessions up to 20 s)
instead of truncating them, and a session id joins the exit's and relay's
records for the same connection. A relay row's own egress table (docs/d078)
travels with its name, so a staged rotation stages policy too.

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

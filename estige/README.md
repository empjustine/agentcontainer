---
id: estige
type: reference
status: stable
title: "estige — SSL-VPN tunnel transports (exit node + relay node)"
parent: architecture
tags: ["serving", "proxy", "go"]
---

# estige

One static Go binary, two network positions: an **exit node** at the edge that
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

## Usage

The exit node, armed by the env chain:

```console
$ ./lib/environment.sh ./vpn-exit.sh      # VPN_OPERATOR_KEYS arms the tunnel
[estige] listening on :8080; tunnel at /vpn
```

The funnel points at that port. The relay node (`./vpn-relay.sh`) dials in and
serves the loopback proxies its clients use. A node with no operator credential
refuses to start — there is no other face left to serve (docs/d084's
kill-switch law, docs/d108).

```console
$ ./estige -mode exit -listen :8080            # tunnel policy from defaults
$ ./estige -mode exit -config tunnel.json      # optional policy file
$ ./estige -mode relay                         # relay node, env-driven
```

### Configuration: policy only

`-config` names an **optional** file carrying `tunnel.egress` (the CIDR/port
allowlist the exit enforces, default `deny`) and `tunnel.enabled` (a tri-state
veto/assert, docs/d084). It cannot grant the capability and cannot hold a
credential: arming is the env chain's job, and a file on disk holding a
credential would be a second, unkeyed copy of it (VPN-R32). The bind is the
`-listen` flag; the allowlist and its generator are gone (docs/d108).

## Build & run

Building is the root `./build.sh` → `build.mjs` (docs/d041 — the per-folder
`build.sh` files are gone): container images in parallel on podman/docker
hosts, Termux targets strictly serialized. For THIS folder:

- **Termux**: builds the native `android/arm64` binary
  (`estige-android`; `GOOS=android` is required so DNS resolves
  via Android's resolver — flag presets in `lib/go-build.mjs`). Needs
  `pkg install golang`.
- **Container hosts**: builds ONLY the OCI image (`Containerfile`:
  MULTI-STAGE `golang:1.27` → `scratch` — the compile happens inside the
  image build, so no host go toolchain is needed, just podman/docker.
  `scratch` is deliberate: the final stage pulls from NO registry, so the
  image builds where non-docker.io registries are blocked; the image ships
  the CA bundle both TLS legs (upstream certs, Funnel `*.ts.net`) verify
  against and is ~7.5 MB final). The behavioural suite is `go test ./...`
  in this folder — no node, curl, or python3 on the host (docs/d102).
- **Bare host without a container tool**: host binary only — go is required,
  it is the only thing this host can build and serve.

Each deployment is its own entry point (docs/d095): `./vpn-exit.sh` serves
the exit node, `./vpn-relay.sh` serves the relay node — or, given a target,
acts as the CHAIN STEP that points that target at the relay (below). ROLE —
per docs/d088 the two deployments are named by network position, not
protocol role: the **exit node** has free, unblocked internet plus tsnet
connectivity to the actual LLM endpoints, and traffic exits the local
environment through it; the **relay node** (the loopback CONNECT/SOCKS5
proxy feeding the tunnel transports; docs/d073 §7) runs locally on a
restricted-internet environment, without direct tsnet to the endpoints.
The code speaks the same names (d088 phase 2 landed). HOST:
the container branch runs in HOST NETWORK mode; the native branch execs
the binary directly. Exit node: listening on `${HOST_PORT:-8080}` (the
funnel front, `-listen 0.0.0.0:$HOST_PORT` for the container, `${LISTEN:-:8080}`
for native) — host networking is what makes a loopback upstream reachable from
the container. No config is mounted by default; `CONFIG` names a policy file
(native: that path; container: mounted at `/etc/estige/tunnel-policy.json`) and
the launcher fails if it cannot be read — the file carries `tunnel.egress`
alone (docs/d108). Relay node: NO config file — `VPN_TUNNEL_URL` (http(s):// or
ws(s):// — the URL's honest wire form, normalized to wss internally,
docs/d090; the path is the Funnel mount plus the fixed `/vpn` —
docs/d085) and `VPN_OPERATOR_TOKEN` are its core surface, with
`VPN_CLIENT_LABEL` optional (defaults to the hostname) and an OPTIONAL chain
proxy via the conventional variables (`SOCKS_SERVER`
beats a scheme-matched `http_proxy`/`https_proxy`, which beats `ALL_PROXY`;
`SOCKS_VERSION` must be `5`; `NO_PROXY` deliberately not read — docs/d094:
the chain is ONE blind TCP tunnel under the tunnel leg only, `Transport.Proxy`
stays nil, provider requests never touch it),
the transport ladder rides whole — h2-POST → WebSocket → h1.1-POST ranked at
dial time, no `-modes`/`MODES` override (docs/d093) — and
`PROXY_LISTEN`/`SOCKS_LISTEN` defaulting to `127.0.0.1:3128`/`1080`;
host networking is a requirement there too (the loopback listeners must
be the HOST's loopback — VPN-R23 forbids exposing them — and the tunnel
URL needs the host's tailnet routes).

`vpn-relay.sh <target>` is the CHAIN STEP (docs/d095): it ensures the relay
is serving, waits for a health answer naming *this* tunnel, exports the
conventional variables pointing at the loopback listeners, and execs the
target — so `./lib/environment.sh ./estige/vpn-relay.sh
./coding-agent/run.sh` hands the sandbox the loopback spelling while the
relay itself keeps the host's upstream chain (docs/d094). A relay that is
not running is started (detached, `--restart=unless-stopped`); an
unreachable or foreign listener refuses the launch by name. Secrets
(env-only — VPN-R32/d078; the launchers never load secrets themselves; the
in-progress d104 credential redesign moves the tunnel keys into the on-disk
key store): an armed exit node (docs/d084/d085: armed when the env carries
the operator keyset) holds the
keyset (`VPN_OPERATOR_KEYS`), and the relay node holds the operator token
(`VPN_OPERATOR_TOKEN`) — disjoint since docs/d090, which retired the
keyset's implicit-`default` merge of the token — and all reach the
container only through the launcher env allowlists.

### Port model (the single knob, docs/d110)

The tailscale funnel serves the whole `https://bazzite…/<funnel-id>` route on
host port **8080**, so the exit node must own 8080. The path table it used to
serve is down to one mount:

| path under the funnel | backend |
|---|---|
| `/vpn` (the mount prefix, stripped at the edge, docs/d085) | the tunnel namespace — the only face |
| anything else | the plain funnel 404, byte for byte (VPN-R34) |

How the bind is spelled today (the `-listen` flag in both branches,
`HOST_PORT`/`LISTEN` in the launchers) is the subject of d110: one port,
one knob, env `PORT`.

The suite that used to run against this table (`estige smoke-test`, 34 checks
including the badssl TLS taxonomy) is deleted with it (docs/d108). What
survives is the in-process tunnel suite — `go test ./...`, hermetic, no
outbound internet required.

CI: none exists yet, deliberately — the GitHub Actions findings for
this unit (required steps, runner friction, gate flake points) live in
[CI.md](CI.md), deferred until the d082 split moves the unit to its
own repo.

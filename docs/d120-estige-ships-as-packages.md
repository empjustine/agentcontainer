---
id: d120
type: decision
status: implemented
title: "d120 — estige ships as OS packages, and its POSIX launchers retire"
parent: estige
depends-on: [d041, d083, d088, d090, d095, d102, d106, d108, d110, d113]
references: [d046, d073, d094, d130]
tags: ["estige", "packaging", "systemd", "runit", "shell-retirement"]
---

# d120 — estige ships as OS packages, and its POSIX launchers retire

## Problem

estige is a stdlib-only Go binary (`go.mod` has no `require` line,
docs/d102) configured entirely by environment and holding no on-disk state.
It nonetheless shipped as a **script** product: two POSIX launchers
(`vpn-exit.sh` 95 lines, `vpn-relay.sh` 282), a 328-line shell + jq
description library and six `workload-*.jq` filters (241 lines) whose whole
job was to render one `podman container run` argv.

That library was the last thing in the unit wanting jq and a second language
to test, and both of its consumers existed only to start a process a package
can install as a service. The audit trail is one line: a Go binary that reads
no config file needed 946 lines of shell to reach `exec`.

## Decision

**Packages are the only supported deployment.** Two artifacts, built from a
`packaging/` tree inside the unit: a `.deb` for Termux (aarch64, supervised by
busybox runit through `termux-services`) and an `.rpm` for Oracle Linux 8/9
(x86_64, supervised by systemd, hardened). The container **image** stays —
`Containerfile` and the `estige-image` target are untouched — but the operator
launches it, this repo no longer does.

Deleted with the launchers: `vpn-exit.sh`, `vpn-relay.sh`,
`lib/workload-runtime.sh`, `lib/workload-*.jq`, `lib/node-run.sh`,
`lib/log.sh`, and the shell test that drove them
(`tests/check-vpn-relay-chain.sh`). `estige/lib/` now holds only what the
build needs: `go-build.mjs`, `host-capabilities.mjs`, `log.mjs`.

### What each launcher responsibility became

| Launcher job | Now owned by |
| --- | --- |
| container launch with host networking, init, hardening | the image's documented `podman run` recipe; no code in the repo |
| supervised restart (`--restart unless-stopped`, native supervisor loop) | the service manager (`Restart=on-failure`, runit's `runsv`) |
| readiness probe before handing out the proxy spelling | the service manager; the chain step no longer starts anything |
| refusing a self-chained relay (ambient proxy env naming its own listener) | **the binary** — `relayConfigFromEnv` refuses before any bind, exit 94 unchanged (docs/d095) |
| exporting the loopback proxy spelling to a child | `estige proxy-env`, printing `export KEY='value'` lines for `eval` (both cases of every variable, `socks5h` for `ALL_PROXY` — docs/d130) |
| `termux-provisioning`'s `pkg install node jq` | nothing estige needs; the provisioner keeps both for the units that still do |

### The packages are written by pure Go

`packaging/` holds the format inputs plus the writers: stdlib `ar` + `tar` +
`gzip` for the deb, and a v3 lead, signature header, immutable header and
gzip-compressed newc `cpio` payload for the rpm. No `dpkg-deb`, no
`rpmbuild`, no containerized packaging tool — any host with a Go toolchain
produces both. The `estige-packages` build target cross-compiles both payload
binaries (android/arm64, linux/amd64), so a single amd64 runner emits the
Termux deb and the OL rpm.

This is the same bet docs/d102 made about the generator and docs/d108 made
about the allowlist: the unit's own tooling speaks the unit's language, and
the dependency budget stays at zero.

### One version spelling

`packaging/VERSION` is the artifact identity: `commonBuildFlags` injects it
with `-ldflags=-X main.version=…`, `estige -version` prints it, and both
`control`/`%files` read the same value (override with `ESTIGE_VERSION` for a
release build that has not bumped the file). Dashes are rejected — RPM splits
version/release on them and Debian uses them for a revision.

### Secrets stay on the env chain

Neither package runs infisical: a packaged service has no vault login state.
The package ships a commented env template (mode `0600`, a conffile, so an
upgrade never overwrites an operator's edit) and installs **disabled**: the
Termux service ships an empty `down` file (runit semantics — `sv-enable` is
the explicit start), and the systemd units carry a normal
`[Install] WantedBy=multi-user.target` that the package simply never enables
(`%post` only runs `daemon-reload`). Starting an unedited credential would
fail anyway, but a package that fails loudly on install is a package that gets
uninstalled.

## Invariants

- Configuration stays **env only, one spelling per fact** (docs/d090,
  docs/d108); `PORT` remains the only bind spelling (docs/d110) and no
  `-port` flag appears to make packaging easier.
- Role credential disjointness (docs/d090) survives into both env templates:
  the exit node reads `VPN_OPERATOR_KEYS`, the relay `VPN_OPERATOR_TOKEN`.
- Logs stay Combined Log Format on stdout (docs/d106), unpiped; the service
  manager owns collection (`svlogd`, the journal).
- The binary writes no state, so no `StateDirectory=` and no key material is
  invented ahead of docs/d104's role store.
- A relay refuses a self-chained ambient proxy with the launcher's old exit
  status 94 — the code moved, the contract did not.
- `CapabilityBoundingSet=` is **empty** by default (the packaged `PORT` is
  8080); an operator wanting `:80` adds `CAP_NET_BIND_SERVICE` as a documented
  drop-in, never as a default.

## Alternatives rejected

- **Keep the launchers and replace only jq** with a node helper. Halves the
  runtime surface and keeps the container path byte-identical — rejected
  because the launchers exist only to start a process a package installs, and
  they were the last shell in a Go unit.
- **nfpm** (one YAML, both formats). Least code by far, but it adds the first
  real dependency to a module that has none.
- **`DynamicUser=yes`** instead of a dedicated `estige` system user. Tidier
  for a stateless service, but it turns the env file's ownership into a
  boot-time question and weakens journal attribution.
- **`estige@.service`** with the role as an instance. The roles carry
  disjoint credentials and different listeners, and an instance unit invites
  the wrong default; two files say it plainly.
- **Host packagers driven by `build.mjs`** (`dpkg-deb`, `rpmbuild`) as the
  primary path. It puts a build-host requirement on every machine that only
  wants to produce an artifact, and it keeps a second language in the loop.

## Consequences

- `estige/` no longer carries any shell except `build.sh`'s node bootstrap —
  the repo's only remaining workload-runtime shell copy is
  `llm-local-inference/`'s (docs/d113's copy-unit rule unchanged, its
  inventory thinner).
- The `jq` compile gate in `./lint.sh` now guards exactly one unit's filters.
- `docs/d095`'s chain-step mechanics are superseded in part: the chain step is
  a binary verb and starts no relay. Its "the relay node is a host service"
  half is unaffected — a package is that host service.
- The rewrite changed two exported values without deciding to: the SOCKS
  scheme lost its `h` and the lowercase spellings were dropped. docs/d130
  records both regressions, the live evidence, and the restored contract —
  the export is now a test-pinned contract with the listener, not a
  transcription of the old script.
- Verified here: both artifacts build; the deb's fields, contents and modes
  are inspected; the rpm is queryable, its four digests verify
  (`rpmkeys --checksig`), and a fake-root `unshare -r` install/upgrade/erase
  round-trip preserves an operator edit and leaves `estige.env.rpmsave` on
  erase.
- Left to a real host: installing the deb on Termux (`dpkg -i` + `sv-enable`,
  `svlogd` output), `systemd-analyze security` scoring, and an Oracle Linux
  boot. No `podman`/`docker` on this box, so `estige-image` was not rebuilt;
  the rpm checks used Debian's extracted `rpm` because no native one exists.

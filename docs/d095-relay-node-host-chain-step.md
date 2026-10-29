---
id: d095
type: decision
status: implemented
title: "d095 — the relay node is a host service, and vpn-relay.sh is its chain step"
parent: llm-reverse-proxy
depends-on: [d046, d088, d093, d094]
references: [d059, d070, d079, d082, d084, d090]
---

# d095 — the relay node is a host service, and vpn-relay.sh is its chain step

## Problem

d094 gave the relay node a route through the conventional proxy variables.
That leaves the other half of the deployment story unstated: **who points a
local consumer at the relay?** The variables are the one spelling a
restricted network already speaks, so the answer has to be an env fact — and
an env fact that is *wrong* is worse than no env fact at all. Point a client
at a loopback listener with nothing behind it and every request that honors
the variable fails, including requests that would have worked direct: a
dead proxy address is a total egress outage wearing a routing costume.

Two shapes were available and neither was chosen deliberately:

- **Ambient forwarding.** `coding-agent/run.sh` forwards the host's
  `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` into the sandbox (docs/d074). On
  the very host d094 targets, those are the *corporate* values, so the
  sandbox dials the corporate proxy directly and never touches the tunnel —
  d079 §2.4's named regression, with d094's chain variables and the sandbox's
  proxy variables colliding under one spelling.
- **A bare export.** Whoever remembers to export the loopback spelling
  inherits the dead-address failure mode above, with no readiness check, no
  start, and no way to tell "the relay is down" from "the network is down".

Meanwhile the launcher carried a third spelling of the same fact: `run.sh`
selected the deployment with `PROXY_MODE=exit|relay` — a two-valued knob
whose every value names a *different* script, and which cannot express the
thing the relay side actually needs (start the relay, then run a child under
it). d093 retired `-modes` for exactly this reason: a knob that can only
restate what the code already knows.

## Decision

1. **The deployment identity is the entry point, not an env value.**
   `llm-reverse-proxy/vpn-exit.sh` serves the exit node;
   `llm-reverse-proxy/vpn-relay.sh` serves the relay node. `run.sh` and
   `PROXY_MODE` retire — `PROXY_MODE=exit ./run.sh` becomes
   `./vpn-exit.sh`, `PROXY_MODE=relay ./run.sh` becomes `./vpn-relay.sh`.
   Both still pass `-mode exit|relay` to the binary explicitly, so the
   binary's flag (d088) stays the wire-level spelling and the scripts are
   argv assemblers, not a new knob. `-mode` remains the only way to say it
   to the binary. No alias is read for `PROXY_MODE`: a stale invocation is
   a loud "no such file" on `run.sh`, and the variable itself is simply
   never read — d093's precedent for a retired knob.

2. **The exit node is NOT a chain step.** It is the far side: no local
   consumer to route, and its provider egress is direct by policy
   (`egress.go`). There is nothing to export and no child to wrap. The
   chain step lives on the side that serves a proxy.

3. **`vpn-relay.sh` has two modes, selected by argv shape:**
   - **serve** (no arguments): run the relay in the foreground — the
     loopback CONNECT/SOCKS5 listeners become the HOST's loopback
     (VPN-R23), the tunnel URL rides the host's tailnet routes. Foreground
     on purpose: the operator sees the relay's logs and Ctrl-C stops it.
   - **chain** (arguments): ensure a relay is serving, gate readiness,
     export the conventional proxy variables pointing at it, then `exec`
     the target:

     ```
     ./lib/environment.sh ./llm-reverse-proxy/vpn-relay.sh ./coding-agent/run.sh
     ```

     One vault round-trip (d046) buys the relay its credential and the child
     its environment; the child never holds `VPN_OPERATOR_TOKEN` (d090).

4. **The chain step's contract — four steps, in order:**

   1. **Refuse before probing.** Missing `VPN_TUNNEL_URL` /
      `VPN_OPERATOR_TOKEN` is an error naming the variable, before any
      socket is touched (the mirror of the binary's own startup gate;
      VPN-R26/NFR-2).
   2. **Probe, and never trust an answer that is not ours.** The probe is
      `GET /healthz` on the loopback listener, and the identity check is
      the `tunnel` field compared against the URL normalized exactly as the
      binary normalizes it (d090: http(s) → ws(s)). Three outcomes:
      *ours* → reuse; *nothing answered* → start; *something else
      answered* → refuse by name. A foreign listener squatting on the port
      must never become the child's silent proxy, and a second relay must
      never be started behind it.
   3. **Start, then wait bounded.** Detached, host-network, with a restart
      policy (below). A relay that cannot come up is a loud failure after a
      bounded wait — never a hang, never a child against a dead spelling.
   4. **Derive the child's env and exec.** `HTTP_PROXY`/`HTTPS_PROXY` (and
      their lowercase spellings) point at the CONNECT listener,
      `ALL_PROXY`/`all_proxy` at the SOCKS5h listener (VPN-R24), and
      `NO_PROXY`/`no_proxy` is `127.0.0.1,localhost,::1` **merged with the
      host's list**: loopback stays direct — the relay itself, and any
      host-local service, must not depend on the tunnel being up — while an
      operator's internal suffixes keep their meaning.

5. **The env sequencing is the whole point, and it is pinned.** The relay's
   own upstream chain (d094) is read from the HOST environment, so the chain
   step starts the relay *before* it exports the loopback spelling. Export
   first and the relay chains to itself. A guard refuses the start outright
   when the ambient proxy spelling already names the listener it is about to
   start.

6. **The relay is a host service with a stable address.** The child is
   handed a fixed `127.0.0.1:3128`/`:1080`, so the listener must survive a
   crash: the detached container launch carries `--restart=unless-stopped`
   (new `workload_restart` in the workload API), and the native path (Termux
   / no container tool) runs the binary under a background supervisor loop.
   Both are **orphaned on purpose** — the relay is shared by every sandbox and
   host app, so it outlives the child it was started for. Serve mode is
   attached and carries no restart policy; there is no child to keep alive.

7. **This IS the launch-time guard d079 §2.4 asked for.** d070's
   zero-canonical guarantee was re-homed as "refuse to start a harness unless
   the proxy env is present, well-formed, and aimed at the expected loopback
   listener". The chain step cannot export the spelling without a verified
   listener, and it runs before the sandbox exists — so the guard is the
   wrapper's readiness gate, not a check inside the launcher. A consumer that
   rides the chain step needs no new check of its own:
   `coding-agent/run.sh`'s existing `workload_env_allowlist` line now
   forwards the *loopback* values, because the chain step rewrote the host
   env before the launcher ran. Host-side consumers that read the env
   directly (`lib/node-run.sh`'s `NODE_USE_ENV_PROXY=1` generators) ride the
   same relay for free.

## Alternatives rejected

- **Export-only (no wrapper).** `export HTTP_PROXY=http://127.0.0.1:3128`
  in the caller, or deriving the values inside `coding-agent/run.sh`. No
  start, no readiness gate, no identity check: the dead-address outage is
  the default outcome of a relay that is not running, and the sequencing
  (relay gets the corporate spelling, child gets the loopback one) has no
  single owner.
- **Wrapping binaries inside the sandbox** (a proxychains-style prefix, or
  `LD_PRELOAD`). The env is inherited by everything the sandbox spawns, so
  a wrapper is redundant when the launcher sets it; and it is worse than
  redundant here — the harnesses are mise shims that mise regenerates, a
  wrapper only catches `PATH` invocations (an absolute-path exec or a nested
  spawn misses it), and `LD_PRELOAD` intercepts libc `connect`/`getaddrinfo`,
  which Go binaries and statically linked tools bypass entirely. One wrapper
  per tool is N spellings of one fact.
- **Fail-open (fall back to direct when the tunnel is down).** Re-creates
  exactly the silent bypass d079 §2.4 exists to prevent; on a restricted
  network direct does not work anyway, and on an open host the opt-out is
  "don't use the chain step", not a hidden fallback.
- **Running the relay inside the sandbox.** The operator token would live in
  the sandbox and the tunnel would originate there; the loopback listeners
  would stop being the HOST's (so no host app could use them), and every
  sandbox would pay its own tunnel.
- **Keeping `PROXY_MODE` as a back-compat alias.** Two spellings of a
  deployment identity, one of which cannot express the chain shape. d093's
  precedent: the knob retires with the code that read it.

## Acceptance

- On a host with the vault: `./lib/environment.sh
  ./llm-reverse-proxy/vpn-relay.sh ./coding-agent/run.sh` starts or reuses
  the relay, and the sandbox's proxy env is the loopback spelling.
- Relay absent → started, then the child runs; relay unreachable after the
  bounded wait → exit 94 naming the relay, no child.
- A foreign listener on the port → exit 94, no child, no second relay.
- `VPN_OPERATOR_TOKEN` missing → exit 94 naming the variable, before any
  probe.
- The relay container's argv: `--detach --restart=unless-stopped
  --network=host`, the chain variable *names* forwarded (d094), the
  loopback spelling nowhere in its own chain env.
- `tests/check-vpn-relay-chain.sh` pins all four; `tests/check-workload.sh`
  pins the `--restart` flag position.

## Not in this record

- **Enforcement.** The sandbox shares the host network namespace
  (`coding-agent/run.sh`), so the loopback spelling is a convention a
  harness can ignore. Turning it into a wall (an egress firewall matched to
  the sandbox UID, or a non-host network plus a relaxed VPN-R23) is its own
  decision; the repo's posture stays "loud env-shape guard", per d079 §2.4.
- **Non-pi harness coverage.** d079 §6's per-harness proxy support remains
  open; a harness that ignores the env is the only case where a targeted
  wrapper is justified.

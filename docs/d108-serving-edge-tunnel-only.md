---
id: d108
type: decision
status: accepted (direction of record; removal pending implementing changes)
title: "d108 — the serving edge moves to tunnel-only: the bazzite llama-swap provider is deprecated for now, the allowlist reverse proxy (legacy mode A) is deprecated as insecure"
parent: estige
depends-on: [d027, d047, d063, d070, d073, d077, d080, d105]
references: [d103, d104, d106]
tags: ["serving", "proxy", "llama-swap", "deprecation", "tunnel", "estige", "mode-a"]
---

# d108 — retire the serving edge toward tunnel-only

## Problem

Two surfaces still describe the 2025 serving shape, and they are not in the
same state: one is paused, the other is now judged insecure.

- **The bazzite llama-swap farm is a first-class provider.** It has a
  fact-table row, a generated pi/opencode provider block, a
  `REVERSE_PROXY_API_KEY` bearer, and a tsnet row in the allowlist. It is
  the only local-inference provider, so every generated client carries a
  dependency on one host's GPU state.
- **The allowlist relay is the world-facing edge.** The *allowlist relay*
  (d105's name; the host-form `/<upstream-host>/<path>` table, d047) is the
  default and d073's VPN-R1 says it MUST stay the default. Two costs come
  with that:

  1. **It requires full trust of the proxy.** The Funnel edge terminates
     the client's TLS and hands the proxy plaintext, so the proxy
     necessarily sees provider keys. d073's trust table records this
     plainly: the allowlist relay and authenticated relay both answer
     "yes" to *client trusts the proxy?*; only the tunnel transports
     answer "no". That property is inherent to the reverse proxy, not a
     bug to harden later — and a proxy that sees every provider key is a
     single point of compromise for the whole fleet's credentials.
  2. **It needs route-rewriting generator magic.** Clients must address
     `<base>/<upstream-host><full-upstream-base-path>`; the generators
     therefore probe routes through the edge (`REVERSE_PROXY_BASE_URLS`,
     `route-probe.mjs`), substitute the canonical upstream with the routed
     form at install time (d063/d070), and verify the substitution
     (`check-routed-artifacts.mjs`). Every provider addition and every base
     rotation is therefore a generator change, and every client's URL is
     rewritten rather than used as published.

The trigger for acting on the second surface is deployment evidence: the
first few **v3** tunnel deployments are exercised and working, so the edge no
longer needs mode A to be reachable at all.

## Generations, and which two axes are in play

The rollouts are named by generation. These are the generations this record
refers to:

| Generation | Edge | Operator credential | State |
| --- | --- | --- | --- |
| **v2** | allowlist relay (legacy name **mode A**) | none at the edge; provider keys traverse it | deployed, in use |
| **v3** | tunnel transports — h2-POST / WebSocket / h1.1-POST (d073/d077) | shared bearer, injected as env | deployed, working |
| **v4** | the same tunnel transports | d104's mutual time-windowed Ed25519 proofs | in progress, not yet exercised |

Two older vocabularies must not be read across into that table. d073/d077
number **delivery** generations (their v2 bundles the allowlist relay *and*
the WebSocket tunnel; their v3 is the authenticated relay, still unadopted),
and d104 numbers **credential** generations (its v1 is the shipped bearer, its
v2 is the Ed25519 scheme). "v3" below always means the deployed tunnel
generation; "v4" always means that generation under d104.

The point of the distinction: **v3 is not the security end state.** It proves
the tunnel shape works, and it already removes the plaintext-key problem,
because a tunnel carries a `CONNECT`/SOCKS5 stream and the client validates
the upstream's real certificate end to end. It does *not* fix the operator
credential — a long-lived shared bearer that any compromised relay or exit can
replay. That is d104's work (v4), and mode A's deprecation does not wait for
it: no credential scheme can make a TLS-terminating proxy stop seeing plaintext
provider keys.

## Decision

### The llama-swap/bazzite provider: deprecated for now

- `llm-local-inference/`, the `llama-swap` fact-table provider, its
  generated client blocks, and the `bazzite.coelacanth-barb.ts.net`
  allowlist row are **deprecated for now**. "For now" is deliberate: no
  removal date is set, the code stays, and the existing generation keeps
  working. Deprecated means *no new clients and no new features*, not
  "deleted".
- New deployments should not add a llama-swap provider or a tsnet row for
  one. A host that still runs the farm keeps working until the code is
  removed.
- Reversing this pause (or removing the folder) is a new decision record,
  not an edit to this one.

### mode A: deprecated as insecure, and estige stops exposing it

- The allowlist relay is **deprecated now**, not held in reserve. It is not a
  fallback, not a supported onboarding path, and not the thing a new host is
  configured for. d073's VPN-R1 (the allowlist MUST remain the default) is
  superseded by this record.
- **estige stops exposing mode A.** The surface goes away — that is the end
  state the removal diffs must reach, not optional cleanup:
  - no `allowHosts` in the configuration schema, and no host-form
    `/<upstream-host>/<path>` routing;
  - `estige generate` no longer emits an allowlist, so `lib/cloud-providers.json`
    stops being the edge's ACL source;
  - no mode selection that can put the binary back into reverse-proxy
    service, and no documentation presenting the shape as available
    (`estige/README.md`/`estige/DESIGN.md` describe it as removed, not as
    an option);
  - the smoke test's mode-A checks go with the code they check.
- **The generators stop depending on mode A.** `REVERSE_PROXY_BASE_URLS` as
  a generator input, `providerRouteUrl()`, the route probes, the
  install-time canonical→route substitution (d063/d070), and the
  zero-canonical verification (`check-routed-artifacts.mjs`) are deleted,
  not kept for compat. Until the generator change lands they keep failing
  closed exactly as they do today: a half-migrated client must not silently
  fall back to direct provider URLs.

The two obligations are ordered by this record, but they are separate
implementing changes (see *Open items*); this record changes no code.

### What stays until the removal diffs

- The mode-A code paths, the tracked `estige/estige.json` `allowHosts`
  block, and the smoke-test expectations stay in the tree until the removal
  diff, so deployed hosts keep their edge while the generators move. What
  changes now is that nothing presents them as the supported shape.
- Historical records (d047, d063, d070) keep their verdicts and their text.
  This record supersedes their *currency*, not their history.
- The tunnel family, the relay/exit entry points, egress policy, and d104's
  credential work are unaffected and remain the active direction.

## Why this direction

- **mode A is insecure by construction.** A reverse proxy that terminates the
  client's TLS sees every provider key in clear, and the edge is
  world-facing. That is not a deployment-hygiene problem: it is the
  architecture. Removing it removes the requirement to trust the proxy host
  with the fleet's credentials.
- **The generator cost is structural too.** A routed base URL is a
  synthesized value; it must be probed, substituted, and re-verified on
  every install. A tunnel changes the transport, not the provider's
  published base URL, so the generators can stop owning route knowledge
  entirely.
- **The evidence is now sufficient.** mode A existed because the tunnel was
  unproven. With v3 deployments working, keeping the allowlist buys
  continuity for hosts that should migrate anyway, and costs a permanent
  plaintext-key exposure plus per-provider generator edits.
- **Local inference is paused, not replaced.** The fleet's provider lineup
  can be cloud-only for now; a future local-inference path gets its own
  decision when there is a reason to spend GPU time on it.

## Consequences

- `README.md`, `docs/architecture.md`, `docs/environments-and-variants.md`,
  `docs/requirements.md`, and `estige/`'s own docs stop presenting mode A
  as supported; the requirement text stays readable, annotated as
  deprecated-in-part.
- `docs/requirements.md`'s FR-S1–FR-S5 and FR-U2 carry the deprecation note;
  the BRD is not rewritten wholesale.
- The coding-agent generators keep their current behaviour (fail closed
  without `REVERSE_PROXY_BASE_URLS`) until the tunnel transport replaces
  that input. A silent fallback is explicitly not part of the migration.
- `estige.json`'s `allowHosts` and the host-form routing code lose their
  forward investment. The file itself is **removed, not shrunk**: with
  mode A gone it holds nothing but exit-role facts, and tree-shaking
  moves them where role facts live — `tunnel.enabled` dissolves into
  d104's helper-presence arming, `tunnel.egress` lands in d104's
  `exit.json` (d104 owns the store's schema), and `listen` dies: a
  single-port bind is configured by env `PORT` alone (d110) — until
  `loadConfig`, the tracked `estige.json`, and `estige.example.json`
  have no reader left and die with the removal diffs.
- External clients that use `<funnel>/<host>/<path>` keep working until the
  removal diff, but are not the supported onboarding path and will not be
  carried forward.
- `llm-local-inference/` keeps its generated artifacts and run path; the
  folder is marked deprecated in its own design doc and the README map.

## Alternatives rejected

- **Keep mode A as a fallback.** A fallback edge keeps the plaintext-key
  exposure alive and keeps the generators coupled to routed base URLs; the
  tunnel is proven, so there is nothing left for the fallback to protect
  against.
- **Freeze mode A instead of removing it.** Freezing still documents,
  generates, and tests a shape whose trust model is rejected; the surface
  would be re-adopted by the next provider addition.
- **Delete the edge in this change.** The generators still emit routed base
  URLs; deleting the edge before they move would break installed clients
  with no replacement path. The sequencing is deliberate and lives in *Open
  items*.
- **Keep the allowlist but stop rewriting routes.** Clients would still have
  to carry the host-form path and the proxy would still see plaintext; it
  removes the generator magic without removing the trust problem.
- **Extend the host allowlist to the forward surface.** d080 already settled
  this: the forward surface carries egress policy, not a host set.
- **Replace route rewriting with a new rewriting layer.** Any layer that
  synthesizes client base URLs re-creates the same coupling.

## Open items

- Removal sequencing, as separate implementing changes: (1) documentation
  stops presenting mode A (done by this record), (2)
  move the coding-agent to the tunnel transport and delete the
  route-substitution input, (3) remove `allowHosts` + `estige generate`'s
  allowlist emission, (4) delete the reverse-proxy code and its smoke-test
  checks, (5) tree-shake `estige.json` out of the tree — sequenced after
  (3) and with d104's store, since `egress` needs its new home
  (`exit.json`) before the file can die (`listen` needs none — d110).
- Where the v2/v3/v4 generation vocabulary lives. d105 owns transport names,
  not generations; until that record is amended, this table is the reference.
- What, if anything, serves local models after the llama-swap pause.
- How external (non-fleet) clients are onboarded onto the tunnel.

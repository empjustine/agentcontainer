---
id: d070
type: decision
status: implemented
title: "d070 — canonical upstream URLs in committed artifacts; the reverse-proxy route is substituted at install time; SKIP_GEN retired"
parent: coding-agent
depends-on: [d047, d050, d054, d057, d063, d071]
references: [d024, d027, d033, d041, d060, d064, d065]
tags: [generators, routing, reverse-proxy, determinism, pi, opencode, security]
---

# d070 — canonical upstream URLs in; the reverse-proxy route at install

**Status: implemented.** Committed `coding-agent` artifacts (`models.json`, the
`model-*.json` layers, `opencode.jsonc`) carry each provider's REAL upstream
URL. The reverse-proxy route is derived and substituted only at the moment
generate copies an artifact into a host's canonical config dir (`~/.pi/agent`,
`~/.config/opencode`, …). `SKIP_GEN=1` is retired with the design that made it
necessary. Terminology for the substituted base is owned by
[d071](d071-retire-peer-terminology.md); this record uses its vocabulary.

## Problem

Every committed artifact currently embeds the full vault-sourced funnel URL —
`https://<funnel-host>/<funnel-id>/<upstream-host><base-path>`. Three things
are wrong with that:

- **The `<funnel-id>` path segment is a semi-credential.** It is the
  capability that addresses the funnel; anyone who can read the repo holds it
  (tailnet membership still gates the wire, but the secret should not live in
  git). [d063](d063-proxy-only-routing.md)'s alternatives rejected hardcoding
  the proxy URLs; generation-time derivation baked the same value in through
  the back door.
- **Vault state in git couples rotation to code review.** A funnel rotation
  diffs seven artifacts, so the d050 review ("regenerate + `git diff`")
  conflates "the model lineup changed" with "the operator's endpoint
  rotated".
- **`SKIP_GEN=1` exists only because of that baked-in completeness.** It lets
  a vault-less host install the committed artifact as-is — which is only safe
  because the committed artifact is proxy-routed. The leak and the escape
  hatch are one design.

The URL has exactly two moments that matter: it is *probed* at generate time
(lineup selection) and *emitted* at install time. Committing it serves
neither.

## Decision

1. **Committed artifacts carry the real upstream URL.** Every provider's
   `baseUrl`/`options.baseURL` in `models.json`, the layers and
   `opencode.jsonc` is the upstream's actual https URL, taken from
   `lib/cloud-providers.mjs` — the same fact table the proxy allowlist and
   the client-route derivation are generated from (d047's one-source rule).
   No configured base, no funnel id, no proxy hostname appears in any
   committed artifact. (pi's `api` field is a dialect string, not a URL —
   `baseUrl`/`options.baseURL` are the only rewritten fields.)
2. **llama-swap stops being an exception.** Its upstream becomes a real
   https hostname served by `tailscale serve` on the llama-swap host,
   ROOTED at the hostname itself (the serve endpoint maps the host root
   onto llama-swap's LAN :8101 — no path prefix): tsnet-members-only
   visibility, which is no weaker than today's funnel.
   The fact table gains that entry, `peerProviderUrl`'s
   loopback/logical-name special case (d047) retires, and the proxy
   allowlist row keys the hostname like every other host. **Precondition
   (host state):** the serve endpoint must exist in the same change that
   regenerates the local layer — the two must not ship apart, since the
   canonical URL would otherwise not resolve.
3. **The route is substituted at install time.** When generate copies an
   artifact into the agent dir (`$PI_CODING_AGENT_DIR/models.json`) or the
   opencode host config dir (`$OPENCODE_CONFIG_DIR/opencode.json`), it
   rewrites each provider's URL from canonical form to the d047 host-form
   client route `<base>/<upstream-host><base-path>`, keyed by provider id
   through the fact table — never by string-matching the URL. The
   committed-snapshot copy-backs (`refreshCommittedSnapshot`, the
   `opencode.jsonc` refresh) copy the CANONICAL form: the repo file is the
   reviewed diff, the installed file is the routed artifact, and neither
   ever contains the other's URL shape.
4. **One base; no probe ever selects a URL.** With several configured
   candidates, substitution always uses the first. d063 §1's "first
   candidate whose route proves usable wins" is superseded in the stronger
   direction its own rationale points: availability — probe results
   included — never selects a URL; the emitted base is a pure function of
   configuration. Probes keep their d063 §2 contract and choose the LINEUP
   source only.
5. **Substitution is fail-closed and the invariant is checked.** Install
   aborts when a provider's id has no fact-table upstream (artifact and
   table disagree), and the installed artifact is verified to contain zero
   canonical URLs; `run.sh` re-checks its installed `models.json` the same
   way it requires the file today. d063's compliance rule moves from
   "construction only" to "construction plus verification".
6. **`SKIP_GEN=1` is retired.** Installing a committed artifact raw would
   emit direct URLs — the state d063 deleted — so no honest branch remains.
   The env branch, the "nothing generated; installed committed models.json"
   fallback, and every "load the vault env or set SKIP_GEN=1" error string
   go away; a host that cannot load the vault fails loudly at generation,
   the same fail-closed contract d063 §4 already applies to the
   generators. Supersedes d063 §4's escape hatch and d041's SKIP_GEN
   surface. `settings.json`/`mcp.json` installs need no base and stay
   unconditional.
7. **Generation still requires the base** — route probes, the provider-facts
   refresh and the models.dev/catwalk relays all walk reverse-proxy routes
   (d063 §5). What changes is where the base is needed: to probe at
   generate time, to substitute at install time, and in git never.

## Consequences

- A funnel rotation becomes an ops event: regenerate + install with the new
  base; the committed diff is empty. `git diff` on committed artifacts is
  now purely lineup/metadata (d050, sharpened).
- The funnel id already in git history is not erased by this record; if
  treated as compromised it must be rotated out-of-repo — history is not
  fixable in place.
- opencode never had a SKIP_GEN path (d065) — unchanged. Termux generate
  runs (pi-only) now need the vault chain like every other host, which the
  generators' existing fail-closed guard already demanded.
- The canonical-URL detector for the install check is one-source (the fact
  table) but not a bare prefix test: when the configured base is known the
  rule is the install shape itself (every URL under `<base>/` at a path
  boundary; anything else flagged, a fact upstream named in the message).
  Without a base it degrades to upstream-prefix checks with one carve-out —
  the v2 route form embeds the upstream HOST as a path segment, which is
  how a base that shares its host with a fact row (the bazzite funnel and
  the rooted llama-swap row) stays distinguishable from a canonical URL;
  a host set alone, or a prefix test alone, false-positives on that
  collision.

## Verification

- Static test: committed artifacts contain no configured base and every
  provider URL equals a fact-table upstream; installed artifacts contain
  only `<configured base>/…` URLs. Both are exact structural checks, not
  substring guesses.
- Regenerate with the base set → zero URL churn in the committed diff;
  unset base → loud failure; `SKIP_GEN=1` → no branch, no install.

## Alternatives rejected

- **Placeholder tokens (`route:api.cline.bot/api/v1`) instead of real
  upstreams.** An unsubstituted artifact then fails loudly, but it is also
  not valid config for any consumer of the committed file. Real upstreams
  keep the repo artifact valid — it simply points at the upstream, the URL
  shape every OpenAI-compatible client already speaks. (Also the explicit
  call: canonical means the real upstream URL.)
- **Keep SKIP_GEN as "install canonical".** That installs direct-routed
  config — the forbidden state.
- **Rewrite in the merge output (scratch) instead of at install.** The
  merged file feeds two consumers (agent-dir install and committed
  snapshot); rewriting there either leaks the base into the snapshot or
  needs the second pass anyway.
- **A sidecar recording each provider's proven base.** Preserves d063 §1's
  per-provider nuance at the cost of vault state flowing through an extra
  artifact; rejected together with decision 4 — availability never selects
  URLs.

## References

- `coding-agent/generate.mjs` — install paths, snapshot copy-backs, the
  SKIP_GEN branches to delete.
- `coding-agent/generate-pi-coding-agent.mjs` /
  `generate-opencode.mjs` / `gen-lib.mjs` — emission points that write
  canonical URLs; `peerProviderUrl` derivation to reuse at install.
- `lib/cloud-providers.mjs` — the upstream fact table.
- `coding-agent/run.sh` — the installed-artifact check.

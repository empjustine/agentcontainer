---
id: d105
type: module-design
status: active
title: "d105 — SSL-VPN transports are named by mechanism; A–E are historical labels"
parent: estige
depends-on: [d073, d077]
references: [d072, d093, d101]
tags: ["serving", "proxy", "vpn", "ssl-vpn", "naming", "tunnel"]
---

# d105 — SSL-VPN transports are named by mechanism

## Status

Accepted — vocabulary only, no obligation changes.

## Problem

The SSL VPN's design records use single letters as if they were names. They
are not: d073's original A/B/C were three labels for the allowlist relay, the
authenticated relay, and the one tunnel shape; d077 then split the tunnel
into a transport ladder and re-lettered the existing tunnel from C to D. The
repository still carries the resulting five-label vocabulary (A, B, C, D, E)
and a "three-mode" title even though the labels no longer count the same
thing. Nothing in the requirements ever made those letters normative — the
requirement vocabulary is `VPN-R*` / `FR-S*`, and d077 describes the letters
as a preference ordering, not an identity.

The letters fail as names:

- **They do not say the mechanism.** "mode C" needs the d077 legend before a
  reader knows whether it is HTTP/2, WebSocket, or an HTTP/1.1 exchange.
- **They count the wrong set.** "three-mode" describes allowlist relay,
  authenticated relay, and the tunnel family; the tunnel family itself has
  three transports. A five-letter vocabulary cannot serve both counts.
- **They were already unstable.** Re-lettering old tunnel C to D touched
  d073, the BRD note, README, tests, and code in one commit (d077). A name
  that changes when preference changes is a rank, not a name.

## Decision

Use these canonical names in current prose, requirements, and reference docs:

| Former label | Canonical name          | Transport mechanism                                                                     |
| ------------ | ----------------------- | --------------------------------------------------------------------------------------- |
| A            | **allowlist relay**     | HTTPS reverse proxy keyed by the upstream-host path, deny-by-absence                    |
| B            | **authenticated relay** | HTTPS path-prefix forward relay, operator-authenticated                                 |
| C            | **h2-POST tunnel**      | HTTP/2 streaming `POST`; one long-lived request/response body pair per local connection |
| D            | **WebSocket tunnel**    | HTTP/1.1 WebSocket upgrade carrying the tunnel protocol                                 |
| E            | **h1.1-POST tunnel**    | HTTP/1.1 `POST` exchanges, stop-and-wait / windowed                                     |

- **Letters are historical aliases, not names.** They may appear in a
  historical decision record while narrating the past, in code constants and
  wire-adjacent log strings until a separate mechanical rename lands, or in
  an explicit "formerly mode X" note where a reader needs to connect old
  text. Current prose must use the canonical names.
- **The tunnel transports are a family, not modes of one thing.** Prefer
  "tunnel transports" for the C/D/E set. When the whole VPN is meant, use
  "SSL-VPN transport family" — not "three-mode SSL VPN".
- **Record IDs and slugs keep their committed spelling.** A slug such as
  `d073-ssl-vpn-three-modes` or `d091-llm-reverse-proxy-gateway-auth-mode-b`
  is a historical identifier; it is not evidence that the letters are names.
- **VPN-R IDs do not change.** The existing requirement text is reworded
  around stable IDs; this record changes vocabulary, not obligations.

## Migration

- d073 and d077, as the current owners of the requirements and the transport
  ladder, are reworded to the canonical names.
- Current-facing references — `docs/requirements.md`, `docs/architecture.md`,
  `docs/environments-and-variants.md`, `estige/README.md`,
  `estige/DESIGN.md`, and the README index rows that describe the transport
  family — use the canonical names.
- Older decision records may keep the letters where they are recounting their
  own decision. A record that is still normative must use the canonical names.
- Code identifiers and log strings follow in a separate mechanical pass; the
  constant `transportOffer = "cde"` and its wire-adjacent diagnostics stay
  until then, explicitly as aliases.

## Consequences

- A reader no longer needs a legend to know what a transport is.
- The names survive reordering: "WebSocket tunnel" stays true whether it is
  first or last in the demotion chain, while "mode D" would not.
- Prose is slightly longer; the ambiguity and re-lettering cost disappear.
- Historical records remain searchable by the old letters, and the mapping
  above is the one place that translates them.

## Alternatives rejected

- **Keep A–E and add a legend.** The legend would need repeating at every
  entry point, and the title "three-mode" would still miscount the labels.
- **Renumber A–E into one consistent alphabet.** It would still encode rank,
  still require a legend, and would repeat the re-lettering churn.
- **Name by rank ("preferred tunnel", "fallback tunnel").** Rank is a
  deployment-time result, not an identity: the same transport can be first
  in one environment and last in another.

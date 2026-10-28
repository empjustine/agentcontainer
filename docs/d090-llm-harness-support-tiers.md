---
id: d090
type: decision
status: accepted (policy; enforced at each generator/client change that touches a tiered surface)
title: "d090 — LLM harness support tiers: pi first-class (with its descendants), opencode/mistral-vibe best-effort, crush superficial"
parent: coding-agent
depends-on: [d064]
references: [d001, d047, d048, d064, d079]
tags: [harnesses, support-tiers, generators, policy]
---

# d090 — LLM harness support tiers (first-class / best-effort / superficial)

## Problem

The fleet's generated client surfaces serve four harness products, and no
record says whose contract wins when they disagree or where effort goes when
one breaks. [d047](d047-llm-reverse-proxy-host-allowlist.md) collapsed the
pi/opencode/charm *route* divergence, but that was a statement about the
proxy's shape, not about support. Every client-side feature since — d079's
harness transport, the gateway header this record's sibling [d091](d091-llm-reverse-proxy-gateway-auth-mode-b.md)
specs — has had to re-argue priority from scratch, and "supported" has never
been defined for any of them.

## Decision

[d064](d064-provider-support-tiers.md)'s vocabulary — first-class /
best-effort / superficial — applied to the LLM harnesses and coding agents,
declared once here the way d064 declared it once in the fact table:

| Tier | Harnesses | Contract |
|------|-----------|----------|
| **first-class** (supported) | **earendil-works/pi** — and its direct descendants **itayinbarr/little-coder** and **JetBrains/thinkrail** | The supported tier. The `coding-agent/` runner is owner-verified end-to-end: its generated surface (`models.json` + the `model-*.json` layers) is checked on every regenerate (the operator-hardcoded `settings.json` stays outside the generators, d036), regressions are fix priorities, and new client-side features land here first — pi's config semantics **define the contract** the other tiers follow. The descendants inherit the tier by lineage, not by repo surface: Thinkrail runs pi in-process and shares pi's agent dir (`docs/coding-harness-persistence.md`), little-coder is a pi fork — config compatibility is inherited, never re-decided per fork. |
| **best-effort** | **anomalyco/opencode**, **mistralai/mistral-vibe** | Generators emit configs where the surface is cheap (opencode: the committed `opencode.jsonc`, d048's mixed-API surface; mistral-vibe: no generated surface yet). Nothing verifies these end-to-end; feature parity may lag pi indefinitely; breakage is acknowledged, fixed when convenient, never a priority, and never blocks a pi-first design. |
| **superficial** | **charmbracelet/crush** | Served at the reverse-proxy level only (d047's allowlist is client-agnostic — any HTTP client presenting valid provider auth works). No generated config surface, no verification, no fix priority. |

Notes:

- Tier membership is by product lineage, not by today's repo surface — a
  descendant with no generator surface stays first-class; a harness the fleet
  stops using is retired (rows dropped), not demoted.
- The bundled Cline CLI is packaging, not a tiered harness: it has no
  generator surface of its own; its provider routes ride pi's (d001).
- Tier moves are edits to this record, never README prose drift.

## Consequences

- **Contract-setting order is fixed.** d091's gateway header is specced
  against pi's `models.json` `headers` semantics because pi is first-class;
  opencode and mistral-vibe follow on their tier's terms.
- **Generator effort allocation** follows the tiers: a pi regression blocks
  the change that caused it; an opencode regression is a documented state
  (d064's superficial analogy — present, unverified, accepted); crush gets
  proxy reachability and nothing more.
- d079's harness-transport promise is a first-class promise (pi) until that
  record says otherwise.

## Verification

- `rg -i 'little-coder|thinkrail|mistral-vibe|crush|opencode'` outside this
  record, d064, and the historical records returns only factual mentions
  (persistence doc, run.sh mounts, model ids, generated artifacts) — no
  implied support promise anywhere.
- A change touching a tiered client surface can name its tier in the commit
  or the record it implements; an unnamed tier is the review blocker.

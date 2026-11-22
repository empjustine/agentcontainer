---
id: d232
type: architecture-design
status: active
title: "d232 — verify the churned decisions: retire the generator-era records and state the current contract"
parent: architecture
depends-on: [d001, d018, d023, d024, d032, d037, d039, d041, d072, d186]
references: [d033, d074, d108, d113, d170, d188, d191, d227]
tags: [verification, decision-log, generators, provider-config, archive]
---

# d232 — verify the churned decisions

This record reports a verification pass over the highest-churn decision records and retires the ones whose mechanism has left the tree. It changes no runtime behavior and rewrites no older body. The surviving law is restated here, each retired record points here from its Status section, and readers of the generator and provider-config code can start here before following an id for history.

## Status

Verification complete. Eight records move to `deprecated` and into `docs/archive/`; d073, already deprecated, moves there too. d033, d042, d077 and d020 keep their status because the rule each carries survived the pass.

## Verification scope

The signal is the count of commits that touched the record over its history. Style and gate sweeps are included, so the count measures how often a record attracted edits, not how often its verdict changed. Records with fewer commits were included when the same finding applied to them.

| record | commits | finding                                                                                                                                     | verdict                                               |
| ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| d073   | 19      | Already deprecated; d188 carries the tunnel contract and d108 took the serving edge tunnel-only.                                            | Archive, no new law needed.                           |
| d032   | 16      | The worked example describes deleted generators and a removed peer route. Its own mapping table exists only to translate dead file names.   | Deprecate; current provider contract restated here.   |
| d041   | 12      | The root build and generate orchestrators are gone, the entrypoints are per unit, and d227 retired the launcher's artifact gate.            | Deprecate; current entrypoint contract restated here. |
| d001   | 11      | The peer-provider world it defends is gone, and the named generators no longer exist. Plain key names and baked base URLs survive.          | Deprecate; surviving law restated here.               |
| d018   | 11      | Three of its five layers and the `.paths` preflight are gone with the proxy edge and d170. The layer-merge rule survives for two layers.    | Deprecate; surviving law restated here.               |
| d023   | 10      | An audit of generator code that has since been merged, folded and deleted. No finding refers to a live file.                                | Deprecate; ownership rule lives in d113.              |
| d024   | 8       | The per-semantic generator split was reversed by the by-agent merge, and the shared fact table was dissolved. Layer ids survive as outputs. | Deprecate; current shape restated here.               |
| d039   | 5       | Its fold-back was itself superseded by d113's per-unit copy units.                                                                          | Deprecate; ownership rule lives in d113.              |
| d037   | 3       | Its broad-merge verdict was explicitly reversed by the by-agent merge.                                                                      | Deprecate; current shape restated here.               |

Kept after verification: d077's ladder is amended in place by d222 and its carrier names match the code; d042's taxonomy half is retired, but its anchor and numbering constraints still bind; d033's reachability rule is cited by `coding-agent/route-probe.mjs` even though its generator names are historical; d020 claims only a requirements assessment, which the tree still has not implemented. d104, d113, d045 and d072 carry amendments rather than rot and keep their status.

## Decision

### Deprecation moves the file

A deprecated record keeps its id, number and body. Its frontmatter status becomes `deprecated`, a Status line names the successor, and the file moves from `docs/` to `docs/archive/`. Path cites are retargeted to the archive; id cites stay as they are. This supersedes d186's consequence that retired notes keep their files on the `docs/` root.

### Each unit owns its generation and build entry

A unit owns its generator, builder, `lib/` copy and tests, and nothing reaches into a sibling unit (d113). `coding-agent/generate.mjs` drives exactly two generators, one per harness: the pi generator emits every `model-*.json` layer and the opencode generator emits the opencode config. The former per-concern generator processes are internal stages of the pi generator, not separate invocations. The broad merge rejected by d037 is the shape in force.

Layers are emitted outputs in zero-padded lexical order; they are not independent generator sources any more. A fetched catalog stays in the run's own directory, never in a committed cache (d191). The root holds only the interpreter and npm trampolines; builders and generators run per unit, and a runner never generates or builds. A launcher gates no harness config, because a mounted agent dir is host state (d227). The reachability rule and probe mechanics live in `coding-agent/route-probe.mjs`, with d033 still owning the rule's rationale.

### Provider identity comes from the key env

A provider row carries a plain, unprefixed key env; a generated artifact references it by name and the harness resolves it from forwarded environment. A `*_BASE_URL` override is derived from that key env in Azure's spelling, must be an absolute http(s) URL, and falls back to the fact-table canonical URL when unset. Generation bakes the resolved URL as a literal, because pi does not interpolate base URLs. Canonical URLs are checked in generation and review, not at launch (d227). Node's native proxy env handling carries egress (d074); the generators carry no route substitution of their own.

### Local config has two layers

`llm-local-inference/config.d/` holds `00-general.yaml` and, only for an inference endpoint, `10-local-llm-inference.yaml`. Layer keys are disjoint: identity-keyed maps merge additively, a duplicate key across layers is an error, and globals and macros have one home. Paths are baked at generation time; there is no `.paths` preflight, no stale launch script and no shell in the model commands. Cloud relaying is estige's tunnel, not a config.d layer (d108).

### Where the retired records went

| record           | current home                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| d001, d032       | This record, Provider identity comes from the key env; `coding-agent/DESIGN.md` for the artifact shape.   |
| d018             | This record, Local config has two layers; `llm-local-inference/DESIGN.md` for the module.                 |
| d023, d039       | d113 for per-unit ownership; this record for the entrypoint boundary.                                     |
| d024, d037, d041 | This record, Each unit owns its generation and build entry; `coding-agent/DESIGN.md` for the live layout. |
| d073             | d188 for the tunnel contract, d108 for the serving edge.                                                  |

## Consequences

- Searches for a retired id still find its body, now under `docs/archive/`, with this record in its Status line. The graph keeps every edge because ids do not change.
- Path links from living docs and records are retargeted; links inside archived bodies keep their original spelling under the archive README's rule.
- Code comments that name a retired id remain accurate as history. New comments that state current behavior name this record or the surviving owner named above.
- No code, configuration or generated artifact changes in this pass.

## Alternatives rejected

- **Leaving the records active with another patch line.** That was how these eight accumulated a dozen edits each; a reader still had to reconstruct the current rule from the patches.
- **Rewriting their bodies into current prose.** d072 keeps the log as curated history; the replacement record carries the new law.
- **Deleting them.** Their reasoning explains why the current shape was chosen, and id cites across the tree still resolve to them.
- **Archiving without a replacement.** The surviving law would be scattered across module docs and code headers instead of stated once.

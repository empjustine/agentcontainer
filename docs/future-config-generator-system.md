# Future work: a simplified config-generator system (NOT yet implemented)

> **Status: FUTURE / PENDING.** This is the *next* step after the current
> de-interweaving cleanup. It is **not** implemented; this page only records the
> intended shape so it can be picked up later.

Today each serving dir (`llm-reverse-proxy*`) owns a *copy* of the split
generators, and each `coding-agent*` runner owns/copies static pi JSON. That
works but duplicates a lot of logic and makes the "base" folders the source of
copied artifacts rather than the system that drives them.

## Goal

Replace copies-with-artifacts with a small, configurable **config-generator
system** in which:

1. a single thin driver runs **concern-scoped generators** that each write
   exactly one artifact, and
2. artifacts are produced by **overriding** canonical base values rather than
   by copying whole files and editing them.

The two targets have different mechanics, so the system is split by concern:

### llama-swap side: `config.d/` merge

llama-swap already has the merge primitive we need: `-config-dir` loads every
`*.yaml`/`*.yml` under a directory and **additively merges** identity-keyed
maps (`models`, `peers`, `groups`, `profiles`, `selectors`, `matrix`), while
concatenating `apiKeys` (see [d018](d018-split-config-d.md)). A generator system
would emit, per concern, a small file into a host-specific `config.d/` overlay:

- `00-general.yaml`   — globals + macros + ctxWindows (one, canonical)
- `10-local-llm-*.yaml` — local GGUF models (full hosts only)
- `peer-cloud.yaml` — cloud peers (OpenRouter + OpenCode Zen/Go)
- `22-peer-gfx1030.yaml` — gfx1030 local-inference peer route

A host picks *which* concern-files it wants (e.g. a peer-only termux host
omits the local-llm file), and llama-swap does the rest. No generator needs to
know about any other concern, and no file is copied wholesale.

### pi-coding-agent side: JSON override layers

pi reads a small set of JSON files (`settings.json`, `auth.json`, `models.json`)
under `~/.pi/agent/`. The planned mechanism is a **series of JSON files that
override values of other JSONs**: e.g. a per-environment override file that
`jq`-merges onto the canonical `settings.json`, and a `models.json` that
overrides each provider's `baseUrl`/`apiKey` from the environment (the peer
redirect already does exactly this one provider at a time).

A concern-scoped generator would emit only the overlay for its concern (retry
settings, provider baseUrls, key references), and the runner merges the layers
in a fixed order: canonical base < environment < local overrides.

## Proposed split (one generator per concern)

| Concern | Artifact | Where it lands |
|---------|----------|----------------|
| pi retry/terminal settings | `settings.json` overlay | `coding-agent*/.pi/agent` |
| provider keys | `auth.json` overlay | `coding-agent*/.pi/agent` |
| provider `baseUrl`/models | `models.json` overlay | `coding-agent*/.pi/agent` |
| llama-swap globals/macros | `00-general.yaml` | serving `config.d/` |
| local GGUF model list | `10-local-llm-*.yaml` | serving `config.d/` |
| peer model lists | `20-*`, `21-*` | serving `config.d/` |

Each generator is standalone and environment-agnostic; a thin runner (or
`generate.sh`) selects the set for the deployment and merges/emits the result.

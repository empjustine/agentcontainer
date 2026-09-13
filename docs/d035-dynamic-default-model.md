---
id: d035
type: task-spec
title: Dynamic default model selection for pi-coding-agent
parent: goal
tags: [default-model, pi-agent, provider-selection]
status: active
references:
  - d024
  - d027b
depends-on:
  - coding-agent
---

## Problem

The naive default model picker in pi-coding-agent was selecting `minimax-m2.7` as the default model. This is unreasonable because:

1. **Availability issue**: The "huggingface inference provider" is bogus; user does have a HF_TOKEN, but such token doesn't have credits for inference. Such endpoint will therefore never process or generate tokens for us.

2. **Better alternatives exist**: There are more capable models available that are actually usable:
   - `opencode-go`, `deepseek-v4.1-flash`
   - `opencode-go`, `glm-5.3-flash`
   - `cline-pass`, `cline-pass/z-ai/glm-5.3-flash`

The default model should be one that:
- Is actually available and callable

## Solution

Implemented a dynamic default model selection mechanism that:

1. **Reads the generated models.json** to see which providers the cascade
   emitted a usable layer for (a real or peer route — the host-specific
   availability signal; providers with no emitted layer are absent)
2. **Selects the better model from that layer**:
   - `opencode-go`, `deepseek-v4.1-flash`
   - `opencode-go`, `glm-5.3-flash`
   - `cline-pass`, `cline-pass/z-ai/glm-5.3-flash`
   - `cline-pass`, `cline-pass/z-ai/glm-5.3-flash`

## Implementation

### New Generator: `generate-default-model.mjs`

A new generator that:
- Loads the generated `models.json` (from its own directory) to see the emitted providers and models
- Checks if `opencode-go`'s layer has `deepseek-v4.1-flash`
- Checks if `cline-pass`'s layer has `cline-pass/glm-5.3-flash`
- Outputs a `default-model.json` overlay with `defaultProvider` and `defaultModel` if a suitable default is found
- Runs **after** the models.json stage
- Merges the default model config into settings.json using Node.js JSON parsing

### Updated `generate.sh`

Modified the generation flow to:
- Stage `generate-default-model.mjs` alongside other generators
- Run the generator **after** the models.json stage (settings-install → models.json → default model, docs/d034's parallel cascades feed it), copying the chosen models.json into the scratch dir first
- Merge the default model configuration into settings.json

## Files Changed

- `coding-agent/generate-default-model.mjs` - New generator
- `coding-agent/generate.sh` - Updated to run the new generator and merge config

## How It Works

1. `generate.sh` creates scratch directory and stages all generators
2. `settings.json` is installed first (with static retry/terminal config)
3. `models.json` is generated from the provider cascades
4. `generate-default-model.mjs` runs and:
   - Loads that `models.json` to check emitted providers
   - Checks if opencode-go's layer has `deepseek-v4.1-flash` (else `deepseek-v4-flash`)
   - If not, checks if cline-pass's layer has `cline-pass/glm-5.3-flash`
   - Outputs `default-model.json` with the selected default, or `{}` when none
5. The overlay is merged into settings.json
6. `models.json` is installed to the agent dir, then the opencode config is generated

## Why This Approach

- **Uses actually available models**: Only providers the cascade emitted a usable layer for are considered — a provider absent from `models.json` is never selected

## Related

- `docs/d024` - Providers split and provider facts
- `docs/d027b` - Path-prefix peer routing
- `docs/d033` - Generator cascade
- `docs/d034` - Parallel probing and multi-hop peer chains

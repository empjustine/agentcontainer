---
id: d240
type: architecture-design
status: draft
title: "d240 — quota and rate-limit state as one pi package: the readings, the cooldown, and the event the host must emit"
parent: architecture
depends-on: [d100, d190, d192]
references: [d113, d116, d235, d239]
tags: [pi, extensions, quota, ratelimit, providers, thinkrail]
---

# d240 — quota and rate-limit state as one pi package

A design for `pi-quota`, one unit that reads each fleet provider's own account
endpoint, keeps the reading in a normalized form, and turns a 429 into a
remembered cooldown so nothing retries a provider that has already said when it
will answer again. It covers which endpoints exist and which do not, the
normalized state, the three surfaces that consume it, and the one event pi does
not emit — which is why the cooldown's most precise input, the error response's
headers, is unavailable to an extension today. It does not cover the fleet's
lineup contracts (d190) or the extension family's typing and packaging rules
(d192). Read this with a provider folder open beside it: the readings are the
provider's own publication, not a table this record owns.

## Status

Draft; design only — no unit exists yet. The endpoint inventory is measured; the
host-change proposals in [Where the error side is blind](#where-the-error-side-is-blind)
are not implemented anywhere.

## Problem

A turn can be spent discovering a limit the provider publishes an endpoint for.
The provider folders say so and decline: "no quota command, no settings UI, no
status widget. Account reads (`/v1/quota`) are a UI feature, not a provider
capability" (`pi-neuralwatt-provider/README.md`, repeated by the synthetic,
hyper, verboo and tlalocayotl entries). That boundary is right, and it leaves the
feature homeless: five of the fleet's six cloud providers answer a remaining-quota
read with the same key the extension already holds.

The second half is the one that costs wall-clock. pi classifies a failed call from
its message text (`isRetryableAssistantError` in the pinned
`@earendil-works/pi-ai`, d192): quota and billing wording is non-retryable, so pi
already fails fast on the errors it recognizes. What pi does not do is remember
the answer. The next turn starts immediately, against a provider whose own reset
time was in the response that failed.

## Decision

One folder, `pi-quota/`, one package manifest, two entries, one state file:

- `quota.mjs` — reads the endpoints, owns `/quota` and the status slot.
- `ratelimit.mjs` — records the cooldown and gates the next turn.
- `state.mjs` — the one normalized shape both entries write and read.

Two entries rather than two folders: the readings and the cooldown share the
normalizer and the provider table, and a cross-folder import is what d113
forbids. Two entries rather than one: an operator may want the reading without
the gate, and `pi.extensions` is a list.

### The readings, by provider

Measured keylessly from this host: a 401, 422 or 403 proves the route exists
(auth is checked before routing), a 404 on a sibling path proves it does not.
Every route below answered.

| Provider (fleet tier)         | Route                                                         | Reading                                                                            |
| ----------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| opencode-go (first-class)     | `GET https://opencode.ai/zen/go/v1/usage`                     | `usage.rolling` (5 h), `usage.weekly`, `usage.monthly` windows                     |
| cline-pass (first-class)      | `GET https://api.cline.bot/api/v1/users/me/plan/usage-limits` | `five_hour`, `weekly`, `monthly`: `percentUsed`, `resetsAt`                        |
| hyper (first-class)           | `GET https://hyper.charm.land/v1/credits`                     | `{ balance }` in Hypercredits                                                      |
| synthetic (first-class)       | `GET https://api.synthetic.new/v2/quotas`                     | `planWeeklyLimit` (percent, `nextRegenAt`, `nextRegenPercent`), `search.hourly`    |
| neuralwatt (extension only)   | `GET https://api.neuralwatt.com/v1/quota`                     | `balance.credits_remaining_usd`, `subscription.kwh_remaining`, `daily_free_energy` |
| openrouter (best-effort)      | `GET https://openrouter.ai/api/v1/key`                        | `data.limit`, `data.limit_remaining`, `data.usage`                                 |
| aperture (gateway, reference) | `GET /v1/models` → each row's `quotas[]`                      | `[{ name, current, capacity, rate, paused }]` per model                            |
| tlalocayotl (local)           | `GET /metrics`, `/running` (key-gated)                        | request counters, not quota                                                        |

No endpoint exists for opencode zen (`/zen/v1/usage` is 404 while its Go sibling
answers), for inferx (its documentation withholds the management routes), or for
google, mistral and nvidia under an API key. verboo publishes
`/api/me/usage-windows` but authenticates it with the CLI's session token, so an
API key is not known to work there. A provider with no endpoint shows nothing
rather than a synthetic zero — d057's rule for a field the source cannot answer,
applied to an account read.

The synthetic case is why the cooldown matters: its plan allowance refills in
~202-minute steps, and `nextRegenAt` names the next one. A retry before that
timestamp cannot succeed, and the endpoint — not the error — is the authority
on when it can.

### One normalized reading

Each adapter maps its provider's answer into three shapes, and nothing else:

```text
windows  [{ id, durationMs, percentRemaining, resetsAt }]
balance  { remaining, currency }
energy   { kwhRemaining, resetsAt }
```

A reading is `{ provider, readAt, source, windows | balance | energy }`, stored
per provider under `~/.pi/agent/pi-quota/state.json` with the merge-and-atomic
rename the prior art uses (`pi-quota-status`), so two sessions cannot lose each
other's write. The status slot renders the strictest dimension the reading has:
`synthetic 91% ↻14:07`, or `hyper 4 cr` when the provider sells credits.

### Where the cooldown comes from

Two inputs, most-precise first:

1. **The reading's `resetsAt`** when a reading exists and says the account is at
   the limit.
2. **The failed response**, parsed from the assistant message's `errorMessage`
   (pi composes it as `<status>: <body>`, `formatProviderError`), which yields
   the status and whatever reset the body carries.

An adapter that recognizes its provider's body pattern fills `resetsAt`; one
that does not records the cooldown with no expiry and reports the raw body
rather than inventing a window.

### What the gate does, and what it cannot do

- `pi.on("input")` → `{ action: "handled" }` after `ctx.ui.notify` names the
  reset. This is the only documented pre-turn cancellation, so it covers a typed
  prompt and nothing else.
- `pi.setModel(allowedFallbackModels[0])` when the active provider is cooling
  and pi's model entry declares a fallback — the routing action, not a refusal.
- `before_agent_start` can inject a note but cannot cancel, and a turn already
  streaming cannot be gated at all. The gate reduces wasted attempts; it does
  not make them impossible.

## Where the error side is blind

`after_provider_response` carries `{ status, headers }` and looks like the exact
input a cooldown needs. In `@earendil-works/pi-ai` 1.5.2 it is emitted by
`options.onResponse`, which every API module calls **after**
`retryProviderRequest` has resolved — so a 429 that throws never reaches it, and
a rate-limit header on a failed call is visible to no extension. What survives
the failure is `formatProviderError`: the status and body as a string. The raw
error object, whose `headers` the retry helper read and acted on, is dropped one
frame later.

That is the case for a host change, and it is small because the data already
exists at the point where it is discarded:

1. **Emit the response event for non-OK responses too** — either widen
   `after_provider_response` or add `provider_error` carrying
   `{ provider, model, status, headers, body, attempt }`. `normalizeProviderError`
   already extracts status and body; `provider-retry.js` already reads
   `retry-after-ms`, `retry-after` and `x-should-retry`.
2. **Let a handler refuse a request.** No hook can do it today:
   `before_provider_request` replaces the payload, and its return value has no
   cancel form. A `{ cancel: { message } }` on that event would make the gate
   exact instead of advisory.

Until a host change lands, the string parse stays, and the record keeps it in
one place rather than in five adapters.

## What pi already prevents, and why not to tune it

Two retry layers sit under an extension, and both are verifiable in the pinned
dist:

- `retryProviderRequest` (provider level) retries 408, 409, 429 and 5xx, honours
  `retry-after-ms`/`retry-after`, and **throws instead of sleeping** when the
  server's requested delay exceeds `retry.provider.maxRetryDelayMs` (default
  60 s): "Server requested Ns retry delay (max: 60s)". Its `maxRetries` defaults
  to 0, and pi's own settings reference says provider retries "can delay Pi from
  handling quota and usage-limit errors itself".
- `retryAssistantCall` (agent level) retries 3 times with 2 s · 2ⁿ backoff capped
  at `retry.maxAgentDelayMs`, and refuses the quota/billing wordings outright
  (`GoUsageLimitError`, `Monthly usage limit reached`, `insufficient_quota`,
  `billing`, z.ai's `1308`, the ChatGPT subscription-sharing limits).

So the fleet's exposure is narrower than it looks: the failure mode is not a
tight retry loop, it is **forgetting**. Raising `retry.provider.maxRetries`
above 0 makes the second layer slower to reach its verdict, which is why this
record leaves `retry.*` alone and records state instead.

## The three surfaces

| Surface    | What it gets                                                                                                               | Cost                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| npm script | `./npm-run.sh pi-quota quota --provider synthetic --json`, key from `./environment.sh`                                     | one entry in the unit's `package.json` |
| pi         | `/quota` (all providers), `/quota --all` (errors too), the status slot; `/ratelimit` status and a manual clear             | the family contract of d192            |
| ThinkRail  | the same two, unchanged: the chat header renders pi's `setStatus` entries and its command catalog lists extension commands | nothing beyond the pi entry            |

ThinkRail needs no work for this shape, and the reason is worth recording
because it decides the design: ThinkRail runs pi in-process and implements pi's
own `ExtensionUIContext`, publishing `notify`/`setStatus`/`setWidget` over the
wire (`packages/server/src/agent/webUiContext.ts`), and the web client renders
status entries in the chat header toolbar next to the session-stats bar. The
inert members are `setFooter`, `setHeader`, `custom` and `setWidget`'s factory
overload — a footer-replacing quota bar is invisible in ThinkRail **and** in
pi's own RPC mode. A ThinkRail _panel_ is out of reach for an installed
extension: its web half may contribute `toolRenderers` only, and panels, rail
icons and commands are honoured for built-in extensions alone.

## Consequences

- No provider folder grows a command, and the "UI feature, not a provider
  capability" line stays true for each of them.
- The normalizer is the only place a provider's field names appear; a sixth
  endpoint is one adapter beside five.
- A reading is a claim about an account, so it carries `readAt` and nothing shows
  it as current without one.
- A failed read is a failed read (d190's rule): the entry reports the provider
  and shows the last reading with its age, never a zero it did not measure.
- The cooldown is advisory until a host change lands, and the record says so
  where the code will need it.

## Verification

Measured on this host, no credential sent:

- Each route above answered 401/422, and a sibling nonsense path answered 404 on
  the same origin — the route exists, and the origin authenticates before it
  routes. `code.verboo.ai` answers 401 on every path, so its route cannot be
  distinguished that way; `model.inferx.net` answers 404 on `/usage`, `/credits`
  and the `/endpoints/v1` siblings tried.
- `GET https://ai.coelacanth-barb.ts.net/v1/models` returns 477 rows, each with a
  `quotas` array.
- Read in the pinned dist: `utils/retry.js`, `utils/provider-retry.js`,
  `utils/error-body.js`, `api/openai-completions.js`,
  `api/anthropic-messages.js`, `core/settings-defaults.js`,
  `core/settings-manager.js`.
- Read in ThinkRail's source: `packages/server/src/agent/webUiContext.ts`,
  `apps/web/src/chat/ChatView.tsx`, `apps/web/src/chat/ChatHeader.tsx`,
  `packages/contracts/src/piProtocol.ts`,
  `packages/server/src/agent/agentSessionManager.ts`,
  `packages/server/skills/making-thinkrail-extensions/SKILL.md`.

Not verified: no authenticated call to any endpoint, so every response shape is
the vendor's documentation plus a prior implementation's parser, and none is a
reading this record took.

## Alternatives rejected

- **A quota command per provider folder.** Five copies of the same normalizer,
  and a provider folder would carry exactly the surface its README declines.
- **A footer-replacing bar.** `setFooter` is a no-op in RPC mode and in
  ThinkRail, so the richest rendering would work on one host of three.
- **A ThinkRail extension for the panel.** Installed web halves contribute tool
  renderers only; the panel form needs a built-in extension, which is a
  ThinkRail change and not this unit's.
- **Tuning `retry.provider.maxRetries`.** It delays pi's own quota verdict
  instead of remembering it, and the settings reference warns against it.
- **Per-adapter `retry-after` handling.** The header is not delivered on a failed
  call; each adapter would parse the same message string in its own way.

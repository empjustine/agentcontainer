---
id: d161
type: architecture-design
status: draft
title: "d161 — mirror state (renamed, gone, stale) is recorded by a maintenance probe and read offline"
parent: architecture
depends-on: [d099, d121, d160]
references: [d043, d045, d060, d062, d113]
tags: ["git", "mirror", "state", "canonicality", "warnings", "offline", "farm"]
---

# d161 — mirror state is recorded by a maintenance probe and read offline

## Problem

Three facts about a mirror matter to a reader and none of them can be derived from the mirror
itself:

- **The upstream was renamed.** The canonical path differs from the mirrored id (docs/d160), and
  the mirror's stored `remote.origin.url` still points at the old name.
- **The upstream is gone.** The GitHub path answers 404; the mirror is an orphan that still reads
  perfectly and will never fetch again.
- **The mirror is behind.** The tip is older than the upstream's, which a reader cannot see without
  asking the network.

Read verbs cannot answer those questions themselves, because read verbs are offline by
construction (docs/d099): they take `GIT_OPTIONAL_LOCKS=0`, a scrubbed environment, a 60-second
deadline and no network. A "read" that fetched would change the bytes it was asked to report, and a
farm-wide grep would spend its deadline on 1,259 handshakes.

Equally, the tool cannot guess. A rename and a name re-used by a different repository look
identical from the inside; only an identity outside the mirror separates them.

## Decision

State is **recorded** by a maintenance-side probe and **read** by the tool, as a sidecar beside the
mirrors:

```
<root>/.farm-state/<owner>/<repo>.json
{
  "id": "github.com/sst/opencode",
  "upstream": "renamed",              // present | renamed | gone | unknown
  "canonical": "github.com/anomalyco/opencode",
  "repository_id": 975734319,
  "checked": "2026-11-08",
  "probe": "html"                     // html | api | offline
}
```

Rules the surface inherits:

- **Absence is `unknown`.** No sidecar, an unreadable one, or one the tool does not recognise
  produces `unknown`, never a failed read. A mirror with no recorded state is still a mirror.
- **State never decides whether a read is answered.** It rides along as fields on a successful
  envelope, plus a structured `warn` line on stderr (docs/d045) when it is not `present`. A caller
  that ignores the fields loses information, not answers.
- **Only the maintenance side touches the network.** `repo_info` reports what is recorded and
  stamps `checked`, so a caller can judge the age without the tool judging it.

## How a rename is confirmed

Git cannot answer this. Measured on this farm: `GET https://github.com/sst/opencode.git/info/refs?service=git-upload-pack`
answers **200 with no `Location`**, `git ls-remote` exits 0 with empty stderr, and `git clone --bare`
succeeds without its "redirecting to …" note. The smart-HTTP transport serves a renamed repository
transparently, so `remote.origin.url` is a record of what was typed, never evidence of what is
canonical.

What separates the cases is the **repository id**, read from the HTML page — no quota, and it
scales to the whole farm:

```
curl -s https://github.com/<owner>/<repo> | grep -o 'og:url\|octolytics-dimension-repository_id' -A1
```

| probe result                  | verdict                                              | action                                                                |
| ----------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| same id, different path       | rename or transfer                                   | alias the old id, re-point `origin` (d160)                            |
| same id, case-only difference | canonical spelling differs                           | record the canonical path; no alias needed on a case-insensitive root |
| 404                           | upstream gone                                        | mark `gone`; keep the mirror, it is the only copy                     |
| different id                  | a different repository, or a fork, on a re-used name | do **not** alias; the recorded id is the warning                      |

The API is the confirmation leg, not the sweep: `GET https://api.github.com/repos/<owner>/<repo>`
answers **301** with `location: https://api.github.com/repositories/<id>` for a rename and **200**
with `full_name` for a canonical path — 60 requests an hour unauthenticated, and a rename costs two.

Other forges answer the same question through their own identity field: GitLab
`/api/v4/projects/<url-encoded-path>` returns `path_with_namespace`, Gitea and Codeberg
`/api/v1/repos/<owner>/<repo>` return `full_name`. Sourcehut has no rename redirect at all — the
repository answers 404 and only the alias row keeps the old name resolvable.

The sweep that produced d160's table ran the HTML leg over a 66-mirror sample at ten concurrent
probes in about twelve seconds and found three deviations, which extrapolates to a few minutes for
the whole farm.

## Consequences

### The record is a file, so it works where the new forge never will

A sidecar is plain JSON in the mirror root. It needs no object store, no daemon and no schema
service, which is what makes it usable on a **work mirror** — a location that will plausibly never
run the second-generation, object-storage forge. There the probe may never run at all; `unknown`
stays the permanent, honest answer, every read still works, and the moment a probe does run the same
fields appear with no change to any caller.

A forge that serves mirrors from object storage replicates the same keys from its own metadata. The
envelope shape is the contract; where the bytes live is not.

### State can rot, and says so

`checked` is the whole defence: a `present` verdict from a year ago is weaker than a `renamed`
verdict from yesterday, and only the caller knows which it can tolerate. A `gone` verdict is
re-checkable — names get re-registered — and a re-used name with a different id must not be silently
adopted, which is why the id is stored beside the verdict rather than only the path.

### Where the warnings surface

- `repo_info` — `upstream`, `canonical`, `repository_id`, `checked`, plus the existing `entry` and
  `alias_target` from d160.
- a stderr `warn` line whenever `upstream` is not `present`, so a log-only consumer still sees it
  (docs/d045).
- the maintenance pass — a run that rewrites a sidecar reports the transition, which is the only
  place a change of state is observable as an event rather than as a value.

### What is not built yet

The record above is the decided shape, and the pieces that exist today are the probe method
(measured, above), the alias application (`git/farm-aliases.mjs`, d160) and `repo_info`'s
`entry`/`alias_target` fields. Still missing:

- a recorder (`git/mirror-state.mjs --check [REPO_GLOB]`) that runs the HTML leg, falls back to the
  API for a disagreement, and writes the sidecar per mirror;
- `repo_info` reading the sidecar into the envelope fields listed above;

Until then, canonicality lives where the sweep left it: d160's table and the aliases it produced.

## Alternatives rejected

- **Probe at read time** — breaks the offline guarantee, spends the 60-second deadline on network
  calls, and makes a read's answer depend on a third party's availability.
- **Store state in the mirror as a ref or note** — `gc`/`repack` churn over metadata that describes
  the mirror rather than belonging to it, and a ref that mirror-fetches try to send upstream.
- **One farm-wide state file** — a single writer under concurrent maintenance, and one lost file
  loses every row instead of one.
- **Trust the name** — a re-used name makes it wrong, and the failure is silent adoption of a
  different repository's history.

---
id: d122
type: architecture-design
status: active
title: "d122 — data freshness is a gate, not a review catch: ./freshness.sh"
parent: architecture
depends-on: [d023, d050, d086, d113]
references: [d060, d096, d104]
tags: [qa, generators, data, network, sweep]
---

# d122 — data freshness is a gate, not a review catch

## Problem

Generators are the source of truth (d023) and every unit commits its output:
the pi-* provider catalogs, coding-agent's model snapshot, llm-local-inference's
HF manifests and model cards. Nothing in the repo could tell a maintainer
whether those committed bytes were still what upstream serves.

The offline sweep could not, and could not be taught to: a stale cache is
_valid_. It parses, its shape is right, its unit tests pass, biome and knip are
happy, and `generate` (not `--check`) would happily rewrite it — the artifact is
only wrong relative to a listing nobody looked at. So staleness was caught by
review, or by a user, or not at all. It was in fact caught by not at all: the
2026-11 sweep found `pi-synthetic` carrying two rows for models upstream had
already dropped (13 published vs 11 served), and llm-local-inference's cached
manifests resolving five `byteshape/Qwen3.8-27B-GGUF` quants to nothing —
neither of which any gate or test could have flagged.

## Decision

`./freshness.sh` is the third repo-wide sweep and the only one that touches the
network, because the claim it checks is about the outside world.

Each unit answers with its own contract; the script knows no payload formats:

- _*pi-* extensions_*: `./npm-run.sh <unit> generate --check`. The generator re-reads
  its listing and exits nonzero when the committed artifacts no longer match.
- **llm-local-inference**: `fetch_hf_manifests.py --offline`, an offline audit
  that every configured `--model` still resolves inside the cached manifest
  tree. It catches the failure a refresh hides (a hand-edited entry naming a
  file that is not there) without a network call, and needs `uv`.

**A key-gated listing without its key is skipped, not failed.** `pi-verboo`'s
listing is auth-gated; a dev box without the vault is a normal state, so the
skip names the unit and the variable, and `./environment.sh ./freshness.sh`
includes it. A gate that fails on an absent secret teaches people to ignore it.

**coding-agent is deliberately absent.** Its generator falls back per source
when upstream is unreachable — the tailnet API, an auth-gated listing, the
opencode docs mirror — so byte-equality against the committed snapshot is a
property of the host, not of the data. A check that fails on every box without
a tailnet is not a freshness check. Its offline guarantees stay in
`./check-types.sh` and `coding-agent/tests/`, and a _refresh_ stays a deliberate
maintainer act.

`./lint.sh` and `./test.sh` remain offline by contract: linting and testing must
survive a train, a plane, and a Termux host with no vault. Freshness is the one
question that cannot.

## Invariants

- The sweep's verdict is per unit: a stale unit names itself and the command
  that refreshes it.
- Adding a generator with a `--check` flag is enough to join the gate; the loop
  discovers `pi-*/package.json` `generate` scripts rather than listing units.
- Skipping is loud (a `warn` line with the reason) and counted in the summary,
  so "passed 4, skipped 1" cannot be mistaken for "checked everything".
- A committed cache that is _regenerable_ is still committed (d023): the gate
  checks the copy, it never rewrites it. `--check` is where a generator's write
  path stays off.

## Alternatives rejected

- **Add the checks to `./lint.sh` behind an env flag.** A flag makes the gate
  optional in the one place people run automatically; the offline contract of
  lint/test is also then a property of how you invoked it, not of the script.
- **Run plain `generate` and `git diff --exit-code`.** Destroys uncommitted work
  in the same paths and makes the gate's own failure mode a dirty tree.
- **Compare against a recorded hash of the upstream listing.** Hashes of a
  moving listing pin the wrong thing (d086's short-circuit hashes the _rendered
  artifact_); a hash of upstream bytes would fail on every cosmetic upstream
  change that never reaches a committed file.
- **Treat the missing `VERBOO_API_KEY` as a failure.** See above — the gate
  would be permanently red on every unvaulted host.

## Consequences

- Staleness is now visible on demand (`./freshness.sh`, or `--quiet` for CI logs)
  and cannot be silently inherited by a merge.
- Two refresh tools had to be repaired before the gate could be honest: the six
  llm-local-inference python tools still resolved the retired repo-root `lib/`
  (a d113 fold regression that no sweep could see, since the sweep runs node
  and shell only), and `fetch_hf_manifests.py` wrote one-space indentation while
  22 of its 30 committed manifests were tab-indented — every refresh would have
  reindented the set.
- A refresh is not byte-idempotent: the HF manifests carry `fetched_at`, so a
  second run changes that field in every file. The gate therefore audits the
  cached tree instead of re-fetching, and a future strict mode would have to
  ignore that field explicitly.
- The Go suite is outside the sweep no longer: `./test.sh` runs
  `go test ./...` in `estige/` and skips loudly when no toolchain is installed
  ([docs/d123](d123-go-suite-in-the-sweep.md)). The freshness gate stays
  network-only; the two do not overlap.

## Verification status

`./freshness.sh` → `checked 4, skipped 1` (pi-verboo), exit 0; a planted stale
artifact in `pi-hyper/models.json` → exit 1 naming the unit, then restored to
exit 0.

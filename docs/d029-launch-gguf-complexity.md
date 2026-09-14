---
id: d029
type: architecture-design
status: adopted-in-part (option B implemented; A4/preflight folded in)
title: "d029 — the in-container `launch-gguf.sh` path: complexity audit and options"
parent: architecture
---

# d029 — the in-container `launch-gguf.sh` path: complexity audit and options

status: proposed (nothing decided) · relates-to: d018, d025, termux-build-audit

## Problem

The llama-swap local-inference runtime resolves GGUF snapshots through a
script that is copied *inside the serving container*
(`config.d/launch-gguf.sh`). The prompt that put this audit together: that
path "seems to be growing in complexity very fast". This note measures where
the complexity actually is, separates it from the one constraint that makes
the script necessary, and ranks the refactor options.

## Context: why an in-container script exists at all (verified, still true)

llama-swap splits a model's `cmd` with posix shlex and execs argv directly —
**no shell runs** (their `internal/config/commands.go` SanitizeCommand; a
`sh -c` wrapper breaks on the single quotes inside the sampling macros,
`--chat-template-kwargs '{…}'`). And upstream has no model-file provisioning
at all — fetched 2026-09-12 from
`docs/kb/guides/model-runtime/writing-cmd.md`:

> "llama-swap has no setting that downloads a missing GGUF from Hugging Face
> or another model registry. The file must already exist, or the configured
> `cmd` must fetch it before starting the inference server."

So *some* resolver is unavoidable **if** launch-time resolution is kept. That
is the only irreducible piece; everything below is mutable design.

## Findings (measured)

| # | Complexity source | Evidence | Cost |
|---|---|---|---|
| F1 | **Positional launcher interface churn**: 5 positional args + `--` (`repoDir repoId gguf mmproj|- draft|- -- <server>…`) | `launch-gguf.sh:75-88`; emitted cmds in `config.d/10-local-llm-inference.yaml` (128 of them) | every new model capability = a 6th positional + coordinated generator+launcher+128-cmd change |
| F2 | **Fork-in-`config.d` mechanism**: source `launch-gguf.sh` → `generate.sh` copies it into `config.d/` → ro-mounted into the container; a 15-line self-contained logger fork rides along because the copy cannot reach `lib/log.sh` | `generate.sh:74-78`; `launch-gguf.sh:31-45` | two copies of the launcher exist; drift class |
| F3 | **Image-layout hedge**: hardcoded server-binary search dirs (`/opt/llama.cpp/bin /app /app/bin` …) | `launch-gguf.sh:87-104` | brittle against unified-image revisions |
| F4 | **Path inconsistency across three files**: `run.sh` mounts the HF cache at *two* container paths (`/root/.cache/…` **and** `/home/ubuntu/.cache/…`); the launcher defaults to `/home/ubuntu/…`; `generate.sh`'s `LOCAL_INFERENCE=1` comment claims `/root/.cache` paths | `run.sh:69-70`, `launch-gguf.sh:47`, `generate.sh:21-22` | latent — whichever belief is wrong fails only on the mismatched path |
| F5 | **Macro-verbatim coupling**: the generator must keep `${LLAMA_SERVER}` / `${qwen36}`-family text un-interpolated (llama-swap expands them) | `generate-local-llm-models.yaml.mjs:38-43` | small, inherent to the macro design |
| F6 | **mmproj tripling**: each multimodal model emits ×3 llama-swap entries (0text/1vision/2mmproj) | generator's MMPROJ_MODES; the 122 KB yaml | catalog size + swap targets; product decision, not accidental |

## Options (ranked by complexity-removed / risk)

**A. Quick wins, no semantic change**

- **A1 — mount the launcher, don't copy it**: `workload_ro "$script_dir/launch-gguf.sh" /etc/llama-swap/launch-gguf.sh` in `run.sh` (the `workload_ro` API takes single files); retarget `LAUNCHER` in the generator. Deletes the copy step and the F2 drift class. The self-contained logger stays (container has no `lib/`).
- **A2 — extensible interface**: drop the `repoDir` positional (derivable in-launcher from the repo id) and make mmproj/draft key=value pairs after `--` (`mmproj=f.gguf draft=f.gguf`). Future capabilities stop growing the positional list (F1).
- **A3 — one cache-path constant** defined once, fixing F4.
- **A4 — post-generate validation**: run the image with `llama-swap -config /etc/llama-swap/config.d -validate` (documented upstream flag) inside `generate.sh` — catches duplicate keys / macro breakage before serving.

**B — generation-time snapshot resolution (deletes the launcher)**

The host and container share the *same* HF cache (`run.sh` bind-mounts it), so
`generate.sh` can resolve `models--…/snapshots/<hash>/<file>` at generation
time and emit plain absolute-path cmds:

```yaml
cmd: "${LLAMA_SERVER} ${0text} ${gemma4} --cache-type-k f16 … --model <abs snapshot path> --model-draft <abs path>"
```

- Cache hit ⇒ no launcher, no launch-time resolution; generator emits the
  00001 shard path (shard normalization moves to generation).
- Cache miss at generation ⇒ generator emits `--hf-repo/--hf-file` instead
  (llama-server downloads; the same fallback the launcher delegates to today).
- Generation stays offline — it reads the host cache directory, not the network.
- Deletes: the launcher itself, the copy mechanism (F2), the binary-lookup
  hedge (F3), the `--` interface (F1). ~150 sh lines → 0.
- **Honest cost**: the generated config becomes cache-state-dependent. A repo
  re-pulled to a new commit invalidates generated snapshot paths. Mitigation:
  a one-line existence preflight in `run.sh` that fails loudly ("cache changed
  since generation — re-run ./generate.sh") so staleness is a clear error, not
  a silent server-127.

**C — product-level levers** (decisions, not refactors)

- C1: cap the mmproj tripling (F5/F6) to the modes the coding-agent probes
  actually route to; the other variants are speculatively generated.
- C2: bake the launcher into a derived image (`FROM unified-vulkan` + one
  COPY) instead of A1, if it should be an image-managed artifact — costs an
  image supply-chain step the direct mount avoids.

## Recommendation

A1–A4 first (mechanical, independently revertable), then **B** as the real
cut. B's only real decision is accepting the generation-time-coupling
trade-off; the preflight makes it manageable. C1 is worth a separate decision
record if taken.

## Consequences if B is taken

- `config.d/` shrinks to two generated files (`00-general.yaml`,
  `10-local-llm-inference.yaml`); no shell inside the serving container.
- `generate.sh` gains a host-cache read (still offline, still key-free).
- d018's layer table loses the `launch-gguf.sh` row; the merge contract is
  untouched.

## Resolution (implemented)

Option **B** shipped, with one deliberate deviation and one addition:

- **Deviation — no `--hf-repo/--hf-file` fallback.** The audit's B sketched
  "generator emits `--hf-repo/--hf-file` on cache miss"; that was dropped
  because model provisioning already has a single owner
  (`local-llm/download_models.py`) and a second download path in the
  generator would re-create exactly the duplication this refactor removes.
  A cache miss is now a generation error pointing at that script; nothing
  downloads at launch. `HF_TOKEN` therefore left run.sh's env allowlist and
  the hub bind went read-only.
- **Addition — the `.paths` staleness preflight.** The mitigation sketched
  below is implemented as a generated companion file
  (`config.d/10-local-llm-inference.paths`, one verified host-side path per
  line — llama-swap's `-config-dir` loader only reads top-level `*.yml/*.yaml`,
  so the companion is invisible to it). `run.sh` re-checks every path before
  starting the container; a cache changed since generation is a loud
  "re-run ./generate.sh", not a llama-server 127 at swap time.
- A1/A2/A3 are moot (the launcher they tidy up is deleted); A4
  (post-generate validation) remains open.
- Generation resolves **refs/main first** (the revision download_models.py
  pins, so a healthy cache always hits it), falling back to any snapshot dir
  that carries the entry — the glob order the retired launcher used. Shard
  verification is stricter than the launcher: every shard must exist, not
  just shard 1.

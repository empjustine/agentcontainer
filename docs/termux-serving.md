# Termux / a50 serving environment

Orientation for the **termux** variant of the llama-swap serving layer
(`openai-completions/`) — a no-container build for resource-constrained hosts
running Termux (e.g. the **a50** phone/router environment).

This file is a **map**: the operational documentation now lives in the source
files it describes (literate style — read the file headers).

## Why this variant exists

A phone/router cannot run the containerized llama-swap at all — Termux has no
usable podman/docker for the amd64 container image, and local llama.cpp
inference is impossible. So this variant serves a **native Android/arm64
llama-swap build** over a **peers-only** `config.d/`: cloud providers proxied
through llama-swap, never a local `models` section.

Peers-only is **by construction**, not a flag: `generate.sh` detects no
container backend and no GPU here, so the local-inference layer (the only thing
that could emit `models`) is never generated.

## Where the documentation lives now

| Concern | Lives in |
|---------|----------|
| Why there is no container here, the peers-only mode table, `LISTEN` / serving env, secrets source, non-configurable paths | `openai-completions/run-native.sh` |
| Native android/arm64 build (clone / `git pull --ff-only` / `GOOS=android`), image pre-pull off Termux, `FORCE` | `openai-completions/build.sh` |
| Which `config.d/` layers are generated on which host, merge contract, stale-output policy | `openai-completions/generate.sh` |
| Provider set, key names, base URLs, model-id sources (this is *the* provider list) | `openai-completions/gen-lib.mjs` + each `generate-*.mjs` header |
| Local GGUF layer — GPU-capable container hosts only, **never** here | `openai-completions/generate-local-llm-models.yaml.mjs`, `launch-gguf.sh` |
| Peers-only env key names (documentation only — nothing loads the file; no `LLAMACPP_BASE_URL` / `LLAMA_API_BASE_URL`, there is no local llama.cpp server) | `openai-completions/.env.example` |
| Infisical CLI provisioning on Termux (no official Android release) | repo root `./build.sh`; consumption side: `load_secrets` in `lib/workload-runtime.sh` |
| `node` + `jq` — required by `generate.sh` (the `.mjs` generators; and the workload description API in `lib/workload-runtime.sh` is jq-backed, see `lib/workload-*.jq`) | repo root `./build.sh` installs both via `pkg` when `$PREFIX/bin/<tool>` is not executable (`SKIP_PKG=1` to opt out; there is no mise here) |

> Naming note: older revisions of this file listed `LLAMASWAP_API_KEY` as the
> client auth key. The generated `apiKeys` reference `${env.PEER_API_KEY}`
> (from `llama-swap-core.json`), so *that* is the bearer key a client sends
> today — see `openai-completions/.env.example`.

## Retired: the PRoot workload path (run-proot.sh)

`run-proot.sh` used to confine the native llama-swap binary inside a basic
PRoot workload (`proot_run()` in `lib/workload-runtime.sh`), as a termux analog of the
container workload. It was **removed along with the PRoot backend**: PRoot is
ptrace-based path translation — no kernel namespaces, no cgroups, no real
root, no GPU passthrough, no read-only binds — so it provided the appearance
of workloading without the substance, and the native binary it wrapped talks to
the network directly anyway. On Termux, serve bare with `run-native.sh`; on
hosts that need stronger-than-container isolation, the qemu/libvirt option is
assessed in [d020-libvirt-qemu-sandbox.md](d020-libvirt-qemu-sandbox.md)
(not implemented).

## Cross-references

- [environments-and-peer-variants.md](environments-and-peer-variants.md) — the
  a50-en7562ct (Termux) and oci-e21micro (OCI free tier) environment rows:
  hostnames, hardware, and what each host runs. The OCI peers-only env layout
  is identical to Termux's.
- [d018-split-config-d.md](d018-split-config-d.md) — split `config.d/` layout
  (merge contract, per-layer stale-output rules).
- [OLD/docs/d019-unified-opencode-key.md](../OLD/docs/d019-unified-opencode-key.md) — plain,
  un-prefixed and unified provider key names.
- [d021-unreadable-models-dev-catalog.md](d021-unreadable-models-dev-catalog.md)
  — proposed (not applied): an unreadable models.dev catalog should skip only
  the OpenCode peers instead of aborting the whole cloud-peer layer.

#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""run_all.py — the cache pipeline, in dependency order.

  1. 10-fetch-hf-manifests.py   repo manifests, scope-driven: curation's input
  2. 30-generate.mjs            curation: lib/curated/*.json + config.d
  3. 40-download-models.py      provision exactly the curated files
  4. upkeep.py               refresh newer revisions, prune detached, verify
  5. fetch_model_cards.py    card mirrors

WHY manifests FIRST: a curated manifest resolves each entry's files from the
committed repo manifest, so refreshing the facts after provisioning would
download yesterday's set (docs/d212).

The generator is Node (it emits the llama-swap config and shares its capability
probes with the builder); every other step is Python. The launcher for the Node
step is the repo's own node-run.sh, which a copied-out unit does not ship — the
same trade every unit makes (docs/d138).

Secrets (HF_TOKEN) arrive as plain environment through the explicit chain:
./environment.sh uv run --script llm-local-inference/run_all.py. Nothing is fatal on
a missing token: gated repos log a warning and the sweep continues.

Exit code is the failing step's own code. Every step is idempotent, so a rerun
is the recovery path — there is no subset/step argument (a mode would be a flag
in disguise, docs/d212).

Usage: uv run --script llm-local-inference/run_all.py
"""

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import pathlib as _pl
import subprocess
import sys

sys.path.insert(0, str(_pl.Path(__file__).resolve().parent / "lib"))
import log

log.set_tool("llm-local-inference/run-all")
log.set_stream(sys.stderr)

HERE = _pl.Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
PY_STEPS = ["10-fetch-hf-manifests.py", "40-download-models.py", "upkeep.py", "fetch_model_cards.py"]


def die(code, message, **fields):
    log.error(message, **fields)
    raise SystemExit(code)


def run(label, argv):
    log.info("step start", step=label)
    completed = subprocess.run(argv, cwd=HERE, check=False)
    if completed.returncode != 0:
        die(completed.returncode, "step failed", step=label)


def main() -> int:
    # No arguments: a pipeline with selectable steps is a dispatcher with
    # implicit modes; every step is idempotent, so the whole run is the command.
    if len(sys.argv) > 1:
        print("usage: run_all.py   # runs every step; takes no arguments", file=sys.stderr)
        return 64

    run("30-generate.mjs", [str(REPO_ROOT / "node-run.sh"), "llm-local-inference/30-generate.mjs"])
    run("10-fetch-hf-manifests.py", ["uv", "run", "--quiet", "--script", "10-fetch-hf-manifests.py"])
    run("40-download-models.py", ["uv", "run", "--quiet", "--script", "40-download-models.py"])
    run("upkeep.py", ["uv", "run", "--quiet", "--script", "upkeep.py"])
    run("fetch_model_cards.py", ["uv", "run", "--quiet", "--script", "fetch_model_cards.py"])
    log.info("all done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


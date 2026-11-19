#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["huggingface_hub>=0.23.0"]
# ///
"""50-verify-cache.py — checksum-verify the served repos that are cached.

One job: verification. Provisioning belongs to 40-download-models.py (the curated
manifests are its input), so this tool never fetches — it only checks what the
curated set says must be there, and only where the repo is present under the
cache root that run.py binds.

The checksum itself is "hf cache verify": it owns the blob/refcount layout
(shared content-addressed store, per-repo blob files, .refs sidecars) and a
second implementation of that accounting is exactly how a cache gets corrupted.
It does not fail on files that exist upstream only, which is what makes a
curated (partial) snapshot verifiable — never pass --fail-on-missing-files.

Exit code 1 when any present repo fails verification. Absent repos are logged
and skipped: not pulling them is 40-download-models.py's report to make.

Usage: ./py-run.sh llm-local-inference/50-verify-cache.py
"""

import json

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import pathlib as _pl
import subprocess
import sys

sys.path.insert(0, str(_pl.Path(__file__).resolve().parent / "lib"))
import log

log.set_tool("llm-local-inference/verify-cache")
log.set_stream(sys.stderr)

HERE = _pl.Path(__file__).resolve().parent
CURATED = HERE / "lib" / "curated"


def hub_cache() -> _pl.Path:
    import os

    home = os.environ.get("HF_HOME") or os.path.join(
        os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "huggingface"
    )
    return _pl.Path(os.environ.get("HF_HUB_CACHE") or os.path.join(home, "hub"))


def main() -> int:
    if len(sys.argv) > 1:
        print("usage: 50-verify-cache.py   # takes no arguments", file=sys.stderr)
        return 64

    root = hub_cache()
    repos = [json.loads(p.read_text())["repo"] for p in sorted(CURATED.glob("*.json"))]
    failures = 0
    checked = 0
    for repo in repos:
        present = root / ("models--" + repo.replace("/", "--"))
        if not present.is_dir():
            log.info("repo not cached — nothing to verify", repo=repo)
            continue
        checked += 1
        log.info("verifying repo", repo=repo)
        completed = subprocess.run(
            ["uv", "tool", "run", "--quiet", "hf", "cache", "verify", "--json", repo],
            check=False,
        )
        if completed.returncode != 0:
            failures += 1
            log.error("verification failed", repo=repo)
    log.info("done", root=str(root), checked=checked, failures=failures)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())


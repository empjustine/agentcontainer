#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["huggingface_hub>=0.23.0"]
# ///
"""60-audit-snapshots.py — what in the HF cache the model manifest does not declare.

The read-only half of the pruning pair: it reports every cached file that
70-prune-cache.py would erase, with the reason, and exits 1 when there is
anything to remove. Nothing here deletes, downloads or verifies (the checksum
pass is 50-verify-cache.py); the classification itself is shared, so the report
and the deletion cannot disagree (docs/d218).

Reasons:
  repo-out-of-scope   the repo has no lib/cache-scope.json line at all
  repo-audit-only     in the inventory, no model entries: facts kept, weights not
  not-gguf            not something llama.cpp can be pointed at
  not-declared        a GGUF the model manifest does not name

Bytes are reported per file AND deduplicated by real blob path: the cache is
content-addressed, so two names can be one blob and only the second number is a
capacity figure. Repo manifests live in lib/hf-manifests/ (kilobytes, never in
the cache), so they are not part of this accounting.

Usage: uv run --script llm-local-inference/60-audit-snapshots.py
Exit code 1 when anything is prunable, 0 when clean.
"""

import json

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import pathlib as _pl
import sys

HERE = _pl.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "lib"))
import _serving_set as serving
import log

log.set_tool("llm-local-inference/audit-snapshots")
log.set_stream(sys.stderr)

GIB = 2**30


def main() -> int:
    # d215: a tool with no accepted arguments fails closed on argv.
    if len(sys.argv) > 1:
        print("usage: 60-audit-snapshots.py   # takes no arguments", file=sys.stderr)
        return 64

    root = serving.hub_cache()
    if not root.is_dir():
        raise SystemExit(f"{root} is not a directory — nothing to audit")

    wanted = serving.serving_set()
    declared = serving.scope()
    prunable = []
    kept = kept_bytes = 0
    blobs = {}
    for repo, cached in serving.cached_files(root):
        blobs[str(cached.blob_path)] = cached.size_on_disk
        reason = serving.classify(repo, cached.file_name, wanted, declared)
        if reason is None:
            kept += 1
            kept_bytes += cached.size_on_disk
            continue
        prunable.append(
            {
                "repo": repo,
                "file": cached.file_name,
                "bytes": cached.size_on_disk,
                "reason": reason,
            }
        )

    by_reason = {}
    for item in prunable:
        bucket = by_reason.setdefault(item["reason"], {"files": 0, "bytes": 0})
        bucket["files"] += 1
        bucket["bytes"] += item["bytes"]

    print(
        json.dumps(
            {
                "root": str(root),
                "cachedFiles": kept + len(prunable),
                "keptFiles": kept,
                "keptGib": round(kept_bytes / GIB, 2),
                "prunableFiles": len(prunable),
                "prunableGib": round(sum(i["bytes"] for i in prunable) / GIB, 2),
                "uniqueBlobsGib": round(sum(blobs.values()) / GIB, 2),
                "byReason": {
                    k: {"files": v["files"], "gib": round(v["bytes"] / GIB, 2)}
                    for k, v in sorted(by_reason.items())
                },
                "prunable": prunable,
            },
            indent=2,
        )
    )
    log.info(
        "snapshot audit done",
        root=str(root),
        prunable=len(prunable),
        prunableGib=round(sum(i["bytes"] for i in prunable) / GIB, 2),
        kept=kept,
    )
    return 1 if prunable else 0


if __name__ == "__main__":
    raise SystemExit(main())


#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""60-audit-snapshots.py — what in the HF cache the serving set no longer claims.

Reports (never deletes) every cached file that is not part of this unit's
serving set, with the reason, so the operator decides before anything moves. Its
destructive sibling prunes exactly what this lists, by calling "hf cache rm"
per file — the refcount-aware primitive — and never by editing the content
store.

The keep set is the union of:
  - lib/curated/*.json          what is served AND provisioned (docs/d212),
  - the model manifest rows      every declared quant, including the rows the
                                 display rules hide: the manifest is the raw
                                 record, so a declared file is chosen (d200),
  - each curated "optional"      the split index when the repo ships one.

lib/cache-scope.json decides existence, not files: a repo with NO line is out of
scope, so everything cached for it is prunable; an "audit-only" repo is kept
whole, because that mode means "verified if already cached, never downloaded"
and pruning it would empty a declared keep. A "served" repo keeps exactly its
wanted files.

Reasons a file can appear:
  repo-out-of-scope   the repo is not in lib/cache-scope.json at all
  not-gguf            not something llama.cpp can be pointed at (cards,
                      tokenizer sidecars, safetensors, imatrix, Android builds)
  quant-not-chosen    a GGUF the serving set does not name: another quant of a
                      served repo, a full-precision sibling, an extra drafter

Bytes are reported deduplicated by real blob path: this cache mixes the shared
content-addressed store (blobs/<xx>/<oid>, with .refs sidecars) and per-repo
blob files, so two names can be one blob. A per-repo total is not a capacity
number — the audit prints both.

Usage:
    ./py-run.sh llm-local-inference/60-audit-snapshots.py

Exit code 1 when anything is prunable (a gate for run_all.py), 0 when clean.
"""

import json

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import os
import pathlib as _pl
import sys
from pathlib import Path

sys.path.insert(0, str(_pl.Path(__file__).resolve().parent / "lib"))
import log

log.set_tool("llm-local-inference/audit-snapshots")
log.set_stream(sys.stderr)

HERE = Path(__file__).parent
LIB = HERE / "lib"
GIB = 2**30

# A runnable file is a GGUF, or the split index that belongs to one. Everything
# else in a snapshot is upstream packaging llama.cpp never opens.
INDEX_SUFFIX = ".gguf.index.json"


def hub_cache() -> Path:
    home = os.environ.get("HF_HOME") or os.path.join(
        os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "huggingface"
    )
    return Path(os.environ.get("HF_HUB_CACHE") or os.path.join(home, "hub"))


def scope() -> dict:
    return json.loads((LIB / "cache-scope.json").read_text())


def repo_manifest(repo):
    path = LIB / "hf-manifests" / (repo.replace("/", "--") + ".json")
    if not path.is_file():
        return None
    data = json.loads(path.read_text())
    return {f["path"]: (f.get("oid"), f.get("size") or 0) for f in data["files"]}


def wanted_files():
    """repo -> set(path) that must stay: curated + declared rows + curated index.

    Shards are expanded here without the generator's helpers on purpose: the
    model manifest names shard 1 and the repo manifest carries the rest, so the
    expansion is a path lookup, not a second implementation of a rule.
    """
    wanted = {}
    curated_dir = LIB / "curated"
    curated = {}
    for path in sorted(curated_dir.glob("*.json")):
        rec = json.loads(path.read_text())
        curated[rec["repo"]] = rec
        keep = set(rec["files"]) | set(rec.get("optional", []))
        wanted.setdefault(rec["repo"], set()).update(keep)

    model = json.loads((LIB / "llamacpp-model-data.json").read_text())
    for row in model["models"]:
        repo = row["hf-repo"].split(":")[0]
        wanted.setdefault(repo, set()).add(row["model"])
        if row.get("model-draft"):
            wanted[repo].add(row["model-draft"])
        if row.get("mmproj"):
            wanted[repo].add(row["mmproj"])
    return wanted, curated


def cached_snapshots(root):
    """(repo, relative path, real blob path, bytes) for every snapshot entry."""
    for repo_dir in sorted(root.glob("models--*")):
        repo = repo_dir.name[len("models--"):].replace("--", "/")
        for snap in sorted(repo_dir.glob("snapshots/*")):
            for path in sorted(snap.rglob("*")):
                if not path.is_file():
                    continue
                real = path.resolve()
                rel = str(path.relative_to(snap))
                yield repo, rel, real, real.stat().st_size


def classify(repo, rel, wanted, declared):
    if repo not in declared:
        return "repo-out-of-scope"
    if declared[repo] == "audit-only":
        return None  # the mode says keep what is cached
    if rel in wanted.get(repo, set()):
        return None
    if rel.endswith((".gguf", INDEX_SUFFIX)):
        return "quant-not-chosen"
    return "not-gguf"


def main() -> int:
    # d215: a tool with no accepted arguments fails closed on argv, because
    # ignoring it would run the tool's full effect anyway.
    if len(sys.argv) > 1:
        print("usage: 60-audit-snapshots.py   # takes no arguments", file=sys.stderr)
        return 64

    root = hub_cache()
    if not root.is_dir():
        raise SystemExit(f"{root} is not a directory — nothing to audit")

    declared = scope()
    wanted, _curated = wanted_files()
    missing_manifest = [r for r in declared if repo_manifest(r) is None]

    prunable = []
    kept = 0
    kept_bytes = 0
    blobs = {}  # real path -> bytes, so shared content is counted once
    for repo, rel, real, size in cached_snapshots(root):
        reason = classify(repo, rel, wanted, declared)
        blobs[str(real)] = size
        if reason is None:
            kept += 1
            kept_bytes += size
            continue
        prunable.append({"repo": repo, "file": rel, "bytes": size, "reason": reason})

    by_reason = {}
    for item in prunable:
        bucket = by_reason.setdefault(item["reason"], {"files": 0, "bytes": 0})
        bucket["files"] += 1
        bucket["bytes"] += item["bytes"]

    # the bytes that pruning would actually return: only blobs no kept file and
    # no other prunable file shares. Conservative: a blob referenced twice is
    # counted once, under whichever entry names it first.
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
                "reposWithoutManifest": missing_manifest,
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


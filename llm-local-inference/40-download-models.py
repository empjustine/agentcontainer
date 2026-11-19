#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "huggingface_hub>=0.23.0",   # tested with 0.36.x; snapshot_download
# ]
# ///
"""40-download-models.py — provision exactly the files the curated manifests name.

Input is the curated set the generator wrote (lib/curated/<org>--<repo>.json),
one file per served repo: the entry labels it serves, every file those entries
need (all shards, the resolved projector, any drafter sidecar) and the split
index when the repo ships one. Nothing else is fetched.

WHY the curated files and not lib/llamacpp-model-data.json: the model manifest
is the RAW record, so reading it here would fetch the quants the display rules
hid and miss the projector the generator resolves from the repo manifest (no
entry declares one). WHY not config.d: its cmd strings are a rendering (guest
paths, macro-expanded flags) and parsing them is a workaround for not having
this artifact. The curated files are data, written by the same run that renders
config.d, so served and downloaded cannot diverge (docs/d212).

Downloads always go through the "main" REF, never a pinned commit hash: a
commit-hash download creates a snapshots/<sha>/ dir with no refs/ entry, i.e. a
DETACHED revision, which upkeep.py's prune step deletes on its next run
(hf-cache-upkeep.md). The manifestCommit in a curated file is for drift
reporting only.

Reports file bytes AND unique blob bytes: the cache is content-addressed, so a
file shared by two repos (the qat / qat-mobile families ship identically named
quants) costs one blob. A fit check must use the deduped number, which is why
the oids come from the repo manifests rather than a sum of file sizes.

Exit code 1 when a curated file names something the repo manifest does not ship
(a stale curated set — re-run 30-generate.mjs) or a download fails.
"""

import json

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import os
import pathlib as _pl
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

sys.path.insert(0, str(_pl.Path(__file__).resolve().parent / "lib"))
import log

log.set_tool("llm-local-inference/download-models")
log.set_stream(sys.stderr)

HERE = Path(__file__).parent
CURATED = HERE / "lib" / "curated"
MANIFESTS = HERE / "lib" / "hf-manifests"
# Free space kept back so a provisioning run cannot take a filesystem to 100%.
MARGIN = 2 * 2**30
REVISION = "main"
GIB = 2**30


def repo_manifest(repo):
    """The committed repo manifest: name -> (oid, size). Absent is an error —
    a curated file without facts cannot be validated or sized."""
    path = MANIFESTS / (repo.replace("/", "--") + ".json")
    if not path.is_file():
        raise SystemExit(
            f"curated manifest for {repo} has no committed repo manifest ({path.name}); "
            "run ./py-run.sh llm-local-inference/10-fetch-hf-manifests.py"
        )
    data = json.loads(path.read_text())
    return {f["path"]: (f.get("oid"), f.get("size") or 0) for f in data["files"]}


def curated():
    """Every curated manifest, repo-sorted, as the provisioning plan."""
    if not CURATED.is_dir():
        raise SystemExit(
            f"{CURATED} is missing — generate it first: "
            "LOCAL_INFERENCE=1 ./node-run.sh llm-local-inference/30-generate.mjs"
        )
    return [json.loads(p.read_text()) for p in sorted(CURATED.glob("*.json"))]


def hub_cache():
    """The root this run provisions: the same override chain run.py binds.

    Read from HF_HUB_CACHE only — HF_HOME/hub is the same variable spelled
    twice, and a checksum or bind aimed at a different root would provision a
    tree nothing serves (docs/d207).
    """
    home = os.environ.get("HF_HOME") or os.path.join(
        os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "huggingface"
    )
    return Path(os.environ.get("HF_HUB_CACHE") or os.path.join(home, "hub"))


def stored(root, oid):
    """Whether the blob is already in the content-addressed store."""
    return (root / "blobs" / oid[:2] / oid).is_file() or (root / "blobs" / oid).is_file()


def preflight(root, records):
    """Refuse BEFORE the first byte when the missing set cannot fit.

    The cache is content-addressed, so the bytes still to fetch are the files
    whose oid is absent from the store — not the curated total, which stays
    large while most of it is already cached. This is the guard the naive
    whole-repo pull lacked: it took a 3.7T filesystem to 100% (docs/d212).
    """
    missing = 0
    for rec in records:
        shipped = repo_manifest(rec["repo"])
        for f in rec["files"]:
            oid, size = shipped[f]
            if not oid or not stored(root, oid):
                missing += size
    stat = os.statvfs(root if root.is_dir() else root.parent)
    available = stat.f_bavail * stat.f_frsize
    log.info(
        "provisioning plan",
        root=str(root),
        missingGib=round(missing / GIB, 2),
        availableGib=round(available / GIB, 2),
        marginGib=round(MARGIN / GIB, 2),
    )
    if missing + MARGIN > available:
        log.error(
            "refusing to provision: the missing bytes exceed the free space",
            root=str(root),
            missingGib=round(missing / GIB, 2),
            availableGib=round(available / GIB, 2),
            hint="point HF_HUB_CACHE at a root with room, or curate a smaller set",
        )
        return False
    return True


def main():
    # A tool with no flags must FAIL on arguments: argv is not a comment field,
    # and a stray "--help" running a full provision is how a 115 GiB download
    # landed on a nearly full root (docs/d212).
    if len(sys.argv) > 1:
        print(
            "usage: 40-download-models.py   # provisions every curated manifest; takes no arguments",
            file=sys.stderr,
        )
        return 64

    records = curated()
    root = hub_cache()
    if not preflight(root, records):
        return 1
    return provision(records)


def provision(records):

    failures = 0
    file_bytes = 0
    blobs = {}  # oid -> size, the cache's unit of account
    for rec in records:
        repo = rec["repo"]
        shipped = repo_manifest(repo)
        wanted = list(rec["files"])
        optional = list(rec.get("optional", []))

        missing_facts = [f for f in wanted + optional if f not in shipped]
        for f in missing_facts:
            failures += 1
            log.error(
                "curated file is not in the repo manifest",
                repo=repo,
                file=f,
                hint="the curated set is stale — re-run 30-generate.mjs",
            )
        if missing_facts:
            continue

        for f in wanted:
            oid, size = shipped[f]
            blobs[oid] = size
            file_bytes += size

        try:
            folder = snapshot_download(
                repo, revision=REVISION, allow_patterns=wanted + optional
            )
        except Exception as e:  # noqa: BLE001 — per-repo failure logged; the run continues
            failures += len(wanted)
            log.error("download failed", repo=repo, files=len(wanted), error=e)
            continue

        missing = [f for f in wanted if not (Path(folder) / f).is_file()]
        for f in missing:
            failures += 1
            log.error(
                "planned file did not land",
                repo=repo,
                file=f,
                hint="upstream moved — re-run 10-fetch-hf-manifests.py, then 30-generate.mjs",
            )
        log.info(
            "repo ensured",
            repo=repo,
            entries=len(rec["entries"]),
            files=len(wanted) - len(missing),
            gib=round(rec["bytes"] / GIB, 2),
        )

    log.info(
        "done",
        repos=len(records),
        fileGib=round(file_bytes / GIB, 2),
        uniqueGib=round(sum(blobs.values()) / GIB, 2),
        sharedGib=round((file_bytes - sum(blobs.values())) / GIB, 2),
        failures=failures,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())


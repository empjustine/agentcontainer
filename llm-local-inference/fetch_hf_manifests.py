#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "huggingface_hub>=0.23.0",   # tested with 1.28.x; list_repo_tree + token auth
# ]
# ///
"""fetch_hf_manifests.py — download and persist the HF repo file listing that
llama-server resolves implicitly from `--hf-repo <org>/<repo>:<quant>`, and
audit every configured model in llamacpp-model-data.json against it.

Background: llama.cpp has no "quantization-to-file" manifest. On every load it
resolves the repo's default branch to a commit (GET /api/models/{repo}/refs,
prefers `main`), lists the tree (GET /api/models/{repo}/tree/{commit}?recursive=true),
then picks the GGUF by filename heuristic (`find_best_model`, common/download.cpp):
the tag must START at a token boundary (`^`, `-`, `.` or `/`) and be followed
by '.' or '-', case-insensitively — so `:F16` cannot select a `BF16` file and
`:Q4_XS` cannot select `IQ4_XS` (ggml-org/llama.cpp#31620). `_` is deliberately
NOT a boundary: #31620 added it, #31639 reverted it, so `step3p5_flash_Q4_K_S.gguf`
does not resolve by `:Q4_K_S` upstream either. mmproj/imatrix/mtp-/eagle3-/
dflash-/dspark- files are excluded, sharded models must be the first shard,
first match in tree order wins. Default tags without ':quant' are Q4_K_M then
Q8_0.

This tool caches that tree per repo as a local manifest
(hf-manifests/<org>--<repo>.json, including the resolved commit) so the audit
runs offline and drift against upstream's current main is caught early.

What the audit is worth: the generator bakes each entry's `--model` from the
HF cache (generate.mjs `bakeSnapshotPaths`) and download_models.py fetches the
filename in `model`, so the `:quant` is a LABEL, not a lookup key — llama.cpp
never runs find_best_model for these entries. The audit therefore checks the
label, not the served file: the tag's heuristic pick must be the configured
`model` (a tag naming a different file is a mislabel), and a repo whose
full-precision upload carries no tag at all (XHToken ships
`Spark-X2.6-1.7B.gguf`) is reported as label-only, because no tag can select
it and the baked path is what serves.

Usage:
    ./py-run.sh llm-local-inference/fetch_hf_manifests.py                 # refresh + audit every repo
    ./py-run.sh llm-local-inference/fetch_hf_manifests.py --repo ORG/REPO # one repo
    ./py-run.sh llm-local-inference/fetch_hf_manifests.py --offline       # no network: cached manifests only
    ./py-run.sh llm-local-inference/fetch_hf_manifests.py --print-plan    # llama.cpp's implicit pick per entry

Exit code 1 if a configured model disagrees with the heuristic pick or is absent
from the repo's tree.
"""

import argparse
import json

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import pathlib as _pl
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

from huggingface_hub import HfApi
from huggingface_hub.hf_api import RepoFile

sys.path.insert(0, str(_pl.Path(__file__).resolve().parent / "lib"))
import log

log.set_tool("llm-local-inference/fetch-hf-manifests")
# This script prints its payload (table/list/report) on stdout — logs go to
# stderr so the two never interleave (docs/d045).
log.set_stream(sys.stderr)

HERE = Path(__file__).parent
MODEL_DATA = HERE / "lib" / "llamacpp-model-data.json"
MANIFEST_DIR = HERE / "lib" / "hf-manifests"

SIDECAR_RE = re.compile(r"(mmproj|imatrix|mtp-|eagle3-|dflash-|dspark-)")
SPLIT_RE = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$")
DEFAULT_TAGS = ["Q4_K_M", "Q8_0"]

# A tag must start at a token boundary upstream (#31620) — without this prefix
# the replica selects a BF16 file for ":F16" and reports the config as wrong.
# The boundary set is exact, not approximately: underscore was tried upstream and
# reverted (#31639), so the replica must not accept it "to be safe".
TAG_BOUNDARY = r"(^|[-./])"


def fetch_manifest(api, repo):
    # HfApi handles pagination, retries and HF_TOKEN auth; revision="main"
    # mirrors llama.cpp's refs lookup (prefers `main`, common/download.cpp).
    commit = api.repo_info(repo_id=repo, revision="main").sha

    def lfs_sha256(lfs):
        # huggingface_hub renamed BlobLfsInfo.oid -> sha256 around v1.0;
        # both carry the LFS sha256, so accept either.
        return getattr(lfs, "sha256", None) or getattr(lfs, "oid", None)

    files = [{"path": t.path,
              "oid": lfs_sha256(t.lfs) if t.lfs else t.blob_id,
              "size": t.size}
             for t in api.list_repo_tree(repo_id=repo, revision=commit, recursive=True)
             if isinstance(t, RepoFile)]
    return {"repo": repo, "commit": commit,
            "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "files": files}


def manifest_path(repo):
    return MANIFEST_DIR / (repo.replace("/", "--") + ".json")


def load_manifest(api, repo, offline=False):
    """Fetch the tree and persist it, unless --offline.

    The cache exists for the offline audit, never as the source of truth for a
    networked run: this tool's contract is "refresh + audit" (docs/d060), so a
    run that can reach the Hub re-derives the mapping instead of blessing the
    committed copy. --offline is the one thing that narrows it to the cache.
    """
    p = manifest_path(repo)
    if offline:
        return json.loads(p.read_text()) if p.exists() else None
    m = fetch_manifest(api, repo)
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(m, indent="\t"))
    return m


def gguf_is_model(path):
    base = path.rsplit("/", 1)[-1]
    return path.endswith(".gguf") and not SIDECAR_RE.search(base)


def split_index(path):
    m = SPLIT_RE.search(path)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def find_best_model(manifest, tag):
    """Replicates find_best_model (common/download.cpp) on a cached manifest.

    Same tags, same order, same first-match-in-tree-order rule, same token
    boundary as upstream — a replica that lags the boundary reports a mismatch
    for a correct entry, which is exactly how it reads as noise.
    """
    tags = [tag] if tag else list(DEFAULT_TAGS)
    for t in tags:
        pat = re.compile(TAG_BOUNDARY + re.escape(t) + r"[.-]", re.IGNORECASE)
        for f in manifest["files"]:
            p = f["path"]
            idx, cnt = split_index(p)
            if cnt > 1 and idx != 1:
                continue
            if gguf_is_model(p) and pat.search(p):
                return p
    return None


def bare_repo(repo_full):
    return repo_full.split(":", 1)[0]


def quant_tag(repo_full):
    parts = repo_full.split(":", 1)
    return parts[1] if len(parts) > 1 else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", action="append", help="substring filter (repeatable)")
    ap.add_argument("--offline", action="store_true", help="audit against cached manifests only")
    ap.add_argument("--print-plan", action="store_true",
                    help="show the implicit llama.cpp file choice per model entry")
    args = ap.parse_args()

    api = HfApi()
    data = json.loads(MODEL_DATA.read_text())
    entries = [m for m in data["models"]
               if not args.repo or any(r in m["hf-repo"] for r in args.repo)]

    mismatches = 0
    label_only = 0
    print(f"{'repo:quant':52s} {'configured --model':44s} {'heuristic pick':40s} verdict")
    print("-" * 148)
    seen = {}
    for m in entries:
        repo = bare_repo(m["hf-repo"])
        if repo not in seen:
            try:
                seen[repo] = load_manifest(api, repo, args.offline)
            except Exception as e:  # noqa: BLE001 — FETCH FAILED is counted into mismatches, not fatal
                print(f"{m['hf-repo']:52s} FETCH FAILED: {e}")
                mismatches += 1
                continue
        man = seen[repo]
        if man is None:
            print(f"{m['hf-repo']:52s} no cached manifest (run without --offline)")
            mismatches += 1
            continue

        tag = quant_tag(m["hf-repo"])
        if not tag:
            # No label: the entry serves a repo whose catalog holds ONE quant, so
            # there is nothing for a tag to select or misspell. The heuristic pick
            # defaults to Q4_K_M and would report a correct Q8_0 row as a
            # mismatch, so an unlabelled entry is printed and never counted —
            # the same treatment as a repo whose full-precision upload carries no
            # tag (docs/d209).
            verdict = "unlabelled"
            label_only += 1
            picked = None
            configured = m["model"]
            if args.print_plan or verdict != "ok":
                print(f"{m['hf-repo']:52s} {configured:44s} {'(unlabelled)':40s} {verdict}")
            continue

        picked = find_best_model(man, tag)
        configured = m["model"]
        if picked == configured:
            verdict = "ok"
        elif picked is None and any(f["path"] == configured for f in man["files"]):
            # No tag selects a bare full-precision upload, and the served path
            # bakes the filename rather than resolving the tag, so this is a
            # label, not a broken lookup — printed, never counted (docstring).
            verdict = "label-only"
            label_only += 1
        elif picked is None:
            verdict = "MISSING"
            mismatches += 1
        else:
            verdict = "MISMATCH"
            mismatches += 1
        if args.print_plan or verdict != "ok":
            print(f"{m['hf-repo']:52s} {configured:44s} {(picked or '(none)'):40s} {verdict}")

    log.info("manifest audit done", manifestDir=str(MANIFEST_DIR),
             mismatches=mismatches, labelOnly=label_only)
    sys.exit(1 if mismatches else 0)


if __name__ == "__main__":
    main()

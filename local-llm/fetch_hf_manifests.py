#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "huggingface_hub>=0.23.0",   # tested with 1.28.x; list_repo_tree + token auth
# ]
# ///
"""fetch_hf_manifests.py — download and persist the HF repo file listing that
llama-server resolves implicitly from `--hf-repo <org>/<repo>:<quant>`, and
verify that each configured --model in llamacpp-model-data.json is what
llama.cpp would pick on its own.

Background: llama.cpp has no "quantization-to-file" manifest. On every load it
resolves the repo's default branch to a commit (GET /api/models/{repo}/refs,
prefers `main`), lists the tree (GET /api/models/{repo}/tree/{commit}?recursive=true),
then picks the GGUF by filename heuristic (`find_best_model`, common/download.cpp):
tag must appear in the path followed by '.' or '-' (case-insensitive), excluding
mmproj/imatrix/mtp-/eagle3-/dflash-/dspark- files, sharded models must be the
first shard, first match in tree order wins. Default tags without ':quant' are
Q4_K_M then Q8_0.

This tool caches that tree per repo as a local manifest
(hf-manifests/<org>--<repo>.json, including the resolved commit) so the
repo:quant -> file mapping can be audited offline and drift between the
configured --model and upstream's current main is caught early.

Usage:
    uv run fetch_hf_manifests.py                # refresh manifests + audit all repos
    uv run fetch_hf_manifests.py --repo unsloth/Qwen3.8-27B-GGUF
    uv run fetch_hf_manifests.py --offline      # audit against cached manifests only
    uv run fetch_hf_manifests.py --print-plan   # show llama.cpp's implicit choice per entry

Exit code 1 if any configured model disagrees with the heuristic pick.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from huggingface_hub import HfApi
from huggingface_hub.hf_api import RepoFile

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import pathlib as _pl

sys.path.insert(0, str(_pl.Path(__file__).resolve().parent.parent / "lib"))
import log

log.set_tool("local-llm/fetch-hf-manifests")

HERE = Path(__file__).parent
MODEL_DATA = HERE.parent / "openai-completions" / "llamacpp-model-data.json"
MANIFEST_DIR = HERE / "hf-manifests"

SIDECAR_RE = re.compile(r"(mmproj|imatrix|mtp-|eagle3-|dflash-|dspark-)")
SPLIT_RE = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$")
DEFAULT_TAGS = ["Q4_K_M", "Q8_0"]


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
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "files": files}


def manifest_path(repo):
    return MANIFEST_DIR / (repo.replace("/", "--") + ".json")


def load_manifest(api, repo, offline=False):
    p = manifest_path(repo)
    if p.exists():
        return json.loads(p.read_text())
    if offline:
        return None
    m = fetch_manifest(api, repo)
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(m, indent=1))
    return m


def gguf_is_model(path):
    base = path.rsplit("/", 1)[-1]
    return path.endswith(".gguf") and not SIDECAR_RE.search(base)


def split_index(path):
    m = SPLIT_RE.search(path)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def find_best_model(manifest, tag):
    """Replicates find_best_model (common/download.cpp) on a cached manifest."""
    tags = [tag] if tag else list(DEFAULT_TAGS)
    for t in tags:
        pat = re.compile(re.escape(t) + r"[.-]", re.IGNORECASE)
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
    ap.add_argument("--offline", action="store_true", help="use cached manifests only")
    ap.add_argument("--refresh", action="store_true", help="re-fetch even if cached")
    ap.add_argument("--print-plan", action="store_true",
                    help="show the implicit llama.cpp file choice per model entry")
    args = ap.parse_args()

    api = HfApi()
    data = json.loads(MODEL_DATA.read_text())
    entries = [m for m in data["models"]
               if not args.repo or any(r in m["hf-repo"] for r in args.repo)]

    mismatches = 0
    print(f"{'repo:quant':52s} {'configured --model':44s} {'heuristic pick':40s} verdict")
    print("-" * 148)
    seen = {}
    for m in entries:
        repo = bare_repo(m["hf-repo"])
        if args.refresh or repo not in seen:
            try:
                seen[repo] = load_manifest(api, repo, args.offline)
            except Exception as e:
                print(f"{m['hf-repo']:52s} FETCH FAILED: {e}")
                mismatches += 1
                continue
        man = seen[repo]
        if man is None:
            print(f"{m['hf-repo']:52s} no cached manifest (run without --offline)")
            mismatches += 1
            continue

        picked = find_best_model(man, quant_tag(m["hf-repo"]))
        configured = m["model"]
        ok = picked == configured
        if not ok:
            mismatches += 1
        if args.print_plan or not ok:
            verdict = "ok" if ok else ("MISMATCH" if picked else "NO MATCH")
            print(f"{m['hf-repo']:52s} {configured:44s} {picked or '(none)':40s} {verdict}")

    log.info("manifest audit done", manifestDir=str(MANIFEST_DIR), mismatches=mismatches)
    sys.exit(1 if mismatches else 0)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["huggingface_hub>=0.23.0"]
# ///
"""HuggingFace model-cache upkeep: list, prune, pull newer revisions, verify.

Drop-in replacement for local-llm/upkeep.sh, using huggingface_hub directly
(no podman, no `hf` CLI, no jq). Runs the full pipeline by default:

  1. list cached model repos
  2. prune detached revisions + orphan blobs
  3. pull newer revisions of tracked refs (network)
  4. verify each model repo (fail on corrupted / missing)

Env: HF_HUB_CACHE, HF_HOME, HF_TOKEN (see ./docs/hf-cache-upkeep.md).
"""
import os
import sys

from huggingface_hub import (
    scan_cache_dir,
    snapshot_download,
    HfApi,
)


def _cache_dir() -> str:
    home = os.environ.get("HF_HOME") or os.path.join(
        os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")),
        "huggingface",
    )
    return os.environ.get("HF_HUB_CACHE") or os.path.join(home, "hub")


def _commit(ref) -> str | None:
    # GitRefInfo carries the target commit in `.target_commit`; `.ref` is the
    # ref *path* (e.g. "refs/heads/main"), not a commit hash.
    return getattr(ref, "target_commit", None) or getattr(ref, "ref", None)


def prune(cache_info) -> None:
    """Prune detached (unreferenced) revisions and their orphan blobs (see
    docs/hf-cache-upkeep.md for the 0.23+ GC semantics)."""
    detached = {
        rev.commit_hash
        for repo in cache_info.repos
        for rev in repo.revisions
        if not rev.refs
    }
    if not detached:
        return
    for commit in sorted(detached):
        print(f"prune: detached revision {commit[:8]}")
    cache_info.delete_revisions(*detached).execute()


def pull_newer(cache_dir: str) -> None:
    """Download newer revisions for each tracked ref of each cached model."""
    api = HfApi()
    info = scan_cache_dir(cache_dir)
    for repo in info.repos:
        if repo.repo_type != "model":
            continue
        try:
            refs = api.list_repo_refs(repo_id=repo.repo_id, repo_type="model")
        except Exception as e:
            print(f"{repo.repo_id}: cannot read remote refs ({e}); skipping",
                  file=sys.stderr)
            continue
        remote = {r.name: _commit(r) for r in refs.branches}
        for name, revision in repo.refs.items():
            local_commit = revision.commit_hash
            remote_commit = remote.get(name)
            if not remote_commit or remote_commit == local_commit:
                continue
            # Refresh only the weights already in the cache (e.g. the single GGUF
            # quant an engine serves), not the whole repo at the new revision.
            wanted = sorted(f.file_name for f in revision.files)
            print(
                f"{repo.repo_id}: {name} {local_commit[:8]} -> {remote_commit[:8]} "
                f"(pulling {len(wanted)} cached file(s))"
            )
            try:
                snapshot_download(
                    repo.repo_id,
                    repo_type="model",
                    revision=name,
                    allow_patterns=wanted,
                )
                # GGUF repos also carry small index/metadata files the loader
                # resolves on first use; pre-fetch those too, skipping the other
                # (unused) heavy .gguf quants.
                if any(f.file_name.endswith(".gguf") for f in revision.files):
                    snapshot_download(
                        repo.repo_id,
                        repo_type="model",
                        revision=name,
                        ignore_patterns=["*.gguf"],
                    )
            except Exception as e:
                print(f"{repo.repo_id}: pull failed ({e})", file=sys.stderr)


def main() -> int:
    cache_dir = _cache_dir()

    # 1. list model repos
    info = scan_cache_dir(cache_dir)
    for repo in info.repos:
        if repo.repo_type == "model":
            print(repo.repo_id)

    # 2. pull newer revisions of tracked refs (network) FIRST, so each ref points
    #    at a fully-downloaded revision before anything is removed. Pruning before
    #    pulling risks a race: an interrupted pull can leave a ref pointing at an
    #    incomplete revision while the only usable revision (now detached) gets
    #    deleted, leaving no reasonable revision behind.
    pull_newer(cache_dir)

    # 3. prune detached (stale) revisions + orphan blobs, now that pulls have
    #    landed and moved refs onto complete revisions.
    prune(scan_cache_dir(cache_dir))

    # 4. verify each model repo (fail on corrupted / missing)
    # scan_cache_dir reports structural problems (missing blobs, broken symlinks,
    # dangling refs) as CorruptedCacheException entries in HFCacheInfo.warnings.
    rc = 0
    info = scan_cache_dir(cache_dir)
    for repo in info.repos:
        if repo.repo_type != "model":
            continue
        print(f"{repo.repo_id}: OK ({repo.nb_files} files, {repo.size_on_disk_str})")

    for w in info.warnings:
        rc = 1
        print(f"CORRUPTED: {w}", file=sys.stderr)

    for f in getattr(info, "incomplete_files", frozenset()):
        print(f"INCOMPLETE: {f.file_path}", file=sys.stderr)

    return rc


if __name__ == "__main__":
    raise SystemExit(main())

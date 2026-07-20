#!/usr/bin/env python3
"""HuggingFace model-cache upkeep: list, prune, pull newer revisions, verify.

Drop-in replacement for huggingface/upkeep.bash, using huggingface_hub
directly (no podman, no `hf` CLI, no jq). Runs the full pipeline by default:

  1. list cached model repos
  2. prune detached revisions + orphan blobs
  3. pull newer revisions of tracked refs (network)
  4. verify each model repo (fail on corrupted / missing)

Env:
  HF_HUB_CACHE   cache dir (default ~/.cache/huggingface/hub)
  HF_HOME        falls back to XDG_CACHE_HOME/huggingface
  HF_TOKEN       token for gated models (optional; auto-read from cache)

API note: the cache-scanning API in huggingface_hub >= 0.23 was rewritten.
`scan_cache_dir()` now returns a single `HFCacheInfo` whose `repos` are
`CachedRepoInfo` objects (there is no longer a per-repo `.delete_revisions`,
`.commits`, or `.warnings`). Revisions are pruned via
`HFCacheInfo.delete_revisions(*hashes)` which returns a `DeleteCacheStrategy`
you `.execute()`. In this model refs always point at a present revision, so a
ref whose commit is missing now makes the whole repo *corrupted* (reported in
`HFCacheInfo.warnings`) rather than being silently prunable. The closest safe
GC to the old "prune dangling refs + orphan blobs" step is to drop revisions
that no ref points at (detached), which also reclaims the blobs those
revisions were the sole user of.

Note on XET: if the XET client is installed, weights for XET-enabled repos are
fetched as content-addressed chunks into a *separate* XET chunk cache (default
~/.cache/huggingface/xet, override with XET_CACHE_PATH). Those chunks are NOT
scanned by scan_cache_dir/prune/verify, which only understand the
blobs/ + snapshots/ + refs/ layout. The reassembled snapshot files are still
tracked normally; only the underlying chunk store is outside this tool's GC.
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
    # GitRefInfo (returned by list_repo_refs) carries the target commit in
    # `.target_commit`; `.ref` is the ref *path* (e.g. "refs/heads/main"),
    # not a commit hash, so it must not be used for comparison.
    return getattr(ref, "target_commit", None) or getattr(ref, "ref", None)


def prune(cache_info) -> None:
    """Prune detached (unreferenced) revisions and their orphan blobs.

    The rewritten cache API no longer surfaces "dangling" refs (refs that point
    at a commit which was never downloaded / was already pruned); `repo.refs`
    only contains refs whose target revision is present, and a ref pointing at a
    missing commit now marks the repo as corrupted (see `HFCacheInfo.warnings`)
    instead of being silently removable. The safe, equivalent GC is to drop
    revisions that no ref points at, which also frees the blobs only those
    revisions used. Shared blobs that other revisions still reference are kept.
    """
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
            # Only refresh the weights already in the cache (e.g. the single GGUF
            # quant an engine actually serves) rather than re-fetching the whole
            # repo (every quant / every file) at the new revision.
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
                # GGUF repos also carry an index/metadata file (the quant table in
                # README.md, the imatrix, projector config, ...) that the loader
                # resolves against on first use. Pre-fetch those small files too so a
                # first load can be served from cache, while still skipping the other
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

    # 2. prune detached revisions + orphan blobs
    prune(info)

    # 3. pull newer revisions of tracked refs (network)
    pull_newer(cache_dir)

    # 4. verify each model repo (fail on corrupted / missing)
    #
    # The rewritten scanner reports structural problems (including missing-blob
    # / dangling-ref repos) as free-text CorruptedCacheException entries in
    # `HFCacheInfo.warnings` rather than per-file `warnings` on each repo, so
    # verification here is at repo granularity plus orphaned partial downloads.
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

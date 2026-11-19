#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["huggingface_hub>=0.23.0"]
# ///
"""70-prune-cache.py — erase from the HF cache what the manifest does not declare.

Two removals, one pass, in this order (docs/d218):

1. **Undeclared weights.** Every cached file outside the serving set — the
   curated manifests plus the model manifest's rows — is erased: another quant
   of a served repo, a repo the manifest no longer holds, a card, an imatrix.
   Cheap: classification is filenames and sizes, no reads.
2. **Failed checksums.** The repos that remain are verified through
   hub_api.verify_repo_checksums, and every file it reports as a mismatch is
   erased. Expensive (it reads the files), which is why it runs after the cheap
   pass instead of over gigabytes that are leaving anyway.

Deletion goes through HFCacheInfo.delete_files, the refcount-aware API (the CLI's
"hf cache rm" is its face): the snapshot entry goes, and a blob goes only when
no other revision references it. Hand-walking blobs would drop a blob another
repo still uses.

NOTHING here touches lib/hf-manifests/ or lib/llamacpp-model-data.json: those are
committed facts of kilobytes each and never live in the cache, so they are not
weights to prune. A repo left with a repo manifest but no weights is exactly the
"audit-only" state: its facts stay usable offline for a later promotion.

Why a separate tool and not a flag on 50-verify-cache.py: a no-flag tool must
fail closed (d215), a preview is its own read-only tool (60-audit-snapshots.py),
and verification and deletion are two jobs (d213).

Usage: ./py-run.sh llm-local-inference/70-prune-cache.py
Exit code 1 when a deletion or a verification failed; 0 when the cache matches
the manifest.
"""

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import pathlib as _pl
import sys

from huggingface_hub import HfApi, scan_cache_dir

HERE = _pl.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "lib"))
import _serving_set as serving
import log

log.set_tool("llm-local-inference/prune-cache")
log.set_stream(sys.stderr)

GIB = 2**30


def cached_index(root, wanted, declared):
    """(deletions, kept-per-repo) from one scan of the cache."""
    deletions = []
    kept_by_repo = {}
    for repo, cached in serving.cached_files(root):
        reason = serving.classify(repo, cached.file_name, wanted, declared)
        if reason is None:
            kept_by_repo.setdefault(repo, []).append(cached)
        else:
            deletions.append((reason, repo, cached))
    return deletions, kept_by_repo


def main() -> int:
    # d215: a tool with no accepted arguments fails closed on argv.
    if len(sys.argv) > 1:
        print("usage: 70-prune-cache.py   # takes no arguments", file=sys.stderr)
        return 64

    root = serving.hub_cache()
    if not root.is_dir():
        raise SystemExit(f"{root} is not a directory — nothing to prune")
    wanted = serving.serving_set()
    declared = serving.scope()

    cache = scan_cache_dir(str(root))
    deletions, kept_by_repo = cached_index(root, wanted, declared)

    undeclared_bytes = sum(f.size_on_disk for _, _, f in deletions)
    for reason, repo, cached in deletions:
        log.info(
            "erasing undeclared file",
            repo=repo,
            file=cached.file_name,
            gib=round(cached.size_on_disk / GIB, 3),
            reason=reason,
        )
    log.info(
        "undeclared pass",
        files=len(deletions),
        gib=round(undeclared_bytes / GIB, 2),
    )

    failures = 0
    freed = 0
    if deletions:
        try:
            strategy = cache.delete_files(*(f for _, _, f in deletions))
            freed += strategy.expected_freed_size
            strategy.execute()
        except Exception as e:  # noqa: BLE001 — a failed deletion is reported, not fatal
            log.error("deletion failed", files=len(deletions), error=e)
            failures += 1

    # verification runs on what survived the cheap pass
    api = HfApi()
    for repo in sorted(kept_by_repo):
        try:
            result = api.verify_repo_checksums(repo, cache_dir=str(root))
        except Exception as e:  # noqa: BLE001 — offline/gated repo: report, keep going
            log.warn("cannot verify", repo=repo, error=e)
            failures += 1
            continue
        bad = {m["path"] for m in result.mismatches}
        if not bad:
            log.info("checksums ok", repo=repo, files=result.checked_count)
            continue
        log.warn("checksum mismatch — erasing", repo=repo, files=sorted(bad))
        rescan = scan_cache_dir(str(root))
        victims = [
            f
            for r, f in serving.cached_files(root)
            if r == repo and f.file_name in bad
        ]
        try:
            strategy = rescan.delete_files(*victims)
            freed += strategy.expected_freed_size
            strategy.execute()
        except Exception as e:  # noqa: BLE001
            log.error("deletion failed", repo=repo, error=e)
            failures += 1

    log.info("done", freedGib=round(freed / GIB, 2), failures=failures)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())


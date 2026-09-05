#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "huggingface_hub>=0.23.0",   # tested with 0.36.x; hf_hub_download + list_repo_tree
# ]
# ///
"""download_models.py — provision the exact GGUFs the gfx1030 instance serves.

Reads openai-completions/llamacpp-model-data.json and downloads, from
each entry's "hf-repo", the LATEST main revision of:

  - "model"   the served GGUF. Sharded models are expanded to ALL shards; the
              split index (`*.gguf.index.json`) is downloaded only when the
              repo actually ships one. llama.cpp needs every shard, not just
              the configured first one; the index is optional because many
              repos (e.g. unsloth's per-quant sub-directories) omit it and rely
              on sequential-shard auto-detection.
  - "mmproj"  the vision projector, when the entry declares one.
  - "model-draft" the MTP/drafter sidecar GGUF, when the entry declares one
              (unsloth ships these under the repo's MTP/ sub-directory; the
              sub-directory prefix is part of the configured filename).

The `:quant` tag in "hf-repo" is informational only here — the filename in
"model" pins the quant, and we always resolve the repo's current default
branch (mirroring llama.cpp's own refs lookup). Model and mmproj of an entry
are fetched at the SAME resolved commit so a snapshot is internally
consistent.

Files land in the shared HF cache (HF_HUB_CACHE / HF_HOME / ~/.cache/huggingface/hub),
where both llama-server's cache resolution (generate-local-llm-models.yaml.mjs)
and the coding agent's cache mount pick them up without re-download. Re-runs
are idempotent: huggingface_hub skips complete blobs via etag comparison.
After provisioning, upkeep.py owns the cache (refresh newer revisions, prune).

Downloads always go through the "main" REF, never a pinned commit hash:
a commit-hash download creates a snapshots/<sha>/ dir with no refs/ entry,
i.e. a DETACHED revision, which upkeep.py's prune step deletes on its next
run (an endless re-download/purge cycle). snapshot_download(revision="main")
resolves the branch once per call, so model + mmproj of an entry still land
at the SAME resolved commit while refs/main keeps the revision attached.

Usage:
    uv run download_models.py                     # all manifest entries
    uv run download_models.py --repo unsloth/Qwen3.8   # substring filter (repeatable)
    uv run download_models.py --dry-run           # resolve + validate only

Exit code 1 if any configured file is missing from its repo or fails to download.
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download
from huggingface_hub.hf_api import RepoFile

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import pathlib as _pl

sys.path.insert(0, str(_pl.Path(__file__).resolve().parent.parent / "lib"))
import log

log.set_tool("local-llm/download-models")

HERE = Path(__file__).parent
MODEL_DATA = HERE.parent / "openai-completions" / "llamacpp-model-data.json"

SPLIT_RE = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$")


def bare_repo(repo_full):
    return repo_full.split(":", 1)[0]


def wanted_files(model_name):
    """Expand a configured model filename into (shards, index_or_None).

    A sharded GGUF (``-NNNNN-of-NNNNN.gguf``) expands to ALL of its shards.
    The split index (``*.gguf.index.json``) is returned separately and may be
    None when the model is not sharded or the caller decides not to require it.
    The shard prefix preserves any sub-directory in the configured filename
    (e.g. ``UD-IQ1_S/DeepSeek-...-00001-of-00003.gguf``).
    """
    m = SPLIT_RE.search(model_name)
    if not m:
        return [model_name], None
    first, count = int(m.group(1)), int(m.group(2))
    if first != 1:
        raise ValueError(f"sharded model must be configured as shard 1: {model_name}")
    prefix = model_name[: m.start()]
    width = len(m.group(1))
    shards = [f"{prefix}-{i:0{width}d}-of-{count:0{width}d}.gguf"
              for i in range(1, count + 1)]
    index = f"{prefix}-{first:0{width}d}-of-{count:0{width}d}.gguf.index.json"
    return shards, index


def resolve(api, repo, entries):
    """Resolve one repo's entries to concrete files at the current main commit.
    The commit is used for validation/reporting only; the actual download goes
    through the "main" ref (see module docstring).
    Returns (commit, [(filename, label)], errors)."""
    errors = []
    try:
        commit = api.repo_info(repo_id=repo, revision="main").sha
        tree = {t.path for t in api.list_repo_tree(
            repo_id=repo, revision=commit, recursive=True) if isinstance(t, RepoFile)}
    except Exception as e:
        return None, [], [f"cannot resolve {repo}@main: {e}"]

    wanted = []
    for e in entries:
        for key in ("model", "mmproj", "model-draft"):
            name = e.get(key)
            if not name:
                continue
            try:
                shards, index = wanted_files(name)
            except ValueError as ve:
                errors.append(f"{e['hf-repo']} {key}: {ve}")
                continue
            # Shards are mandatory; the split index is optional and is only
            # pulled in when the repo actually ships it.
            missing = [f for f in shards if f not in tree]
            if missing:
                errors.append(f"{repo}@{commit[:8]}: {key} {name} — "
                              f"missing from tree: {', '.join(missing)}")
                continue
            files = list(shards)
            if index is not None and index in tree:
                files.append(index)
            wanted.extend((f, f"{name} ({key})") for f in files)
    return commit, wanted, errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", action="append",
                    help="substring filter on hf-repo (repeatable)")
    ap.add_argument("--dry-run", action="store_true",
                    help="resolve and validate only; download nothing")
    args = ap.parse_args()

    data = json.loads(MODEL_DATA.read_text())
    by_repo = defaultdict(list)
    for m in data["models"]:
        repo = bare_repo(m["hf-repo"])
        if args.repo and not any(r in repo for r in args.repo):
            continue
        by_repo[repo].append(m)

    api = HfApi()
    failures = 0
    total_bytes = 0
    for repo, entries in sorted(by_repo.items()):
        log.info("repo plan", repo=repo, entries=len(entries))
        commit, wanted, errors = resolve(api, repo, entries)
        failures += len(errors)
        for err in errors:
            log.error("resolution failed", error=str(err))
        if not wanted:
            continue
        if args.dry_run:
            seen = set()
            for fname, label in wanted:
                if fname in seen:
                    continue
                seen.add(fname)
                log.info("planned file", file=fname, label=label, commit=commit[:8])
            continue
        try:
            folder = snapshot_download(
                repo,
                revision="main",
                allow_patterns=[fname for fname, _ in wanted],
            )
            seen = set()
            for fname, label in wanted:
                if fname in seen:
                    continue
                seen.add(fname)
                size = (Path(folder) / fname).stat().st_size
                total_bytes += size
                log.info("file ensured", file=fname, gib=round(size / 2**30, 2))
        except Exception as e:
            failed = sorted({fname for fname, _ in wanted})
            failures += len(failed)
            for fname in failed:
                log.error("file failed", file=fname, error=str(e))

    if args.dry_run:
        log.info("dry run — nothing downloaded")
    else:
        log.info("done", newlyEnsuredGib=round(total_bytes / 2**30, 2),
                 failures=failures)
    if failures != 0:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

"""_serving_set.py — the cache files this unit is allowed to keep.

Shared by the two snapshot tools: 60-audit-snapshots.py reports, 70-prune-cache.py
removes. The classification lives here so the report and the deletion can never
disagree about what "declared" means (the drift class the retired scanners kept
paying for).

The serving set is the union of:
  - lib/curated/<org>--<repo>.json   what is served AND provisioned (docs/d212),
  - the model manifest rows          every declared quant, shards expanded from
                                     the committed repo manifest,
  - each curated "optional"          the split index when the repo ships one.

The repo manifests under lib/hf-manifests/ are NOT part of this: they are
committed facts (kilobytes each) and never live in the HF cache, so an
incorrectly fetched GGUF outweighs the whole manifest set by orders of
magnitude. Pruning is about weights.
"""

import json
import os
import re
from pathlib import Path

HERE = Path(__file__).parent
LIB = HERE / "lib"
SPLIT_RE = re.compile(r"-\d{5}-of-\d{5}\.gguf$")
INDEX_SUFFIX = ".gguf.index.json"


def hub_cache() -> Path:
    """The root this unit serves from: the same override chain run.py binds."""
    home = os.environ.get("HF_HOME") or os.path.join(
        os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "huggingface"
    )
    return Path(os.environ.get("HF_HUB_CACHE") or os.path.join(home, "hub"))


def scope() -> dict:
    """repo -> mode, the closed inventory (docs/d212)."""
    return json.loads((LIB / "cache-scope.json").read_text())


def curated() -> dict:
    """repo -> curated record written by 30-generate.mjs."""
    out = {}
    for path in sorted((LIB / "curated").glob("*.json")):
        rec = json.loads(path.read_text())
        out[rec["repo"]] = rec
    return out


def repo_manifest(repo: str):
    """repo -> {path: (oid, size)} from the committed repo manifest, or None."""
    path = LIB / "hf-manifests" / (repo.replace("/", "--") + ".json")
    if not path.is_file():
        return None
    data = json.loads(path.read_text())
    return {f["path"]: (f.get("oid"), f.get("size") or 0) for f in data["files"]}


def shards(repo: str, name: str) -> list:
    """Every uploaded shard of a de-sharded name, from that repo's manifest.

    A row names shard 1; the sibling shards are facts of the repo manifest, so
    expanding through it keeps a sharded model whole instead of leaving shard 1
    beside a pruned 00002.
    """
    manifest = repo_manifest(repo)
    if manifest is None:
        return [name]
    matched = [p for p in manifest if SPLIT_RE.sub(".gguf", p) == name]
    return matched or [name]


def serving_set() -> dict:
    """repo -> set(path) that must stay in the cache."""
    wanted = {}
    for repo, rec in curated().items():
        wanted.setdefault(repo, set()).update(rec["files"])
        wanted[repo].update(rec.get("optional", []))
    rows = json.loads((LIB / "llamacpp-model-data.json").read_text())["models"]
    for row in rows:
        repo = row["hf-repo"].split(":")[0]
        keep = wanted.setdefault(repo, set())
        keep.update(shards(repo, row["model"]))
        if row.get("mmproj"):
            keep.add(row["mmproj"])
        if row.get("model-draft"):
            keep.update(shards(repo, row["model-draft"]))
    return wanted


def classify(repo: str, file_name: str, wanted: dict, declared: dict):
    """Why a cached file is not part of the serving set, or None when it is.

    Reasons are the audit's vocabulary and the pruner's log labels:
      repo-out-of-scope   the repo has no lib/cache-scope.json line at all
      repo-audit-only     in the inventory, no entries: facts kept, weights not
      not-gguf            not something llama.cpp can be pointed at
      not-declared        a GGUF the model manifest does not name
    """
    if repo not in wanted:
        return "repo-audit-only" if declared.get(repo) == "audit-only" else "repo-out-of-scope"
    if file_name in wanted[repo]:
        return None
    if file_name.endswith((".gguf", INDEX_SUFFIX)):
        return "not-declared"
    return "not-gguf"


def cached_files(root: Path) -> list:
    """(repo, CachedFileInfo) for every file in the cache, via the hub's scanner.

    scan_cache_dir owns the layout (shared content-addressed store, per-repo
    blob entries, refs). Hand-walking snapshots would re-implement it and get
    refcounts wrong, which is how a cache loses a blob another repo still uses.
    """
    from huggingface_hub import scan_cache_dir

    info = scan_cache_dir(str(root))
    return [
        (repo.repo_id, cached_file)
        for repo in info.repos
        if repo.repo_type == "model"
        for revision in repo.revisions
        for cached_file in revision.files
    ]


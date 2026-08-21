# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
scan_cache_coverage.py  (PoC / MVP)
===============================

Diff the local Hugging Face model cache against
`openai-completions/llamacpp-model-data.json`.

Fills the gap noted in docs/refresh-local-llm-manifest.md (Step 1): the repo has
no tool that diffs "what is cached" vs "what the manifest serves". This is a
minimal viable version -- it walks filenames only (no GGUF headers are read, no
weights loaded) and reports three things:

  A) entire repos with ZERO manifest coverage (all cached quants unserved)
  B) listed repos that have EXTRA cached quants not present in the manifest
  C) ambiguous quant filenames (byteshape bpw suffixes, multi-quant keywords)
     with the llama.cpp cached-list display tag they would produce

Run after a cache pull / download to find what needs adding to the manifest.
The deeper audit of each served entry's `model` vs llama.cpp's implicit
repo:quant -> file heuristic lives in `fetch_hf_manifests.py` (Step 6 of the
runbook).

Usage:
    uv run local-llm/scan_cache_coverage.py
    uv run local-llm/scan_cache_coverage.py --cache /path/to/hub --manifest /path/to/llamacpp-model-data.json
"""
import os, re, sys, json, argparse

SKIP_PREFIXES = ("mmproj", "mtp-", "eagle3-", "dflash-", "dspark-", "imatrix")

def is_model_file(name):
    if not name.endswith(".gguf"):
        return False
    return not any(os.path.basename(name).startswith(p) for p in SKIP_PREFIXES)

RE_SPLIT = re.compile(r"^(.+)-(\d{5})-of-(\d{5})$", re.I)
RE_TAG = re.compile(r"[-.]([A-Z0-9_]+)$", re.I)

def split_info(name):
    base = name[:-5] if name.endswith(".gguf") else name
    idx = count = 1
    m = RE_SPLIT.match(base)
    if m:
        idx = int(m.group(2)); count = int(m.group(3)); base = m.group(1)
    mt = RE_TAG.search(base)
    tag = mt.group(1).upper() if mt else ""
    return tag, idx, count

# Quant keywords used only for the "multiple quant keywords in one filename"
# ambiguity check. The Unsloth `UD-` dynamic-quant prefix is deliberately NOT
# here -- it is a legitimate specifier, not an ambiguity.
QUANT_KW = {"Q4_K_S", "Q4_K_M", "Q4_K_XL", "Q6_K", "Q6_K_XL", "Q8_0", "Q8_K_XL",
            "Q2_K_XL", "Q5_K_M", "Q3_K", "IQ4_XS", "IQ1_S", "Q4_0", "QAD"}

def ambiguity(name):
    if "bpw" in name.lower():
        return "bpw-suffix (llama.cpp shows trailing <n>BPW, not the named quant)"
    stem = name[:-5] if name.endswith(".gguf") else name
    toks = [t for t in re.split(r"[-.]", stem) if t in QUANT_KW]
    if len(set(toks)) >= 2:
        return "multiple quant keywords in filename: " + "/".join(sorted(set(toks)))
    return None

def resolve_cache(arg):
    if arg:
        return arg
    if os.environ.get("HF_HUB_CACHE"):
        return os.environ["HF_HUB_CACHE"]
    home = os.environ.get("HF_HOME") or os.path.join(
        os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "huggingface")
    return os.path.join(home, "hub")

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_manifest = os.path.join(here, "..", "openai-completions", "llamacpp-model-data.json")
    ap = argparse.ArgumentParser(description="Diff HF cache vs llamacpp-model-data.json (PoC)")
    ap.add_argument("--cache", default=None, help="HF cache root (default $HF_HUB_CACHE or ~/.cache/huggingface/hub)")
    ap.add_argument("--manifest", default=default_manifest, help="path to llamacpp-model-data.json")
    a = ap.parse_args()

    with open(a.manifest) as fh:
        manifest = json.load(fh)["models"]
    manifest_files = {os.path.basename(m["model"]) for m in manifest}

    cache = resolve_cache(a.cache)
    cached = {}  # repo -> tag -> rec
    for d in sorted(os.listdir(cache)):
        if not d.startswith("models--"):
            continue
        repo = d[len("models--"):].replace("--", "/", 1)
        snap = os.path.join(cache, d, "snapshots")
        if not os.path.isdir(snap):
            continue
        for root, _, files in os.walk(snap):
            for f in files:
                if not is_model_file(f):
                    continue
                tag, idx, count = split_info(f)
                bn = os.path.basename(f)
                rec = cached.setdefault(repo, {}).setdefault(tag, {"shards": [], "ambig": None, "listed": False})
                rec["shards"].append(bn)
                rec["count"] = count
                if idx == 1:  # shard-1 is the one the manifest references
                    rec["listed"] = bn in manifest_files
                amb = ambiguity(bn)
                if amb and not rec["ambig"]:
                    rec["ambig"] = amb

    print("REPOS IN CACHE:", len(cached))
    unlisted = [r for r in cached if not any(v["listed"] for v in cached[r].values())]
    print("REPOS WITH ZERO MANIFEST COVERAGE:", unlisted)
    print()
    print("=" * 100); print("A) ENTIRE REPOS NOT IN MANIFEST (all cached quants unserved)"); print("=" * 100)
    for repo in unlisted:
        print(f"\n### {repo}")
        for tag in sorted(cached[repo]):
            rec = cached[repo][tag]
            flag = "  [AMBIGUOUS]" if rec["ambig"] else ""
            print(f"   quant={tag:10s} shards={rec.get('count', 1)}  {rec['shards'][0]}{flag}")
            if rec["ambig"]:
                print(f"        -> {rec['ambig']}")

    print(); print("=" * 100); print("B) LISTED REPOS WITH EXTRA CACHED QUANTS NOT IN MANIFEST"); print("=" * 100)
    for repo in sorted(cached):
        if repo in unlisted:
            continue
        extras = [t for t in cached[repo] if not cached[repo][t]["listed"]]
        if not extras:
            continue
        print(f"\n### {repo}")
        print(f"   served quants: {sorted(t for t in cached[repo] if cached[repo][t]['listed'])}")
        for tag in sorted(extras):
            rec = cached[repo][tag]
            flag = "  [AMBIGUOUS]" if rec["ambig"] else ""
            print(f"   EXTRA quant={tag:10s} shards={rec.get('count', 1)}  {rec['shards'][0]}{flag}")
            if rec["ambig"]:
                print(f"        -> {rec['ambig']}")

    print(); print("=" * 100); print("C) AMBIGUOUS QUANT FILENAMES (bpw / multi-quant) with llama.cpp display tag"); print("=" * 100)
    seen = set()
    for repo in sorted(cached):
        for tag in sorted(cached[repo]):
            rec = cached[repo][tag]
            if not rec["ambig"]:
                continue
            key = (repo, rec["shards"][0])
            if key in seen:
                continue
            seen.add(key)
            print(f"   {repo}:{tag}  ({rec['shards'][0]})")
            print(f"        -> {rec['ambig']}")

if __name__ == "__main__":
    main()

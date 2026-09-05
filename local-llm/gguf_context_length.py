# /// script
# requires-python = ">=3.11"
# dependencies = ["gguf"]
# ///
"""
gguf_context_length.py  (PoC / MVP)
===================================

Read `general.architecture`, `general.name` and `<arch>.context_length` from a
GGUF header -- no tensor weights are loaded (GGUFReader is memory-mapped and
only touches metadata). Used by docs/refresh-local-llm-manifest.md (Step 2) to
pick the authoritative `ctx-size` for a new manifest entry.

This is the minimal, policy-compliant replacement for the hand-rolled struct
parser used during the initial manifest build: it relies on the PyPI `gguf`
package (the authoritative quant/header reader) rather than re-implementing the
GGUF format, so it tracks llama.cpp releases.

Usage:
    uv run local-llm/gguf_context_length.py PATH [PATH ...]
    uv run local-llm/gguf_context_length.py --repo unsloth/Qwen3.8-27B-GGUF
"""
import os, sys, glob, argparse
from gguf import GGUFReader

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import pathlib as _pl

sys.path.insert(0, str(_pl.Path(__file__).resolve().parent.parent / "lib"))
import log

log.set_tool("local-llm/gguf-context-length")

def first_cached(repo):
    if os.environ.get("HF_HUB_CACHE"):
        base = os.environ["HF_HUB_CACHE"]
    else:
        home = os.environ.get("HF_HOME") or os.path.join(
            os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "huggingface")
        base = os.path.join(home, "hub")
    pat = os.path.join(base, "models--" + repo.replace("/", "--"), "snapshots", "*", "*.gguf")
    hits = sorted(glob.glob(pat))
    return hits[0] if hits else None

def show(path):
    try:
        r = GGUFReader(path)
        # gguf.GGUFReader exposes metadata as `fields` (OrderedDict of ReaderField);
        # ReaderField.contents() returns the parsed value. Build a flat dict once.
        md = {k: f.contents() for k, f in r.fields.items()}
    except Exception as e:
        print(f"FILE: {path}\n   (skipped: not a readable GGUF header: {e})\n")
        return
    arch = md.get("general.architecture")
    print(f"FILE: {path}")
    print(f"   general.architecture = {arch}")
    print(f"   general.name         = {md.get('general.name')}")
    if arch:
        print(f"   {arch}.context_length = {md.get(arch + '.context_length')}")
    print()

def main():
    ap = argparse.ArgumentParser(description="Read GGUF header context_length (PoC)")
    ap.add_argument("paths", nargs="*", help="GGUF file path(s) / glob(s)")
    ap.add_argument("--repo", help="resolve first cached GGUF for org/repo")
    a = ap.parse_args()

    files = list(a.paths)
    if a.repo:
        p = first_cached(a.repo)
        if not p:
            log.warn("no cached GGUF found", repo=a.repo)
            sys.exit(2)
        files.append(p)

    if not files:
        ap.print_help()
        sys.exit(1)

    for pat in files:
        hits = glob.glob(pat)
        if not hits:
            log.warn("no match for pattern", pattern=pat)
            continue
        show(hits[0])  # first shard carries the header; later shards are data-only

if __name__ == "__main__":
    main()

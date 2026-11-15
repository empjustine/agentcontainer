# /// script
# requires-python = ">=3.11"
# dependencies = ["gguf"]
# ///
"""
gguf_context_length.py  (PoC / MVP)
===================================

Read `general.architecture`, `general.name` and `<arch>.context_length` from a
GGUF header -- no tensor weights are loaded (GGUFReader is memory-mapped and
only touches metadata). Used by llm-local-inference/refresh-llm-local-inference-manifest.md (Step 2) to
pick the authoritative `ctx-size` for a new manifest entry.

This is the minimal, policy-compliant replacement for the hand-rolled struct
parser used during the initial manifest build: it relies on the PyPI `gguf`
package (the authoritative quant/header reader) rather than re-implementing the
GGUF format, so it tracks llama.cpp releases.

Usage:
    ./py-run.sh llm-local-inference/gguf_context_length.py PATH [PATH ...]
    ./py-run.sh llm-local-inference/gguf_context_length.py --repo unsloth/Qwen3.8-27B-GGUF
    ./py-run.sh llm-local-inference/gguf_context_length.py --facts   # rewrite lib/gguf-facts.json
"""
import argparse
import glob
import json
import os

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import pathlib as _pl
import sys

from gguf import GGUFReader

sys.path.insert(0, str(_pl.Path(__file__).resolve().parent / "lib"))
import log

log.set_tool("llm-local-inference/gguf-context-length")
# This script prints its payload (table/list/report) on stdout — logs go to
# stderr so the two never interleave (docs/d045).
log.set_stream(sys.stderr)

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
    except Exception as e:  # noqa: BLE001 — unreadable headers are skipped with a note; that IS the scan
        print(f"FILE: {path}\n   (skipped: not a readable GGUF header: {e})\n")
        return
    arch = md.get("general.architecture")
    print(f"FILE: {path}")
    print(f"   general.architecture = {arch}")
    print(f"   general.name         = {md.get('general.name')}")
    if arch:
        print(f"   {arch}.context_length = {md.get(arch + '.context_length')}")
    print()

# --- lib/gguf-facts.json: the hard facts, from real headers (docs/d197) ------
#
# The committed artifact the generator reads its context ceilings from. Written
# from the GGUF headers of the files this table actually serves, pruned to those
# files, and normalized (sorted keys, ints, no timestamp) so a refresh re-writes
# the same bytes and the diff shows only facts that MOVED.

FACTS = _pl.Path(__file__).resolve().parent / 'lib' / 'gguf-facts.json'
TABLE = _pl.Path(__file__).resolve().parent / 'lib' / 'llamacpp-model-data.json'


def cache_root():
    if os.environ.get('HF_HUB_CACHE'):
        return os.environ['HF_HUB_CACHE']
    home = os.environ.get('HF_HOME') or os.path.join(
        os.environ.get('XDG_CACHE_HOME', os.path.expanduser('~/.cache')), 'huggingface')
    return os.path.join(home, 'hub')


def cached_file(repo, filename):
    """The cached copy of one served file: refs/main first (the revision
    download_models.py pins), then every snapshot dir sorted -- the same order
    generate.mjs bakes paths in, so both sides observe one revision."""
    d = os.path.join(cache_root(), 'models--' + repo.replace('/', '--'))
    cands = []
    ref = os.path.join(d, 'refs', 'main')
    if os.path.exists(ref):
        sha = _pl.Path(ref).read_text().strip()
        if sha:
            cands.append(sha)
    snap = os.path.join(d, 'snapshots')
    if os.path.isdir(snap):
        cands.extend(sorted(os.listdir(snap)))
    for sha in cands:
        p = os.path.join(snap, sha, filename)
        if os.path.exists(p):
            return p
    return None


def header_facts(path):
    r = GGUFReader(path)
    md = {k: f.contents() for k, f in r.fields.items()}
    arch = md.get('general.architecture')
    ctx = md.get(str(arch) + '.context_length') if arch else None
    return {'arch': str(arch), 'ctx-native': int(ctx)} if ctx else None


def build_facts():
    """Pruned, normalized facts keyed by repo; a repo whose served files
    disagree drops to a per-file map. Files missing from the cache are left
    out and reported -- the run is then incomplete, never silently short."""
    entries = json.loads(TABLE.read_text())['models']
    served = {}
    for m in entries:
        served.setdefault(m['hf-repo'].split(':')[0], set()).add(m['model'])
    facts, missing = {}, []
    for repo in sorted(served):
        per_file = {}
        for filename in sorted(served[repo]):
            path = cached_file(repo, filename)
            got = header_facts(path) if path else None
            if got is None:
                missing.append((repo, filename))
                continue
            per_file[filename] = got
        if not per_file:
            continue
        uniform = len({(v['arch'], v['ctx-native']) for v in per_file.values()}) == 1
        facts[repo] = next(iter(per_file.values())) if uniform else {'files': per_file}
    return facts, missing


def write_facts():
    facts, missing = build_facts()
    FACTS.write_text(json.dumps(facts, indent='\t', sort_keys=True) + '\n')
    log.info('gguf facts written', path=str(FACTS), repos=len(facts), missing=len(missing))
    for repo, filename in missing:
        log.warn('served file not cached -- provision with download_models.py', repo=repo, file=filename)
    return 0 if not missing else 1
def main():
    ap = argparse.ArgumentParser(description="Read GGUF header context_length (PoC)")
    ap.add_argument("paths", nargs="*", help="GGUF file path(s) / glob(s)")
    ap.add_argument("--repo", help="resolve first cached GGUF for org/repo")
    ap.add_argument(
        "--facts",
        action="store_true",
        help="rewrite lib/gguf-facts.json from the cached GGUFs this table serves",
    )
    a = ap.parse_args()

    if a.facts:
        sys.exit(write_facts())

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

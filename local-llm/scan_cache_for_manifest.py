# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
scan_cache_for_manifest.py — scan the local Hugging Face model cache and
emit new `llamacpp-model-data.json` entries for every GGUF that is cached but
not yet listed in the manifest.

Walks `snapshots/` symlinks (the same layout the serving container binds),
skips non-model files (mmproj, mtp-, imatrix, etc.), and for each GGUF
produces a JSON object with the fields the generator expects:

    hf-repo   — org/repo:QUANT_TAG
    model     — filename.gguf
    ctx-size  — 65536 (default; read from GGUF header when `--read-ctx` is set)
    parallel  — 1 (default; override with --parallel N)
    __argv    — macro reference derived from model family
    size-gb   — computed from the blob size on disk
    size-parts — { "model": <size-gb> }

Non-GGUF repos (safetensors, Android binaries, .cact, imatrix-only) are
reported but NOT emitted as manifest entries.

Usage:
    uv run local-llm/scan_cache_for_manifest.py
    uv run local-llm/scan_cache_for_manifest.py --output new-entries.json
    uv run local-llm/scan_cache_for_manifest.py --read-ctx   # try to read ctx-size from GGUF headers
    uv run local-llm/scan_cache_for_manifest.py --parallel 2  # override parallelism
"""
import argparse
import json
import os
import re
import struct
import sys
from pathlib import Path

# Structured logging (JSON lines on stderr).
import pathlib as _pl

sys.path.insert(0, str(_pl.Path(__file__).resolve().parent.parent / "lib"))
import log

log.set_tool("local-llm/scan-cache-for-manifest")
log.set_stream(sys.stderr)

HERE = Path(__file__).parent
MODEL_DATA = HERE.parent / "lib" / "llamacpp-model-data.json"
SKIP_PREFIXES = ("mmproj", "mtp-", "eagle3-", "dflash-", "dspark-", "imatrix")

# ── helpers ────────────────────────────────────────────────────────────────

def is_model_file(name: str) -> bool:
    if not name.endswith(".gguf"):
        return False
    return not any(name.startswith(p) for p in SKIP_PREFIXES)


def resolve_cache() -> str:
    if os.environ.get("HF_HUB_CACHE"):
        return os.environ["HF_HUB_CACHE"]
    home = os.environ.get("HF_HOME") or os.path.join(
        os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")),
        "huggingface",
    )
    return os.path.join(home, "hub")


def repo_dir_name(repo: str) -> str:
    """Convert org/repo to models--org--repo."""
    return "models--" + repo.replace("/", "--")


def blob_size(blob_dir: str, sha256: str) -> int:
    """Return the on-disk size of an LFS blob, or 0 if not found."""
    blob_path = os.path.join(blob_dir, sha256)
    if os.path.isfile(blob_path):
        return os.path.getsize(blob_path)
    # Try symlink target resolution
    return 0


def read_ctx_from_gguf(snap_path: str, filename: str) -> int | None:
    """Read the KV-cache context length from a GGUF file header.

    GGUF v3: scan metadata KV pairs for 'general.context_length'.
    Reads sequentially and stops as soon as the key is found to avoid
    loading huge metadata stores into memory.

    Returns None if the file cannot be read or the key is not found.
    """
    fpath = os.path.join(snap_path, filename)
    if not os.path.isfile(fpath):
        return None
    try:
        with open(fpath, "rb") as f:
            magic = f.read(4)
            if magic != b"GGUF":
                return None
            version = struct.unpack("<Q", f.read(8))[0]
            if version < 3:
                return None
            n_tensors = struct.unpack("<Q", f.read(8))[0]
            n_kv = struct.unpack("<Q", f.read(8))[0]

            # Skip tensors (we only care about metadata KV)
            # Tensor format: uint64 name_len, bytes name, uint32 type, uint64 shape (ndim), bytes data
            # We skip them without reading data to save memory
            for _ in range(n_tensors):
                name_len = struct.unpack("<Q", f.read(8))[0]
                f.seek(name_len, 1)  # skip name
                vtype = struct.unpack("<I", f.read(4))[0]
                ndim = struct.unpack("<I", f.read(4))[0]
                # Skip shape
                for _ in range(ndim):
                    f.seek(8, 1)  # uint64 per dimension
                # Skip data — read size based on type
                data_size = _gguf_value_size(vtype, f)
                if data_size > 0:
                    f.seek(data_size, 1)

            # Now read metadata KV pairs
            for _ in range(n_kv):
                key_len = struct.unpack("<Q", f.read(8))[0]
                key = f.read(key_len).decode("utf-8")
                if key == "general.context_length":
                    vtype = struct.unpack("<I", f.read(4))[0]
                    val = _read_gguf_value(f, vtype)
                    if val is not None:
                        return int(val)
                    return None
                else:
                    vtype = struct.unpack("<I", f.read(4))[0]
                    _skip_gguf_value(f, vtype)

            return None
    except (OSError, struct.error, UnicodeDecodeError):
        return None


def _gguf_value_size(vtype: int, f) -> int:
    """Estimate bytes to skip for a GGUF value type."""
    if vtype == 0:  # uint8
        return 1
    elif vtype == 1:  # int8
        return 1
    elif vtype == 2:  # uint16
        return 2
    elif vtype == 3:  # int16
        return 2
    elif vtype == 4:  # uint32
        return 4
    elif vtype == 5:  # int32
        return 4
    elif vtype == 6:  # float32
        return 4
    elif vtype == 7:  # bool
        return 1
    elif vtype == 8:  # string
        len_ = struct.unpack("<Q", f.read(8))[0]
        return len_
    elif vtype == 9:  # array
        arr_len = struct.unpack("<Q", f.read(8))[0]
        elem_type = struct.unpack("<I", f.read(4))[0]
        elem_size = {4: 4, 5: 4, 6: 4}.get(elem_type, 4)
        return arr_len * elem_size
    elif vtype == 10:  # uint64
        return 8
    elif vtype == 11:  # int64
        return 8
    elif vtype == 12:  # float64
        return 8
    return 0


def _read_gguf_value(f, vtype: int):
    """Read a GGUF value, returning its numeric value or None."""
    if vtype in (0, 1, 2, 3, 4, 5, 6, 10, 11, 12):
        return struct.unpack("<f" if vtype == 6 else "<I", f.read(4))[0]
    return None


def _skip_gguf_value(f, vtype: int):
    """Skip a GGUF value without reading it into memory."""
    sz = _gguf_value_size(vtype, f)
    if sz > 0:
        f.seek(sz, 1)


# ── macro family mapping ───────────────────────────────────────────────────

FAMILY_MACRO = {
    "qwen3.8": "qwen38",
    "qwen3.6": "qwen36",
    "qwen3.8-flash-next": "qwen38",
    "qwen3.6-35b-a3b": "qwen36",
    "qwen3.8-27b": "qwen38",
    "qwen3.6-27b": "qwen36",
    "gemma-4": "gemma4",
    "lfm2.5": "lfm25",
    "lfm2.5-vl": "lfm25vl",
    "minicpm5": "minicpm5",
    "laguna": "laguna",
    "ling": "ling",
    "muse-glimmer": "museglimmer",
    "deepseek-v4": "deepseekv4",
    "glm-4.7": "glm47f",
    "devstral": "devstral",
    "north-mini-code": "northmini",
}


def derive_macro(repo: str, filename: str) -> str:
    """Pick a llama-swap macro name from the repo + filename."""
    key = (repo + "/" + filename).lower()
    for prefix, macro in FAMILY_MACRO.items():
        if prefix in key:
            return macro
    # Default: derive from first org segment
    org = repo.split("/")[0].lower()
    fallback = {
        "unsloth": "unsloth",
        "byteshape": "byteshape",
        "bartowski": "bartowski",
        "bloomer010": "bloomer010",
        "liquidai": "liquidai",
        "openbmb": "openbmb",
        "poolside": "poolside",
        "deepseek-ai": "deepseekv4",
        "inclusionai": "inclusionai",
        "cactus-compute": "cactus",
    }
    return fallback.get(org, "default")


def extract_quant_tag(filename: str) -> str:
    """Extract the quantization tag from a GGUF filename.

    Examples:
        Qwen3.8-27B-UD-Q4_K_M.gguf → Q4_K_M
        gemma-4-E2B-it-qat-UD-Q2_K_XL.gguf → UD-Q2_K_XL
        North-Mini-Code-1.0-IQ3_S-3.17bpw.gguf → IQ3_S-3.17bpw
    """
    base = filename[:-5]  # strip .gguf
    # The quant tag is the LAST segment after splitting by - or .
    # But for bpw files like IQ3_S-3.17bpw, the whole suffix is the tag.
    # Strategy: find the first occurrence of a quant-like pattern.
    m = re.search(r"([A-Z0-9_]+(?:-[0-9.]+bpw)?)\.gguf$", filename, re.I)
    if m:
        return m.group(1).upper()
    # Fallback: last segment
    parts = re.split(r"[-.]", base)
    return parts[-1].upper() if parts else "UNKNOWN"


# ── scan ───────────────────────────────────────────────────────────────────

def scan_cache(cache_root: str, read_ctx: bool = False, parallel: int = 1):
    """Walk the HF cache and return (new_entries, non_gguf_repos)."""
    with open(MODEL_DATA) as f:
        manifest = json.load(f)

    manifest_files = {m["model"] for m in manifest["models"]}
    manifest_hf_repos = {m["hf-repo"].split(":")[0] for m in manifest["models"]}

    cached_gguf = []  # list of (repo, filename, tag, snap_path, blob_dir, sha)
    non_gguf_repos = {}  # repo -> description

    for d in sorted(os.listdir(cache_root)):
        if not d.startswith("models--"):
            continue
        repo = d[len("models--"):].replace("--", "/", 1)
        repo_dir = os.path.join(cache_root, d)
        snap_dir = os.path.join(repo_dir, "snapshots")

        if not os.path.isdir(snap_dir):
            continue

        # Check if this repo has ANY gguf files
        has_gguf = False
        for snap in os.listdir(snap_dir):
            snap_path = os.path.join(snap_dir, snap)
            if not os.path.isdir(snap_path):
                continue
            for fname in os.listdir(snap_path):
                if is_model_file(fname):
                    has_gguf = True
                    break
            if has_gguf:
                break

        if not has_gguf:
            # Categorize non-GGUF repos
            snap_sample = os.listdir(snap_dir)[0] if os.listdir(snap_dir) else ""
            snap_path = os.path.join(snap_dir, snap_sample)
            if os.path.isdir(snap_path):
                files = os.listdir(snap_path)
                exts = set()
                for f in files:
                    if f.endswith(".gguf"):
                        exts.add("gguf")
                    elif f.endswith(".safetensors"):
                        exts.add("safetensors")
                    elif f.endswith(".cact"):
                        exts.add("cact")
                    elif "android" in f.lower():
                        exts.add("android")
                    elif "imatrix" in f.lower():
                        exts.add("imatrix")
                    else:
                        exts.add(os.path.splitext(f)[1].lstrip(".") or "other")
            else:
                exts = {"unknown"}
            non_gguf_repos[repo] = sorted(exts)
            continue

        # Process GGUF files
        for snap in os.listdir(snap_dir):
            snap_path = os.path.join(snap_dir, snap)
            if not os.path.isdir(snap_path):
                continue
            for fname in os.listdir(snap_path):
                if not is_model_file(fname):
                    continue
                # Resolve blob info from symlink
                fpath = os.path.join(snap_path, fname)
                sha = None
                blob_dir = os.path.join(repo_dir, "blobs")
                if os.path.islink(fpath):
                    target = os.readlink(fpath)
                    # Target is like ../../blobs/<sha256>
                    sha = os.path.basename(target)
                cached_gguf.append((repo, fname, extract_quant_tag(fname), snap_path, blob_dir, sha))

    # Filter: only entries NOT already in manifest
    new_entries = []
    for repo, fname, tag, snap_path, blob_dir, sha in cached_gguf:
        if fname in manifest_files:
            continue
        if repo in manifest_hf_repos:
            # Repo is listed but this specific quant might not be
            pass

        # Compute size
        size_bytes = 0
        if sha and blob_dir:
            blob_path = os.path.join(blob_dir, sha)
            if os.path.isfile(blob_path):
                size_bytes = os.path.getsize(blob_path)
            elif os.path.islink(blob_path):
                # Follow the chain
                try:
                    size_bytes = os.path.getsize(blob_path)
                except OSError:
                    pass

        size_gb = round(size_bytes / (1024 ** 3), 3) if size_bytes > 0 else 0

        # Read ctx-size if requested
        ctx_size = None
        if read_ctx:
            ctx_size = read_ctx_from_gguf(snap_path, fname)

        macro = derive_macro(repo, fname)
        hf_repo_tag = f"{repo}:{tag}"

        entry = {
            "hf-repo": hf_repo_tag,
            "model": fname,
            "parallel": parallel,
            "__argv": f"${{{macro}}}",
            "size-gb": size_gb,
            "size-parts": {"model": size_gb},
        }
        if ctx_size:
            entry["ctx-size"] = ctx_size
        else:
            entry["ctx-size"] = 65536  # default

        new_entries.append(entry)

    return new_entries, non_gguf_repos


# ── main ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description="Scan HF cache for GGUFs not in llamacpp-model-data.json"
    )
    ap.add_argument(
        "--cache",
        default=None,
        help="HF cache root (default $HF_HUB_CACHE or ~/.cache/huggingface/hub)",
    )
    ap.add_argument(
        "--output",
        default=None,
        help="Write new entries to this file (default: print to stdout)",
    )
    ap.add_argument(
        "--read-ctx",
        action="store_true",
        help="Read ctx-size from GGUF headers (requires file access)",
    )
    ap.add_argument(
        "--parallel",
        type=int,
        default=1,
        choices=[1, 2],
        help="Parallelism for new entries (default: 1)",
    )
    ap.add_argument(
        "--json-only",
        action="store_true",
        help="Only output JSON, skip human-readable report",
    )
    a = ap.parse_args()

    cache = a.cache or resolve_cache()
    log.info("scanning cache", cache=cache)

    new_entries, non_gguf_repos = scan_cache(cache, a.read_ctx, a.parallel)

    if not a.json_only:
        # Human-readable report
        print(f"\n{'=' * 80}", file=sys.stderr)
        print("SCAN REPORT: HF Cache → llamacpp-model-data.json", file=sys.stderr)
        print(f"{'=' * 80}", file=sys.stderr)

        print(f"\nGGUF repos with NEW entries: {len(set(e['hf-repo'].split(':')[0] for e in new_entries))}", file=sys.stderr)
        print(f"Total new GGUF entries: {len(new_entries)}", file=sys.stderr)
        print(f"Non-GGUF repos (skipped): {len(non_gguf_repos)}", file=sys.stderr)

        if non_gguf_repos:
            print(f"\n{'─' * 60}", file=sys.stderr)
            print("NON-GGUF REPOS (cannot be added to llamacpp manifest):", file=sys.stderr)
            print(f"{'─' * 60}", file=sys.stderr)
            for repo, exts in sorted(non_gguf_repos.items()):
                print(f"  {repo}  →  {', '.join(exts)}", file=sys.stderr)

        if new_entries:
            print(f"\n{'─' * 60}", file=sys.stderr)
            print("NEW GGUF ENTRIES (by repo):", file=sys.stderr)
            print(f"{'─' * 60}", file=sys.stderr)
            by_repo = {}
            for e in new_entries:
                repo = e["hf-repo"].split(":")[0]
                by_repo.setdefault(repo, []).append(e)
            for repo in sorted(by_repo):
                print(f"\n  ### {repo}", file=sys.stderr)
                for e in by_repo[repo]:
                    size_str = f"{e['size-gb']:.3f} GB" if e["size-gb"] > 0 else "?"
                    ctx_str = str(e.get("ctx-size", 65536))
                    print(f"    {e['model']:60s}  {size_str:>10s}  ctx={ctx_str}  macro={e['__argv']}", file=sys.stderr)

    # Output JSON
    output = json.dumps(new_entries, indent=2) + "\n"
    if a.output:
        Path(a.output).write_text(output)
        log.info("wrote new entries", path=a.output, count=len(new_entries))
    else:
        print(output)


if __name__ == "__main__":
    main()

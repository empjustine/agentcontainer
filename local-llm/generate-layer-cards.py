#!/usr/bin/env python3
"""generate-layer-cards.py — extract every tensor (layer) name from GGUF model
files and render them as markdown "layer cards", mirroring the model-card layout
in local-llm/model-cards/<org>/<repo>.md but for layer names instead.

Reads only the GGUF *header* (tensor-info section) — no weights are loaded —
with a dependency-free pure-Python GGUF reader. Full explanation (audit
semantics, usage, design): see ./docs/gguf-model-tooling.md.

Usage:
    python3 generate-layer-cards.py                 # all repos in llamacpp-model-data.json with local files
    python3 generate-layer-cards.py --repo unsloth/Qwen3.8-27B-GGUF
    python3 generate-layer-cards.py --json /path/to/llamacpp-model-data.json
    python3 generate-layer-cards.py --gguf path/to/model.gguf --stdout
    python3 generate-layer-cards.py --outdir /tmp/cards

Exit code 0 if at least one card was written, 1 otherwise.
"""

import argparse
import json
import os
import re
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

GGUF_MAGIC = b"GGUF"

# ggml type id -> bytes per element. Values from ggml.h (block sizes):
#   Q4_0 32/18, Q4_1 32/20, Q5_0 32/22, Q5_1 32/24, Q8_0 32/34, Q8_1 32/36,
#   Q2_K 256/84, Q3_K 256/110, Q4_K 256/144, Q5_K 256/176, Q6_K 256/210,
#   Q8_K 256/292, IQ2_XXS 256/68, IQ2_XS 256/84, IQ3_XXS 256/110, IQ1_S 256/50,
#   IQ4_NL 32/18, IQ3_S 256/134, IQ2_S 256/118, IQ4_XS 256/90, IQ1_M 256/58,
#   TQ1_0 256/34, TQ2_0 256/66.
GGML_TYPE_SIZES = {
    0: 4.0,      # F32
    1: 2.0,      # F16
    2: 0.5625,   # Q4_0
    3: 0.625,    # Q4_1
    6: 0.6875,   # Q5_0
    7: 0.75,     # Q5_1
    8: 1.0625,   # Q8_0
    9: 1.125,    # Q8_1
    10: 0.328125,   # Q2_K
    11: 0.4296875,  # Q3_K
    12: 0.5625,     # Q4_K
    13: 0.6875,     # Q5_K
    14: 0.8203125,  # Q6_K
    15: 1.140625,   # Q8_K
    16: 0.265625,   # IQ2_XXS
    17: 0.328125,   # IQ2_XS
    18: 0.4296875,  # IQ3_XXS
    19: 0.1953125,  # IQ1_S
    20: 0.5625,     # IQ4_NL
    21: 0.5234375,  # IQ3_S
    22: 0.4609375,  # IQ2_S
    23: 0.3515625,  # IQ4_XS
    24: 0.2265625,  # IQ1_M
    25: 2.0,        # BF16
    26: 0.1328125,  # TQ1_0
    27: 0.2578125,  # TQ2_0
}

BLK_RE = re.compile(r"^blk\.(\d+)\.(.*)$")


# ---------------------------------------------------------------------------
# Minimal pure-Python GGUF header reader (reads metadata + tensor infos only;
# never touches tensor data). Little-endian, per the GGUF spec.
# ---------------------------------------------------------------------------

def _u32(f):
    return struct.unpack("<I", f.read(4))[0]


def _u64(f):
    return struct.unpack("<Q", f.read(8))[0]


def _string(f):
    n = _u64(f)
    return f.read(n).decode("utf-8", "replace")


def _value(f, t):
    if t == 0:   return struct.unpack("<B", f.read(1))[0]
    if t == 1:   return struct.unpack("<b", f.read(1))[0]
    if t == 2:   return struct.unpack("<H", f.read(2))[0]
    if t == 3:   return struct.unpack("<h", f.read(2))[0]
    if t == 4:   return struct.unpack("<I", f.read(4))[0]
    if t == 5:   return struct.unpack("<i", f.read(4))[0]
    if t == 6:   return struct.unpack("<f", f.read(4))[0]
    if t == 7:   return struct.unpack("<?", f.read(1))[0]
    if t == 8:   return _string(f)
    if t == 9:   # array
        at, n = _u32(f), _u64(f)
        return [_value(f, at) for _ in range(n)]
    if t == 10:  return _u64(f)
    if t == 11:  return struct.unpack("<q", f.read(8))[0]
    if t == 12:  return struct.unpack("<d", f.read(8))[0]
    raise ValueError(f"unknown GGUF value type {t}")


def read_gguf_header(path):
    """Return (metadata dict, list of tensor dicts). Header-only; cheap."""
    tensors = []
    with open(path, "rb") as f:
        if f.read(4) != GGUF_MAGIC:
            raise ValueError(f"{path}: not a GGUF file (bad magic)")
        _u32(f)  # version (not used)
        tensor_count = _u64(f)
        kv_count = _u64(f)
        meta = {}
        for _ in range(kv_count):
            key = _string(f)
            meta[key] = _value(f, _u32(f))
        # NOTE: tensor infos follow the metadata IMMEDIATELY (no padding); the
        # alignment padding only precedes the tensor *data* section, which we
        # never read. See ggml/src/gguf.cpp ("read the tensor info") and
        # gguf-py/gguf/gguf_reader.py.
        for _ in range(tensor_count):
            name = _string(f)
            n_dim = _u32(f)
            dims = [_u64(f) for _ in range(n_dim)]
            ttype = _u32(f)
            offset = _u64(f)
            tensors.append({"name": name, "dims": dims, "type": ttype, "offset": offset})
    return meta, tensors


def tensor_bytes(t):
    per = GGML_TYPE_SIZES.get(t["type"])
    if per is None:
        return None
    n = 1
    for d in t["dims"]:
        n *= d
    return n * per


def mi(fmt, nbytes):
    """Format bytes as MiB (or '-' when unknown)."""
    if nbytes is None:
        return "-"
    return fmt % (nbytes / (1024 * 1024))


# ---------------------------------------------------------------------------
# HF cache resolution
# ---------------------------------------------------------------------------

def hf_cache_dir():
    return Path(os.environ.get("HF_HUB_CACHE", Path.home() / ".cache" / "huggingface" / "hub"))


def resolve_local_file(repo, fname):
    repo_dir = hf_cache_dir() / f"models--{repo.replace('/', '--')}"
    for snap in sorted(repo_dir.glob("snapshots/*")):
        p = snap / fname
        if p.is_file():
            return p
    return None


# ---------------------------------------------------------------------------
# --override-tensor audit (mirrors llama.cpp: std::regex_search on the full
# tensor name, first matching pattern wins; see src/llama-model-loader.cpp)
# ---------------------------------------------------------------------------

OVERRIDE_ARG_RE = re.compile(r"--override-tensor\s+('[^']*'|\"[^\"]*\"|[^\s]+)")


def parse_override_specs(extra_args):
    specs = []
    for m in OVERRIDE_ARG_RE.finditer(extra_args):
        spec = m.group(1)
        if len(spec) >= 2 and spec[0] == spec[-1] and spec[0] in "'\"":
            spec = spec[1:-1]
        pattern, _, device = spec.rpartition("=")
        specs.append({"pattern": pattern, "device": device})
    return specs


def audit_overrides(specs, tensors):
    """Return dict with matched/unmatched/accidental + byte totals."""
    if not specs:
        return None
    matched, unmatched = [], []
    for t in tensors:
        if any(re.search(s["pattern"], t["name"]) for s in specs):
            matched.append(t)
        elif "ffn" in t["name"]:
            unmatched.append(t)          # ffn_* tensors the pattern did NOT catch
    accidental = [t for t in matched if "ffn" not in t["name"]]
    matched_by_layer = {}
    for t in matched:
        m = BLK_RE.match(t["name"])
        key = int(m.group(1)) if m else "non-block"
        matched_by_layer.setdefault(key, []).append(t["name"])
    return {
        "specs": specs,
        "matched": matched,
        "unmatched_ffn": unmatched,
        "accidental": accidental,
        "matched_by_layer": matched_by_layer,
    }


# ---------------------------------------------------------------------------
# Block classification
# ---------------------------------------------------------------------------

def classify_blocks(tensors):
    """Group tensors into layers by blk.N, classify each block's flavor."""
    blocks = {}            # layer index -> list of suffix names
    non_block = []
    for t in tensors:
        m = BLK_RE.match(t["name"])
        if m:
            blocks.setdefault(int(m.group(1)), []).append(m.group(2))
        else:
            non_block.append(t["name"])

    def flavor(names):
        if "attn_q.weight" in names or "attn_output.weight" in names:
            return "attention"
        if any(n.startswith("ssm") for n in names):
            return "ssm"
        return "other"

    flavors = {}
    for i in blocks:
        flavors[i] = flavor(blocks[i])
    return blocks, non_block, flavors


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------

def shape_str(t):
    return "[" + " x ".join(str(d) for d in t["dims"]) + "]"


def render_markdown(repo, entry_list, quants, meta, tensors):
    """entry_list: all llamacpp-model-data.json entries for this repo that have
    local files. quants: {quant_id: TensorList}. meta: from the first quant."""
    quant_ids = list(quants)
    blocks, non_block, flavors = classify_blocks(tensors)
    layer_indices = sorted(blocks)
    by_flavor = {}
    for i in layer_indices:
        by_flavor.setdefault(flavors[i], []).append(i)

    arch = meta.get("general.architecture", "?")
    block_count = meta.get(f"{arch}.block_count", len(layer_indices))
    ctx = meta.get(f"{arch}.context_length", "?")
    n_embd = meta.get(f"{arch}.embedding_length", "?")

    L = []
    add = L.append
    add("---")
    add(f"model: {repo}")
    add(f"quants: {', '.join(e['quant'] for e in entry_list)}")
    for e in entry_list:
        add(f"file_{e['quant']}: {e.get('file', '')}")
    add(f"tensor_count: {len(tensors)}")
    add(f"generator: local-llm/generate-layer-cards.py")
    add(f"generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    add("---")
    add("")
    add(f"# Layer names — {repo}")
    add("")
    add("Every tensor (layer) name read from the GGUF **tensor-info header** — no "
        "weights are loaded into memory. Layer names are architecture-level and "
        "identical across quants; per-tensor sizes are listed per quant.")
    add("")
    add("## Summary")
    add("")
    add("| field | value |")
    add("|---|---|")
    add(f"| architecture | `{arch}` |")
    add(f"| block count | {block_count} (`blk.0` … `blk.{layer_indices[-1]}`) |")
    add(f"| context length | {ctx} |")
    add(f"| embedding length | {n_embd} |")
    add(f"| total tensors | {len(tensors)} |")
    add(f"| non-layer tensors | {len(non_block)} |")
    for fl in sorted(by_flavor):
        idx = by_flavor[fl]
        add(f"| {fl} blocks | {len(idx)} — {', '.join(str(i) for i in idx)} |")
    add(f"| quants analyzed | {', '.join(quant_ids)} |")
    add("")

    # ---- non-layer tensors ----
    add("## Non-layer tensors")
    add("")
    add("| tensor | shape | " + " | ".join(f"MiB ({q})" for q in quant_ids) + " |")
    add("|---|---|" + "---|" * len(quant_ids))
    for name in sorted(non_block):
        t = next(t for t in tensors if t["name"] == name)
        size_cells = []
        for q in quant_ids:
            qt = next(t for t in quants[q] if t["name"] == name)
            size_cells.append(mi("%.1f", tensor_bytes(qt)))
        add(f"| `{name}` | {shape_str(t)} | " + " | ".join(size_cells) + " |")
    add("")

    # ---- per-flavor canonical sets ----
    add("## Block layout")
    add("")
    for fl in sorted(by_flavor):
        idx = by_flavor[fl]
        common = set(blocks[idx[0]])
        for i in idx[1:]:
            common &= set(blocks[i])
        extra = {}
        for i in idx:
            d = set(blocks[i]) - common
            if d:
                extra[i] = sorted(d)
        add(f"### {fl} blocks — {len(idx)} ({', '.join(str(i) for i in idx)})")
        add("")
        add("| tensor | shape | " + " | ".join(f"MiB ({q})" for q in quant_ids) + " |")
        add("|---|---|" + "---|" * len(quant_ids))
        for name in sorted(common):
            t = next(t for t in tensors if t["name"] == f"blk.{idx[0]}.{name}")
            size_cells = []
            for q in quant_ids:
                qt = next(t for t in quants[q] if t["name"] == f"blk.{idx[0]}.{name}")
                size_cells.append(mi("%.1f", tensor_bytes(qt)))
            add(f"| `{name}` | {shape_str(t)} | " + " | ".join(size_cells) + " |")
        add("")
        if extra:
            add("Blocks with additional tensors on top of the canonical set:")
            add("")
            for i in sorted(extra):
                add(f"- `blk.{i}`: " + ", ".join(f"`{n}`" for n in extra[i]))
            add("")
    add("")

    # ---- full listing ----
    add("## All tensors by block")
    add("")
    for name in sorted(non_block):
        add(f"- `{name}`")
    for i in layer_indices:
        add("")
        add(f"### blk.{i} ({flavors[i]})")
        add("")
        add("```text")
        for n in sorted(blocks[i]):
            add(f"blk.{i}.{n}")
        add("```")
        add("")
    add("")

    # ---- override-tensor audit ----
    for e in entry_list:
        extra = e.get("extraArgs")
        if not extra:
            continue
        specs = parse_override_specs(extra)
        aud = audit_overrides(specs, tensors)
        add("## `--override-tensor` audit")
        add("")
        add("From `llamacpp-model-data.json`:")
        add("")
        add("```json")
        add(json.dumps(extra))
        add("```")
        add("")
        for s in specs:
            add(f"- pattern: `{s['pattern']}` → device `{s['device']}`")
        add("- matching semantics: `std::regex_search` on the full tensor name "
            "(substring match), first hit wins — `src/llama-model-loader.cpp`")
        add(f"- matched tensors: **{len(aud['matched'])}**")
        add(f"- layers matched: {', '.join(str(i) for i in sorted(aud['matched_by_layer']))}")
        for q in quant_ids:
            tot = sum(tensor_bytes(t) for t in quants[q] if t["name"] in {m["name"] for m in aud["matched"]})
            add(f"- bytes moved to {aud['specs'][0]['device']} ({q}): {tot/(1024**3):.2f} GiB")
        add(f"- `ffn_*` tensors NOT matched (stay on GPU): {len(aud['unmatched_ffn'])}"
            + (f" — layers {min((BLK_RE.match(t['name']).group(1) for t in aud['unmatched_ffn']), key=int)}…{max((BLK_RE.match(t['name']).group(1) for t in aud['unmatched_ffn']), key=int)}" if aud["unmatched_ffn"] else ""))
        if aud["accidental"]:
            add(f"- ⚠️ accidental matches (non-`ffn_*` names): {[t['name'] for t in aud['accidental']]}")
        else:
            add("- accidental matches (non-`ffn_*` names): none")
        add("")
        break  # audit section rendered once (patterns identical across quants)

    return "\n".join(L) + "\n"


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", default="../openai-completions/llamacpp-model-data.json",
                    help="path to llamacpp-model-data.json (default: ../openai-completions/llamacpp-model-data.json)")
    ap.add_argument("--repo", action="append", default=[],
                    help="only process this repo id (repeatable)")
    ap.add_argument("--gguf", action="append", default=[],
                    help="explicit GGUF file(s) to process instead of the json")
    ap.add_argument("--outdir", default="model-cards",
                    help="output directory (default: ./model-cards)")
    ap.add_argument("--stdout", action="store_true",
                    help="print markdown to stdout instead of writing files")
    ap.add_argument("--quiet", action="store_true", help="suppress per-file progress")
    args = ap.parse_args()

    outdir = Path(args.outdir)
    written = skipped = 0

    # group entries by repo, only ones with a local file
    if args.gguf:
        groups = {}
        for p in args.gguf:
            name = Path(p).name
            quant = re.sub(r"\.gguf$", "", name)
            repo = args.repo[0] if args.repo else "local"
            g = groups.setdefault(repo, {"entries": [], "files": []})
            g["entries"].append({"quant": quant, "file": name})
            g["files"].append((quant, Path(p)))
        work = groups.items()
    else:
        data = json.load(open(args.json))
        entries = data["models"]
        if args.repo:
            entries = [m for m in entries if m["repo"] in args.repo]
        groups = {}
        for m in entries:
            g = groups.setdefault(m["repo"], {"entries": [], "files": []})
            p = resolve_local_file(m["repo"], m["file"])
            if p is None:
                continue
            g["entries"].append(m)
            g["files"].append((m["quant"], p))
        work = groups.items()

    if not work:
        print("no local GGUF files found for the requested models", file=sys.stderr)
        return 1

    for repo, g in work:
        if not g["files"]:
            skipped += 1
            continue
        quants = {}
        meta = None
        for quant, path in g["files"]:
            m, tensors = read_gguf_header(path)
            if meta is None:
                meta = m
            quants[quant] = tensors
        all_tensors = next(iter(quants.values()))   # names identical across quants
        md = render_markdown(repo, g["entries"], quants, meta, all_tensors)

        if args.stdout:
            sys.stdout.write(md)
            written += 1
            continue
        org, reponame = repo.split("/")
        out = outdir / org / f"{reponame}.layers.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(md)
        written += 1
        if not args.quiet:
            sizes = ", ".join(f"{q} {sum(tensor_bytes(t) or 0 for t in ts)/(1024**3):.1f}GiB"
                              for q, ts in quants.items())
            print(f"  ok  {out}  ({len(all_tensors)} tensors; {sizes})")

    print(f"done — {written} layer card(s) written, {skipped} skipped")
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())

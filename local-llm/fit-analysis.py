#!/usr/bin/env python3
"""fit-analysis.py — how many layers must be evicted to CPU so that
weights + KV cache + activation/batch workspace + runtime overhead fit inside a
GPU budget (default 15 GiB), for the *dense* models in
../openai-completions/llamacpp-model-data.json.

Method and tier/KV-byte reference: see ./docs/gguf-model-tooling.md.

Usage:
    python3 fit-analysis.py [--tier default|luxurious|both] [--gpu 15] [--ctxs ..] [--kv-types ..]
                            [--batch 2048] [--overhead 0.5]
"""
import argparse
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
GIB = 2 ** 30

# bytes per element for supported KV cache types (ggml block sizes)
KV_TYPE_BYTES = {
    "f16": 2.0,
    "q8_0": 34 / 32,
    "q5_1": 24 / 32,
    "q4_0": 18 / 32,
}

TIERS = {
    "default":   {"ctxs": [32768],       "kv": ["q5_1", "q4_0"]},
    "luxurious": {"ctxs": [65536],       "kv": ["q8_0", "q5_1"]},
    "both":      {"ctxs": [32768, 65536], "kv": ["q5_1", "q4_0", "q8_0"]},
}


def load_glc():
    spec = importlib.util.spec_from_file_location("glc", HERE / "generate-layer-cards.py")
    glc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(glc)
    return glc


def analyze(glc, path, gpu_gib, ctx, batch, kv_bytes, overhead_gib):
    meta, tensors = glc.read_gguf_header(path)
    arch = meta.get("general.architecture", "?")

    blocks = {}            # layer -> {suffix: bytes}
    fixed = []             # (name, bytes) for non blk.N tensors
    n_embd = meta.get(f"{arch}.embedding_length", 0)
    vocab = kv_dim = n_attn = n_ff = 0
    unknown = False
    for t in tensors:
        nb = glc.tensor_bytes(t)
        if nb is None:
            nb = 0
            unknown = True
        name = t["name"]
        if name == "token_embd.weight":
            vocab = t["dims"][1]
        m = glc.BLK_RE.match(name)
        if m:
            blocks.setdefault(int(m.group(1)), {})[m.group(2)] = nb
            if ".attn_k.weight" in name:
                kv_dim = max(kv_dim, t["dims"][1])
                n_attn += 1
            if name.endswith("ffn_up.weight"):
                n_ff = max(n_ff, t["dims"][1])
        else:
            fixed.append((name, nb))
    if unknown:
        print(f"WARNING: {path.name}: some tensors have unmappable ggml quant types; "
              f"sizes undercounted (extend GGML_TYPE_SIZES in generate-layer-cards.py)",
              file=sys.stderr)

    total = sum(b for _, b in fixed) + sum(sum(v.values()) for v in blocks.values())
    fixed_bytes = sum(b for _, b in fixed)
    block_bytes = total - fixed_bytes
    per_block = {i: sum(v.values()) for i, v in blocks.items()}
    per_block_ffn = {i: sum(b for s, b in v.items() if s.startswith("ffn")) for i, v in blocks.items()}

    kv = n_attn * 2 * kv_dim * kv_bytes * ctx
    act = (4 * n_ff + 10 * n_embd) * batch * 2          # single-layer peak workspace
    logits = vocab * batch * 4                          # llama.cpp computes logits in fp32 (vocab x n_batch)
    overhead = overhead_gib * GIB

    def solve(mode):
        # how much weight must leave the GPU
        needed = block_bytes - (gpu_gib * GIB - fixed_bytes - kv - act - logits - overhead)
        if needed <= 0:
            return 0, 0.0
        if needed > block_bytes:
            return None, None        # impossible: non-weight costs alone exceed the budget
        order = sorted(per_block.items(), key=lambda kv_: -kv_[1]) if mode == "whole" \
            else sorted(per_block_ffn.items(), key=lambda kv_: -kv_[1])
        freed = count = 0
        for i, b in order:
            if freed >= needed:
                break
            freed += b
            count += 1
        return count, freed / GIB

    return {
        "arch": arch, "n_blocks": len(blocks), "n_attn": n_attn, "kv_dim": kv_dim,
        "n_embd": n_embd, "n_ff": n_ff, "vocab": vocab,
        "total_gib": total / GIB, "fixed_gib": fixed_bytes / GIB, "blocks_gib": block_bytes / GIB,
        "avg_block_gib": block_bytes / len(blocks) / GIB if blocks else 0,
        "kv_gib": kv / GIB, "act_gib": act / GIB, "logits_gib": logits / GIB,
        "whole": solve("whole"), "ffn": solve("ffn"),
        "free_for_blocks_gib": (gpu_gib * GIB - fixed_bytes - kv - act - logits - overhead) / GIB,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tier", choices=list(TIERS), default="default",
                    help="KV quant + ctx profile (default: q5_1/q4_0 @32k; luxurious: q8_0/q5_1 @64k)")
    ap.add_argument("--gpu", type=float, default=15.0, help="GPU budget in GiB (default 15)")
    ap.add_argument("--ctxs", default=None, help="override context lengths (comma-separated)")
    ap.add_argument("--kv-types", default=None, help="override KV types: " + ",".join(KV_TYPE_BYTES))
    ap.add_argument("--batch", type=int, default=2048, help="llama.cpp n_batch (activation workspace)")
    ap.add_argument("--overhead", type=float, default=0.5, help="GiB runtime overhead (CUDA ctx, graph, cuBLAS)")
    args = ap.parse_args()

    glc = load_glc()
    data = json.load(open(HERE.parent / "openai-completions" / "llamacpp-model-data.json"))
    tier = TIERS[args.tier]
    ctxs = [int(c) for c in args.ctxs.split(",")] if args.ctxs else tier["ctxs"]
    kvs = args.kv_types.split(",") if args.kv_types else tier["kv"]
    kv_bytes = {kv: KV_TYPE_BYTES[kv] for kv in kvs}

    rows = []
    seen = set()
    for m in data["models"]:
        path = glc.resolve_local_file(m["repo"], m["file"])
        if path is None:
            continue
        meta, tensors = glc.read_gguf_header(path)
        if "moe" in meta.get("general.architecture", "") or any("_exps" in t["name"] for t in tensors):
            continue                      # skip MoE models
        key = (m["repo"], m["quant"], str(path))
        if key in seen:
            continue
        seen.add(key)
        for c in ctxs:
            for kv in kvs:
                r = analyze(glc, path, args.gpu, c, args.batch, kv_bytes[kv], args.overhead)
                rows.append((m["repo"].split("/")[-1], m["quant"], c, kv, r))

    rows.sort(key=lambda r: (r[0], r[1], r[2], kvs.index(r[3])))

    print(f"GPU budget: {args.gpu:.0f} GiB | tier: {args.tier} | ctx: {', '.join(map(str, ctxs))} "
          f"| KV: {', '.join(f'{kv}({KV_TYPE_BYTES[kv]:.3f}B)' for kv in kvs)} | n_batch: {args.batch} "
          f"| overhead: {args.overhead:.1f} GiB")
    print(f"{'model':26s} {'quant':11s} {'ctx':>6s} {'kv':>5s} {'kvGiB':>6s} {'tot':>6s} {'fixed':>6s} "
          f"{'act':>5s} {'whole#':>6s} {'wholeGiB':>8s} {'ffn#':>5s} {'ffnGiB':>7s}")
    print("-" * 106)
    for model, quant, ctx, kv, r in rows:
        w, wg = r["whole"]
        f, fg = r["ffn"]
        wc = f"{w:>6d}" if w is not None else f"{'n/a':>6s}"
        wg_s = f"{wg:>8.2f}" if wg is not None else f"{'---':>8s}"
        fc = f"{f:>5d}" if f is not None else f"{'n/a':>5s}"
        fg_s = f"{fg:>7.2f}" if fg is not None else f"{'---':>7s}"
        print(f"{model:26s} {quant:11s} {ctx:>6d} {kv:>5s} {r['kv_gib']:>6.2f} {r['total_gib']:>6.1f} "
              f"{r['fixed_gib']:>6.2f} {r['act_gib']:>5.2f} {wc} {wg_s} {fc} {fg_s}")


if __name__ == "__main__":
    main()

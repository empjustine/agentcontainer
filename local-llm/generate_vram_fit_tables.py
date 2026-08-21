#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""generate_vram_fit_tables.py — VRAM/KV/fit/performance tables for every served
model via gdevenyi/huggingface-estimate.

Replaces the archived size-estimation scripts (OLD/gguf-size-estimation/, see
docs/gguf-model-tooling.md). Runs the external estimator's CLI
(run-calc.js, Node) once per (model file, ctx) pair over the canonical model
list in ../openai-completions/llamacpp-model-data.json, then renders:

  - docs/gguf-vram-fit-estimates.md        human-readable tables
  - docs/gguf-vram-fit-estimates.data.json raw per-run estimator output

Model files are read from a local HTTP mirror of the HuggingFace hub cache
(--hub-url, default http://localhost:9090 serving ~/.cache/huggingface/hub),
so GGUF metadata is fetched over LAN/localhost instead of from huggingface.co.
Falls back to the hub repo slug when a model is not in the local cache.
Requires the mirror to support Range requests (python3 -m http.server does NOT;
e.g. `npx http-server` or caddy do).

Performance is analysed for --gpu (default amd-radeon-rx-6900-xt); tables are
ordered by token generation speed at the largest ctx (descending), with
preprocessing (prefill) speed as tiebreaker. --update-model-data applies the
same order to llamacpp-model-data.json itself.

A small idempotent patch is applied to the estimator checkout so that
buildResolveUrl() works against non-HF http mirrors (needed for --mmproj).

Usage:
    uv run generate_vram_fit_tables.py
    uv run generate_vram_fit_tables.py --estimator-dir /path/to/huggingface-estimate
    uv run generate_vram_fit_tables.py --update-model-data

Exit code 1 if any estimator run failed.
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
MODEL_DATA = HERE.parent / "openai-completions" / "llamacpp-model-data.json"
DEFAULT_ESTIMATOR = os.environ.get("HUGGINGFACE_ESTIMATE_DIR") or "~/Downloads/references/github/gdevenyi/huggingface-estimate"
OUT_MD = HERE.parent / "docs" / "gguf-vram-fit-estimates.md"
OUT_JSON = HERE.parent / "docs" / "gguf-vram-fit-estimates.data.json"

CTXS = [32768, 65536, 131072]
GIB = 2 ** 30

BUILD_RESOLVE_URL_PATCH = """export function buildResolveUrl(path, filename) {
  const modelPath = extractHfSlug(path) ?? path;
  // Non-HF http(s) base (e.g. a local mirror serving a HF hub dir): treat the
  // path as a full file URL and swap in the requested filename.
  if (/^https?:\\/\\//i.test(modelPath) && !/huggingface\\.co/i.test(modelPath)) {
    return modelPath.replace(/[^/]*(?:[?#].*)?$/, filename);
  }
  return `https://huggingface.co/${modelPath}/resolve/main/${filename}`;
}"""


def hf_cache_dir():
    home = os.environ.get("HF_HOME") or os.path.join(
        os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "huggingface")
    return Path(os.environ.get("HF_HUB_CACHE") or os.path.join(home, "hub"))


def local_snapshot_url(repo, fname, args):
    """URL of fname on the local hub mirror, or None when not cached."""
    org, name = repo.split("/")
    pattern = hf_cache_dir() / f"models--{org}--{name}" / "snapshots" / "*" / fname
    hits = sorted(glob.glob(str(pattern)))
    if not hits:
        return None
    rel = Path(hits[0]).relative_to(hf_cache_dir()).as_posix()
    return f"{args.hub_url.rstrip('/')}/{rel}"


def local_mmproj(repo, mmproj_name):
    org, name = repo.split("/")
    pattern = hf_cache_dir() / f"models--{org}--{name}" / "snapshots" / "*" / "*.gguf"
    hits = [p for p in glob.glob(str(pattern))
            if Path(p).name.startswith("mmproj")]
    if mmproj_name:
        named = [p for p in hits if Path(p).name == mmproj_name]
        return Path(named[0]).name if named else None
    return Path(sorted(hits)[0]).name if hits else None


def ensure_estimator(estimator_dir):
    """Return an estimator dir ready to run: node_modules installed (copying to
    a writable scratch dir first when the checkout is read-only) and the
    buildResolveUrl mirror patch applied."""
    dep = estimator_dir / "node_modules" / "@huggingface" / "gguf"
    if not dep.exists():
        try:
            readonly = (estimator_dir / ".git").exists() and \
                not os.access(estimator_dir, os.W_OK)
        except OSError:
            readonly = False
        work = estimator_dir
        if readonly:
            work = Path(tempfile.gettempdir()) / "huggingface-estimate"
            if not (work / "run-calc.js").exists():
                print(f"estimator checkout is read-only; copying to {work}")
                shutil.copytree(estimator_dir, work,
                                ignore=shutil.ignore_patterns(".git", "node_modules"))
        print(f"installing estimator npm dependencies in {work} ...")
        subprocess.run(["npm", "install", "--no-audit", "--no-fund"],
                       cwd=work, check=True, stdout=subprocess.DEVNULL)
        estimator_dir = work

    parsing = estimator_dir / "parsing.js"
    src = parsing.read_text()
    if "Non-HF http(s) base" not in src:
        old = '''export function buildResolveUrl(path, filename) {
  const modelPath = extractHfSlug(path) ?? path;
  return `https://huggingface.co/${modelPath}/resolve/main/${filename}`;
}'''
        if old not in src:
            print("fatal: cannot patch parsing.js (unexpected content)", file=sys.stderr)
            sys.exit(91)
        parsing.write_text(src.replace(old, BUILD_RESOLVE_URL_PATCH))
    return estimator_dir


def model_entries():
    """Deduped model dicts in canonical order."""
    entries, seen = [], set()
    for m in json.loads(MODEL_DATA.read_text())["models"]:
        repo = m["hf-repo"].split(":")[0]
        key = (repo, m["model"])
        if key not in seen:
            seen.add(key)
            entries.append(m)
    return entries


def run_estimator(estimator_dir, target, fname, ctx, mmproj, args, is_url):
    cmd = ["node", "run-calc.js", target,
           "--ctx", str(ctx), "--vram", str(args.vram),
           "--batchSize", str(args.batch),
           "--gpu", args.gpu]
    if not is_url:
        cmd += ["--file", fname]
    if args.mmproj_device == "exclude":
        cmd.append("--no-mmproj")
    elif mmproj:
        cmd += ["--mmprojDevice", args.mmproj_device, "--mmproj", mmproj]
    proc = subprocess.run(cmd, cwd=estimator_dir, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"{target}/{fname} ctx={ctx}: {proc.stderr.strip()[:300]}")
    return json.loads(proc.stdout)


def collect(args, estimator_dir):
    sig = (f"{args.mmproj_device}-v{args.vram}-b{args.batch}"
           f"-c{','.join(map(str, args.ctxs))}-{args.gpu}-{args.hub_url}")
    cache = Path(args.cache_dir) / sig if args.cache_dir else None
    if cache:
        cache.mkdir(parents=True, exist_ok=True)

    rows, failures = {}, 0
    for m in model_entries():
        repo, fname = m["hf-repo"].split(":")[0], m["model"]
        url = local_snapshot_url(repo, fname, args)
        target = url or repo
        mmproj = local_mmproj(repo, m.get("mmproj")) if url else m.get("mmproj")
        stem = f"{repo.split('/')[-1]}_{fname[:-len('.gguf')]}"
        per_ctx = {}
        for ctx in args.ctxs:
            cfile = cache / f"{stem}_c{ctx}.json" if cache else None
            if cfile and cfile.exists():
                d = json.loads(cfile.read_text())
                if d.get("filename") == fname and (d.get("url", "").endswith(fname) or d.get("repo") == repo):
                    per_ctx[ctx] = d
                    continue
            try:
                d = run_estimator(estimator_dir, target, fname, ctx, mmproj, args,
                                  is_url=url is not None)
            except RuntimeError as e:
                print(f"FAIL {e}", file=sys.stderr)
                failures += 1
                continue
            if cfile:
                cfile.write_text(json.dumps(d, indent=1))
            per_ctx[ctx] = d
        if per_ctx:
            rows[(repo, fname)] = per_ctx
        else:
            print(f"MISS {repo} {fname}", file=sys.stderr)
            failures += 1
    return rows, failures


def perf_key(rows, max_ctx):
    """(decode tps, prefill tps) at the largest tested ctx; generation speed
    descending, preprocessing speed as tiebreaker."""
    def key(item):
        _, pc = item
        p = pc[max_ctx].get("performance") or {}
        return (-p.get("decodeTPS", 0), -p.get("prefillTPS", 0))
    return key


def render(rows, args):
    max_ctx = max(args.ctxs)
    ordered = sorted(rows.items(), key=perf_key(rows, max_ctx))

    out = ["""# GGUF VRAM fit + performance estimates (gdevenyi/huggingface-estimate)

Generated by `local-llm/generate_vram_fit_tables.py` from
[`gdevenyi/huggingface-estimate`](https://github.com/gdevenyi/huggingface-estimate)
(`run-calc.js`) — replacing the archived `local-llm` size-estimation scripts
(now in `OLD/gguf-size-estimation/`, see `docs/gguf-model-tooling.md`).

Parameters common to every row:

| Parameter | Value |
|---|---|
| KV cache | F16 K / F16 V (SWA memory-saving mode, llama.cpp default) |
| `--batchSize` | %d |
| `--vram` | %d GiB budget (fit check enabled) |
| GPU | %s (speed-of-light decode/prefill model) |
| mmproj | %s |
| model source | local HF-cache mirror (%s), falling back to huggingface.co |

Rows are ordered by **token generation speed at ctx=%d** (descending);
preprocessing (prefill) speed breaks ties. The same order drives
`openai-completions/llamacpp-model-data.json`.

## How to read the tables

**"Fits" is almost meaningless here**: llama.cpp can always spill whole layers
to CPU until VRAM closes, so nearly everything "fits". The informative columns
are the **layer split**, **RAM spill** and the performance columns:

- **F / H / C** — layers fully on GPU / hybrid (MoE experts on CPU, rest on
  GPU) / fully spilled to CPU.
- **RAM spill** — total system-RAM residency after the split (spilled weights,
  their KV, hybrid expert weights, input embeddings, mmproj when configured).
- **Gen tok/s / Pre tok/s** — theoretical speed-of-light upper bounds; real
  llama.cpp typically reaches 40–70%% of these. Anything with spilled/hybrid
  layers is dominated by `cpu-dram-spill`.
- **Bottleneck** — the upgrade lever named by the tool.

Activations are the tool's conservative all-layer fp32 workspace (llama.cpp
allocates a single worst-layer buffer instead — treat as an upper bound).
Speeds are computed on the post-split layer placement shown in the same row.

Raw per-run JSON this document was generated from:
[`gguf-vram-fit-estimates.data.json`](gguf-vram-fit-estimates.data.json).
Generated: %s.

## Performance summary (ordered by generation speed @ ctx=%d)

| # | Model | Quant | Gen tok/s | Pre tok/s | Bottleneck | VRAM GiB | RAM spill GiB | F | H | C |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|
""" % (args.batch, args.vram, args.gpu, {
        "ram": "in system RAM (`--mmprojDevice ram`)",
        "vram": "on GPU (`--mmprojDevice vram`)",
        "exclude": "excluded (`--no-mmproj`)",
    }[args.mmproj_device], args.hub_url, max_ctx, datetime.now(timezone.utc).strftime("%Y-%m-%d"), max_ctx)]

    def short(d):
        fit = d["vramFit"]
        perf = d.get("performance") or {}
        return perf, fit, perf.get("bottleneck", {}).get("overall", "-")

    rank = {}
    for i, ((repo, fname), pc) in enumerate(ordered, 1):
        rank[(repo, fname)] = i
        d = pc[max_ctx]
        perf, fit, b = short(d)
        name = repo.split("/")[-1].replace("-GGUF", "")
        gs = f"{perf['decodeTPS']:.2f}" if perf else "-"
        ps = f"{perf['prefillTPS']:.2f}" if perf else "-"
        out.append(
            f"| {i} | {name} | {d['quant']} | {gs} | {ps} | {b} "
            f"| {fit['actualVramGiB']:.2f} | {fit['actualRamGiB']:.2f} "
            f"| {fit['nGpuLayers']} | {fit['nHybridLayers']} | {fit['nCpuLayers']} |\n")

    out.append("""
## Model inventory

| Repo | File | Arch | Quant | Params | Weights GiB | Layers (+MTP) | Max ctx |
|---|---|---|---|---:|---:|---:|---:|
""")
    for (repo, fname), pc in ordered:
        d = next(iter(pc.values()))
        mi = d["modelInfo"]
        out.append(f"| `{repo}` | `{fname}` | {d['arch']} | {d['quant']} "
                   f"| {d['totalParamsFormatted']} | {d['weightBytes'] / GIB:.2f} "
                   f"| {mi['layers']} (+{mi['mtpLayers']}) "
                   f"| {mi['contextLength'] // 1024}k |\n")

    for ctx in args.ctxs:
        out.append(f"""
## Breakdown @ ctx = {ctx}

Same ordering as the summary table.

| Model | Quant | KV GiB | Act GiB | VRAM GiB | Usage % | Gen tok/s | Pre tok/s | Bottleneck | F | H | C | RAM spill GiB | GPU-only? |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|:-:|
""")
        for (repo, fname), pc in ordered:
            d = pc.get(ctx)
            if d is None:
                continue
            fit = d["vramFit"]
            perf = d.get("performance") or {}
            name = repo.split("/")[-1].replace("-GGUF", "")
            gs = f"{perf['decodeTPS']:.2f}" if perf else "-"
            ps = f"{perf['prefillTPS']:.2f}" if perf else "-"
            bn = (d.get("performance") or {}).get("bottleneck", {}).get("overall", "-")
            gpu_only = "yes" if (fit["nCpuLayers"] == 0 and fit["nHybridLayers"] == 0) else "no"
            out.append(
                f"| {name} | {d['quant']} | {d['kvCache']['totalBytes'] / GIB:.2f} "
                f"| {d['activations']['totalBytes'] / GIB:.2f} "
                f"| {fit['actualVramGiB']:.2f} | {fit['usagePct']:.0f}% "
                f"| {gs} | {ps} | {bn} "
                f"| {fit['nGpuLayers']} | {fit['nHybridLayers']} | {fit['nCpuLayers']} "
                f"| {fit['actualRamGiB']:.2f} | {gpu_only} |\n")

    return "".join(out)


def update_model_data(rows, args):
    max_ctx = max(args.ctxs)
    ordered = sorted(rows.items(), key=perf_key(rows, max_ctx))
    order = {(repo, fname): i for i, ((repo, fname), _) in enumerate(ordered)}
    data = json.loads(MODEL_DATA.read_text())
    data["models"].sort(key=lambda m: order.get(
        (m["hf-repo"].split(":")[0], m["model"]), len(order)))
    MODEL_DATA.write_text(json.dumps(data, indent="\t") + "\n")
    print(f"reordered {MODEL_DATA} by generation speed @ ctx={max_ctx} (desc)")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--estimator-dir", default=DEFAULT_ESTIMATOR,
                    help="checkout of gdevenyi/huggingface-estimate (default %(default)s)")
    ap.add_argument("--cache-dir", default="/tmp/vram-fit-runs",
                    help="dir for raw per-run JSONs (skips re-running on hit)")
    ap.add_argument("--ctxs", default=",".join(map(str, CTXS)),
                    help="comma-separated context lengths (default %(default)s)")
    ap.add_argument("--vram", type=int, default=15, help="VRAM budget GiB (default %(default)s)")
    ap.add_argument("--batch", type=int, default=2048,
                    help="llama.cpp n_batch for activations (default %(default)s)")
    ap.add_argument("--gpu", default="amd-radeon-rx-6900-xt",
                    help="GPU preset id from gpu-data.json (default %(default)s)")
    ap.add_argument("--hub-url", default="http://localhost:9090",
                    help="HTTP mirror of the HF hub cache dir (default %(default)s); "
                         "models missing locally fall back to huggingface.co")
    ap.add_argument("--mmproj-device", choices=["ram", "vram", "exclude"], default="ram",
                    help="where the multimodal projector lives (default %(default)s)")
    ap.add_argument("--update-model-data", action="store_true",
                    help="also reorder llamacpp-model-data.json by the ranking")
    args = ap.parse_args()
    args.ctxs = [int(c) for c in args.ctxs.split(",")]

    estimator = Path(os.path.expanduser(args.estimator_dir))
    if not (estimator / "run-calc.js").exists():
        print(f"fatal: no run-calc.js under {estimator}", file=sys.stderr)
        return 90
    estimator = ensure_estimator(estimator)

    rows, failures = collect(args, estimator)
    OUT_MD.write_text(render(rows, args))
    OUT_JSON.write_text(json.dumps(
        {f"{r}:{fn}": {str(c): pc[c] for c in sorted(pc)} for (r, fn), pc in rows.items()},
        indent=1))
    print(f"wrote {OUT_MD} and {OUT_JSON} ({len(rows)} models x {len(args.ctxs)} ctxs, "
          f"{failures} failures)")
    if args.update_model_data:
        update_model_data(rows, args)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

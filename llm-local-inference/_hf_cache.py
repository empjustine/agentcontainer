"""
_hf_cache.py — the Hugging Face hub-cache facts the cache scanners share.

Not a PEP 723 script (importing it fetches nothing and needs no dependency
beyond the stdlib): it exists because the coverage scanner and the
manifest scanner had already drifted on "what counts as a model file" and each
carried its own cache-root resolution. Sibling scripts reach it by name — the
script's own directory is `sys.path[0]` under `uv run <script>.py` — so this is
the one place a new sidecar prefix or a cache-root rule lands.
"""
import os
import re

# Files huggingface repos carry next to the weights (projection matrices,
# speculative-decoding drafts, quant-recipe metadata). Serving one is never
# right, so every scanner filters them identically.
SKIP_PREFIXES = ("mmproj", "mtp-", "eagle3-", "dflash-", "dspark-", "imatrix")

# The same sidecars when the word sits MID-NAME rather than at its start, where
# the prefix test cannot see it: the n-gram/Engram lookup table is published as
# "<model>-Engram-IQ4_NL.gguf" (the DeepSeek Coder's shard 6), so a name-only
# reader reads IQ4_NL as an alternative quantization of a repo that serves
# exactly one. The matching vocabulary lives in lib/model-entries.mjs
# (isSidecarFile) and 10-fetch-hf-manifests.py (SIDECAR_RE); three homes because
# three languages, each carrying this reason.
AUXILIARY_WORD_RE = re.compile(
    r"(?:^|[^a-z0-9])(?:imatrix|engram|ngram|n-gram)(?:[^a-z0-9]|$)", re.IGNORECASE
)


def is_model_file(name: str) -> bool:
    """True for a servable GGUF: a .gguf that is not a sidecar.

    The BASENAME is what gets compared: callers pass plain filenames today,
    and a path spelling must not change the answer (llama.cpp applies the same
    prefix test to the filename it is handed).
    """
    base = os.path.basename(name)
    return (
        base.endswith(".gguf")
        and not base.startswith(SKIP_PREFIXES)
        and not AUXILIARY_WORD_RE.search(base)
    )


def resolve_cache(arg: str | None = None) -> str:
    """The hub cache root: explicit argument, else `$HF_HUB_CACHE`, else the
    `$HF_HOME` layout under `$XDG_CACHE_HOME`/`~/.cache`.

    Same order the `hf` CLI documents, so a shell that already works for
    `hf download` needs no extra flag here.
    """
    if arg:
        return arg
    if os.environ.get("HF_HUB_CACHE"):
        return os.environ["HF_HUB_CACHE"]
    home = os.environ.get("HF_HOME") or os.path.join(
        os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")),
        "huggingface",
    )
    return os.path.join(home, "hub")

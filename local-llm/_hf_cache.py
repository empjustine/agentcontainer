"""
_hf_cache.py — the Hugging Face hub-cache facts the local-llm scanners share.

Not a PEP 723 script (importing it fetches nothing and needs no dependency
beyond the stdlib): it exists because the coverage scanner and the
manifest scanner had already drifted on "what counts as a model file" and each
carried its own cache-root resolution. Sibling scripts reach it by name — the
script's own directory is `sys.path[0]` under `uv run <script>.py` — so this is
the one place a new sidecar prefix or a cache-root rule lands.
"""
import os

# Files huggingface repos carry next to the weights (projection matrices,
# speculative-decoding drafts, quant-recipe metadata). Serving one is never
# right, so every scanner filters them identically.
SKIP_PREFIXES = ("mmproj", "mtp-", "eagle3-", "dflash-", "dspark-", "imatrix")


def is_model_file(name: str) -> bool:
    """True for a servable GGUF: a .gguf that is not a sidecar.

    The BASENAME is what gets compared: callers pass plain filenames today,
    and a path spelling must not change the answer (llama.cpp applies the same
    prefix test to the filename it is handed).
    """
    base = os.path.basename(name)
    return base.endswith(".gguf") and not base.startswith(SKIP_PREFIXES)


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

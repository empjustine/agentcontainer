#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""fetch_model_cards.py — mirror the Hub README of every served repo.

The mirrors are upstream READMEs byte for byte, so their repo-relative image
links dangle locally: images are not mirrored on purpose (a picture copy would
bloat the repo to serve nothing). A broken image in a card is that, not a
missing fetch — read the diagrams on the Hub.

Repos come from the model manifest (the operator's chosen list), the same list
curation starts from, so a card appears exactly when a model entry does.

Exit code 1 when any card fails; a gated repo without HF_TOKEN is the common
case and does not stop the rest.

Usage: uv run llm-local-inference/fetch_model_cards.py
"""

import json

# Structured logging (JSON lines on stderr; see lib/log.py) — stdout stays
# reserved for machine-consumed output.
import pathlib as _pl
import ssl
import sys
import urllib.request

sys.path.insert(0, str(_pl.Path(__file__).resolve().parent / "lib"))
import log

log.set_tool("llm-local-inference/fetch-model-cards")
log.set_stream(sys.stderr)

HERE = _pl.Path(__file__).parent
CARDS = HERE / "model-cards"
MANIFEST = HERE / "lib" / "llamacpp-model-data.json"


def main() -> int:
    # A tool with no flags fails on arguments (docs/d212).
    if len(sys.argv) > 1:
        print("usage: fetch_model_cards.py   # takes no arguments", file=sys.stderr)
        return 64

    data = json.loads(MANIFEST.read_text())
    repos = sorted({row["hf-repo"].split(":")[0] for row in data["models"]})
    ctx = ssl.create_default_context()
    ok = failed = 0
    for repo in repos:
        out = CARDS / repo / "README.md"
        url = f"https://huggingface.co/{repo}/raw/main/README.md"
        try:
            with urllib.request.urlopen(url, timeout=60, context=ctx) as response:
                content = response.read()
        except Exception as e:  # noqa: BLE001 — one card's failure must not stop the sweep
            log.warn("model card fetch failed", repo=repo, error=e)
            failed += 1
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(content)
        log.info("model card fetched", repo=repo, path=str(out), bytes=len(content))
        ok += 1
    log.info("done", ok=ok, failed=failed)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())


#!/bin/sh
# Refresh the model-card mirrors under local-llm/model-cards/<org>/<repo>.md from
# Hugging Face (README.md of each repo in ../openai-completions/llamacpp-model-data.json).
# File names are the repo id verbatim so cards always match the ids
# (see docs/hf-cache-upkeep.md).
#
# Usage: ./fetch-model-cards.sh
set -eu
cd "$(dirname "$0")"

python3 - <<'EOF'
import json, urllib.request, os, ssl

data = json.load(open("../openai-completions/llamacpp-model-data.json"))
base = "model-cards"
ctx = ssl.create_default_context()
repos = sorted({m["repo"] for m in data["models"]})

ok = fail = 0
for repo in repos:
    org, reponame = repo.split("/")
    out = os.path.join(base, org, reponame + ".md")
    url = f"https://huggingface.co/{repo}/raw/main/README.md"
    try:
        with urllib.request.urlopen(url, timeout=60, context=ctx) as r:
            content = r.read()
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "wb") as f:
            f.write(content)
        print(f"  ok  {out}  ({len(content)} bytes)")
        ok += 1
    except Exception as e:
        print(f"  FAIL {repo}: {e}")
        fail += 1
print(f"done — {ok} ok, {fail} failed")
EOF

#!/bin/sh
# Refresh the model-card mirrors under local-llm/model-cards/<org>/<repo>.md from
# Hugging Face (README.md of each repo in ../lib/llamacpp-model-data.json).
# File names are the repo id verbatim so cards always match the ids
# (see docs/hf-cache-upkeep.md).
#
# Usage: ./fetch-model-cards.sh
set -eu
cd "$(dirname "$0")"

# JSON-log helpers (same contract as lib/log.sh) — the python body below has
# no shell, so it emits the structured lines itself.
python3 - <<'EOF'
import json, sys, datetime, urllib.request, os, ssl

TOOL = "local-llm/fetch-model-cards"

def log(level, msg, **fields):
    rec = {"ts": datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"), "level": level, "tool": TOOL, "msg": msg}
    rec.update(fields)
    print(json.dumps(rec), file=sys.stderr)

data = json.load(open("../lib/llamacpp-model-data.json"))
base = "model-cards"
ctx = ssl.create_default_context()
repos = sorted({m["hf-repo"].split(":")[0] for m in data["models"]})

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
        log("info", "model card fetched", repo=repo, path=out, bytes=len(content))
        ok += 1
    except Exception as e:
        log("warn", "model card fetch failed", repo=repo, error=str(e))
        fail += 1
log("info", "done", ok=ok, failed=fail)
sys.exit(1 if fail else 0)
EOF

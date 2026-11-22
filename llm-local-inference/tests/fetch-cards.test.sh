#!/bin/bash
# 10-fetch-hf-manifests.py: the card mirror is part of the same repo-driven
# fetch as the manifest — one Hub pass per repo, at the runbook's card path.
# huggingface_hub is stubbed: no network, no uv, no committed artifacts.
if [ -z "$BASH_VERSION" ]; then exec bash "$0" "$@"; fi
set -eu
UNIT="$(CDPATH='' cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
UNIT="$UNIT" TMP="$TMP" python3 - <<'PY'
import contextlib
import importlib.util
import io
import json
import logging
import os
import sys
import warnings
import types
from pathlib import Path

# The tool imports these at module load; the fake API below satisfies both.
class RepoFile:
    def __init__(self, path):
        self.path = path
        self.lfs = None
        self.blob_id = "oid"
        self.size = 1


hub = types.ModuleType("huggingface_hub")
hub.HfApi = object
hub_api = types.ModuleType("huggingface_hub.hf_api")
hub_api.RepoFile = RepoFile
utils = types.ModuleType("huggingface_hub.utils")
disabled = []
utils.disable_progress_bars = lambda: disabled.append(True)
sys.modules["huggingface_hub"] = hub
sys.modules["huggingface_hub.hf_api"] = hub_api
sys.modules["huggingface_hub.utils"] = utils

unit = Path(os.environ["UNIT"])
tmp = Path(os.environ["TMP"])
lib = tmp / "lib"
lib.mkdir()
(lib / "cache-scope.json").write_text(json.dumps({
    "acme/served-GGUF": "served",
    "acme/audit-GGUF": "audit-only",
    "acme/no-readme-GGUF": "audit-only",
}))
(lib / "llamacpp-model-data.json").write_text(json.dumps({"models": [
    {"hf-repo": "acme/served-GGUF:Q4_K_M", "model": "a-Q4_K_M.gguf"},
    {"hf-repo": "acme/drift-GGUF", "model": "a.gguf"},
]}))
source = tmp / "upstream.md"
source.write_bytes(b"# upstream readme\n")

buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    spec = importlib.util.spec_from_file_location("fetch", unit / "10-fetch-hf-manifests.py")
    fetch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fetch)
fetch.MODEL_DATA = lib / "llamacpp-model-data.json"
fetch.SCOPE_FILE = lib / "cache-scope.json"
fetch.MANIFEST_DIR = lib / "hf-manifests"
fetch.CARDS = tmp / "model-cards"

calls = []


class FakeApi:
    def repo_info(self, repo_id, revision):
        calls.append(("info", repo_id))
        return types.SimpleNamespace(sha="abc123")

    def list_repo_tree(self, repo_id, revision, recursive):
        calls.append(("tree", repo_id))
        if repo_id.endswith("no-readme-GGUF"):
            paths = ["a.gguf"]
        elif repo_id.endswith("served-GGUF"):
            paths = ["README.md", "a-Q4_K_M.gguf"]
        else:
            paths = ["README.md", "a.gguf"]
        return [RepoFile(p) for p in paths]

    def hf_hub_download(self, repo_id, filename, revision):
        calls.append(("card", repo_id, revision))
        return str(source)


fetch.HfApi = FakeApi
sys.argv = ["10-fetch-hf-manifests.py"]
status = 0
with contextlib.redirect_stdout(io.StringIO()):
    try:
        fetch.main()
    except SystemExit as exit:
        status = exit.code

fails = 0


def check(name, got, want):
    global fails
    if got != want:
        print("FAIL " + name + ": " + repr(got) + " != " + repr(want))
        fails += 1
    else:
        print("ok   " + name)


check("exit", status, 0)
check("progress bars disabled", disabled, [True])
logging.getLogger("huggingface_hub.file_download").warning("hub says %s", "hello")
logging.getLogger("gguf.gguf_reader").warning("gguf says hello")
logging.getLogger("pypdf").warning("pypdf says hello")
warnings.warn("notice from hub")
records = [json.loads(line) for line in buf.getvalue().splitlines()]


def has(msg, severity):
    return any(
        msg in r.get("msg", "")
        and r.get("severityNumber") == severity
        and r.get("tool") == "llm-local-inference/fetch-hf-manifests"
        for r in records
    )


check("hub log is JSONL", has("hub says hello", 13), True)
check("gguf log is JSONL", has("gguf says hello", 13), True)
check("pypdf log is JSONL", has("pypdf says hello", 13), True)
check("warnings are JSONL", has("notice from hub", 13), True)
for repo in ("acme/served-GGUF", "acme/audit-GGUF", "acme/drift-GGUF"):
    check(repo + " card", (tmp / "model-cards" / (repo + ".md")).read_bytes(), b"# upstream readme\n")
check("no README is skipped", (tmp / "model-cards/acme/no-readme-GGUF.md").exists(), False)
check("no nested READMEs", sorted(p.name for p in (tmp / "model-cards").rglob("README.md")), [])
check("one card fetch per repo", sorted(c[1] for c in calls if c[0] == "card"),
      ["acme/audit-GGUF", "acme/drift-GGUF", "acme/served-GGUF"])
check("one tree fetch per repo", len([c for c in calls if c[0] == "tree"]), 4)
check("card pinned to manifest commit", {c[2] for c in calls if c[0] == "card"}, {"abc123"})
raise SystemExit(1 if fails else 0)
PY

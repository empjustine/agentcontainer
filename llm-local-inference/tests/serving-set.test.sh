#!/bin/bash
# _serving_set.py: the keep set and the three classification labels the audit
# prints and the pruner deletes by (docs/d218). The projector rule is the one
# that needs the test — a projector is a REPO fact, so a curated file derived
# from the rows alone would leave --mmproj pointing at a file the pruner treats
# as undeclared and erases.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu
UNIT="$(CDPATH='' cd "$(dirname "$0")/.." && pwd)"
# The module is stdlib-only, so any python3 runs it: no uv, no network, no
# huggingface_hub (a few tools import it; the stubs keep this test stdlib-only).
if ! command -v python3 >/dev/null 2>&1; then
	echo "skip - no python3 (the serving set is a stdlib-only module)" >&2
	exit 0
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
UNIT="$UNIT" TMP="$tmp" python3 - <<'PY'
import json
import os
import sys
from pathlib import Path

unit = Path(os.environ["UNIT"])
lib = Path(os.environ["TMP"]) / "lib"
(lib / "hf-manifests").mkdir(parents=True)
sys.path.insert(0, str(unit))
import _serving_set as serving

serving.LIB = lib
fails = 0


def check(name, got, want):
    global fails
    if got == want:
        print("ok   " + name)
    else:
        print("FAIL " + name + " (expected " + repr(want) + ", got " + repr(got) + ")")
        fails += 1


def manifest(repo, paths):
    (lib / "hf-manifests" / (repo.replace("/", "--") + ".json")).write_text(
        json.dumps(
            {
                "repo": repo,
                "commit": "deadbeef",
                "files": [{"path": p, "size": 1} for p in paths],
            }
        )
    )


# Rows name the weights, never a projector: the projector is a repo fact
# (docs/d197). The sharded row names shard 1 only, so the rest comes from the
# manifest too.
(lib / "llamacpp-model-data.json").write_text(
    json.dumps(
        {
            "models": [
                {"hf-repo": "acme/served-GGUF", "model": "weights.gguf"},
                {
                    "hf-repo": "acme/sharded-GGUF",
                    "model": "model-00001-of-00003.gguf",
                },
            ]
        }
    )
)
(lib / "cache-scope.json").write_text(
    json.dumps({"acme/served-GGUF": "served", "acme/audit-GGUF": "audit-only"})
)
manifest(
    "acme/served-GGUF",
    ["weights.gguf", "mmproj-BF16.gguf", "mmproj-Q8_0.gguf", "imatrix.gguf"],
)
manifest(
    "acme/sharded-GGUF",
    [
        "model-00001-of-00003.gguf",
        "model-00002-of-00003.gguf",
        "model-00003-of-00003.gguf",
        "mmproj-F16.gguf",
    ],
)
manifest("acme/audit-GGUF", ["weights.gguf", "mmproj-BF16.gguf"])

wanted = serving.serving_set()
# Every projector the repo ships, not just the one curation would pick, and not
# the auxiliary the quant-display rules exclude.
check(
    "the keep set takes all of a repo's projectors",
    sorted(wanted.get("acme/served-GGUF", [])),
    ["mmproj-BF16.gguf", "mmproj-Q8_0.gguf", "weights.gguf"],
)
check(
    "a sharded row is kept whole",
    sorted(wanted.get("acme/sharded-GGUF", [])),
    [
        "mmproj-F16.gguf",
        "model-00001-of-00003.gguf",
        "model-00002-of-00003.gguf",
        "model-00003-of-00003.gguf",
    ],
)
# An audit-only repo is facts, not bytes: it is not in the keep set at all, so
# every cached file of it classifies as prunable.
check("an audit-only repo has no keep set", "acme/audit-GGUF" in wanted, False)

# The model-file vocabulary the two cache scanners share: a sidecar is not a
# servable GGUF, and the n-gram/Engram table is a sidecar even though its name
# carries a quant tag (the DeepSeek Coder publishes it as
# `DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf`, shard 6 of the release). Without
# this rule the coverage scan reports IQ4_NL as an extra quant the manifest
# forgot, and the manifest scan would propose it as an entry (docs/d238).
import _hf_cache as hf_cache

for name, want in [
    ("weights.gguf", True),
    ("DeepSeek-Coder-IQ2_XXS-00001-of-00006.gguf", True),
    ("Engrammatic-7B-Q4_K_M.gguf", True),
    ("DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf", False),
    ("model-ngram-Q8_0.gguf", False),
    ("imatrix.gguf", False),
    ("mmproj-BF16.gguf", False),
    ("mtp-Qwen3.8-27B-Q4_0.gguf", False),
    ("README.md", False),
]:
    check("is a model file: " + name, hf_cache.is_model_file(name), want)

declared = serving.scope()
for repo, name, want in [
    ("acme/served-GGUF", "mmproj-Q8_0.gguf", None),
    ("acme/served-GGUF", "stray.gguf", "not-declared"),
    ("acme/served-GGUF", "README.md", "not-gguf"),
    ("acme/audit-GGUF", "weights.gguf", "repo-audit-only"),
    ("acme/outside-GGUF", "weights.gguf", "repo-out-of-scope"),
]:
    check(
        "classify " + repo + "/" + name,
        serving.classify(repo, name, wanted, declared),
        want,
    )

sys.exit(1 if fails else 0)
PY

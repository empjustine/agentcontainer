#!/bin/sh
# shellcheck disable=SC1091
. "$(dirname "$0")/../container-tool.sh"

# Generate the layered pi models.json into this dir (docs/models-layered-cake.md):
#   generate-models.json.mjs  -> model-010-local-default.json (detection needs
#   PEER_API_KEY / cloud provider keys from Infisical --path=/inference)
#   generate-cline-pass.mjs   -> model-015-cloud-cline-pass.json (ClinePass;
#   reads the vendored models.dev.api.json; no network, no secrets)
#   merge-models-json.js      -> models.json (no network, no secrets)
#
# On a co-located host no env vars are required (the generator defaults to
# localhost:8080); remote hosts additionally export PEER_BASE_URL before
# calling this script.

script_dir="$(cd "$(dirname "$0")" && pwd)"

# Best-effort refresh of the vendored models.dev catalog (no secrets needed).
# On any failure (network, non-200, invalid/unexpected payload, truncated
# download) it warns and keeps the existing models.dev.api.json, so generation
# still works offline or behind a reverse proxy that blocks direct egress.
if ! mise exec node@24 -- node "$script_dir/refresh-models-dev.mjs" "$script_dir/models.dev.api.json"
then
	>&2 printf "warning: models.dev catalog refresh failed; using vendored copy\n"
fi

if ! infisical login --domain="$INFISICAL_API_URL" --log-level=info status; then
	exit 127
fi

if ! mise exec node@24 -- \
	infisical run --domain="$INFISICAL_API_URL" --projectId="$INFISICAL_PROJECT_ID" --log-level=info --env=prod --path=/inference -- \
	node "$script_dir/generate-models.json.mjs" "$script_dir/model-010-local-default.json"
then
	>&2 printf "warning: generate-models.json.mjs failed; using existing layer if present\n"
fi

# ClinePass layer: derived from the vendored models.dev.api.json, no secrets needed.
# NOTE: there is intentionally NO google layer here — llama-swap is an
# openai-completions relay and cannot proxy Google's native API, so Google
# always goes through pi's built-in google provider (GEMINI_API_KEY).
if ! mise exec node@24 -- node "$script_dir/generate-cline-pass.mjs" "$script_dir/model-015-cloud-cline-pass.json"
then
	>&2 printf "warning: generate-cline-pass.mjs failed; using existing layer if present\n"
fi

if ! mise exec node@24 -- node "$script_dir/merge-models-json.js" "$script_dir/models.json"
then
	>&2 printf "warning: merge-models-json.js failed; using existing models.json if present\n"
fi

# opencode peer-mode provider overlay: native/OpenAI-compatible providers
# routed through the peers-only router when the cloud is unreachable.
if ! mise exec node@24 -- \
	infisical run --domain="$INFISICAL_API_URL" --projectId="$INFISICAL_PROJECT_ID" --log-level=info --env=prod --path=/inference -- \
	node "$script_dir/generate-opencode.jsonc.mjs" "$script_dir/opencode.jsonc"
then
	>&2 printf "warning: generate-opencode.jsonc.mjs failed; using existing opencode.jsonc if present\n"
fi

echo "models.json + opencode.jsonc generated in $script_dir"

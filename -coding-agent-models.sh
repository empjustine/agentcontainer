#!/bin/sh

source ~/agentcontainer/-coding-agent-api-llamacpp.env

if [ -n "$LLAMACPP_BASE_URL" ]; then
	URL="$LLAMACPP_BASE_URL"
elif [ -n "$LLAMA_API_BASE_URL" ]; then
	URL="$LLAMA_API_BASE_URL"
else
	>&2 printf "fatal: can't find openai-completions endpoint"
	exit 127
fi
export URL

if [ -n "$LLAMACPP_API_KEY" ]; then
	BEARER_TOKEN="$LLAMACPP_API_KEY"
elif [ -n "$LLAMA_API_KEY" ]; then
	BEARER_TOKEN="$LLAMA_API_KEY"
else
	>&2 printf "fatal: can't find openai-completions bearer token"
	exit 127
fi
export BEARER_TOKEN

curl --variable '%URL' --expand-url '{{URL}}/models' \
	--header "Authorization: Bearer ${BEARER_TOKEN}" \
	| jq -c '{"providers":{"llamacpp":{
  "baseUrl": env.URL,
  "api": "openai-completions",
  "apiKey": "$LLAMACPP_API_KEY",
  "models": [.data[] | {
    "id": .id,
    "contextWindow": 65536,
    "input": ["text"],
    "reasoning": true,
    "name": "llamacpp " + .id,
    "maxTokens": 65536,
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
}]}}}'

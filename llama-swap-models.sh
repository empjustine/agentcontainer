#!/bin/sh

URL='http://localhost:8080/v1'

curl -s "${URL}/models" | jq --arg URL "$URL" '
{
  "providers": {
    "llama-swap": {
      "baseUrl": $URL,
      "api": "openai-completions",
      "apiKey": "llama-swap",
      "models": [
        .data[] | {
          "id": .id,
          "name": (.id | split(":")[0] | split("/")[1] // split("/")[0])
        }
      ]
    }
  }
}
' >~/.pi/agent/models.json
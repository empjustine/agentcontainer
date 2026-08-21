# d015: API gateway

`cloud-llm/api-gateway/server.js` is a lightweight API gateway that proxies
requests to cloud AI providers over Tailscale Funnel. It is **an API
gateway, not a transparent proxy** (CONNECT/SOCKS): it terminates client
connections and creates new connections to providers.

Full usage, configuration reference, and the reasoning behind the design live
with the code:
- [`cloud-llm/api-gateway/README.md`](../cloud-llm/api-gateway/README.md) —
  architecture, config, URL structure, streaming, Tailscale Funnel setup,
  troubleshooting.
- [`cloud-llm/api-gateway/DECISIONS.md`](../cloud-llm/api-gateway/DECISIONS.md) —
  the decision record (why gateway not proxy, UUID routing, basic auth, nested
  credentials, single JSON config, SSE passthrough, endpoint restrictions, etc.).

## Summary

- **Two auth layers**: Layer 1 client→gateway uses HTTP Basic auth;
  Layer 2 gateway→provider injects the provider's key (`Bearer`,
  `X-Goog-Api-Key`, or `X-API-Key`). The client never sees provider keys.
- **UUID routing**: `/ <uuid> /v1/...` maps each UUID to a provider config in
  `api-gateway-config.json`; UUIDs are routing keys, not secrets.
- **Nested credentials**: clients authenticate to the gateway, and the gateway
  authenticates to the provider separately.
- **Streaming**: full SSE passthrough for `chat/completions` when `stream: true`.
- **Endpoint restrictions**: `allowedEndpoints` per provider (or `["*"]`).
- **No response caching**; concurrency limited (default 50), configurable
  timeouts; health endpoint at `/` (no auth).

# AGENTS.md — pi-aperture-provider

**Reference documentation only: no code, no model data, no extension entry.**
Aperture is the fleet's gateway on the tailnet, so the folder documents where its
MCP endpoint is, what a keyless probe of it measures, and where the vendor's
documentation lives. The family rules bind it unchanged (docs/d100, docs/d097):
`../pi-coding-agent-provider/AGENTS.md` is the rule set to read first.

- **No model data, ever.** `/v1/models` answers keyless with 444 rows on this
  gateway, but that list is the _caller's_ view of it — grants and profiles
  decide which rows appear — so a copy here could only be a downgrade of what pi
  already resolves (docs/d100). The fleet's lineup is
  `../coding-agent/models.json`.
- **No credentials, and no assumption that the endpoint is public.** The name
  `ai.coelacanth-barb.ts.net` resolves through MagicDNS inside this tailnet and
  answers `NXDOMAIN` on public DNS; the endpoint authenticates by tailnet
  identity and takes no header. An entry never needs `headers`, and a test never
  needs a key.
- **The measurement in `README.md` is the one grant-free claim this folder may
  make.** Aperture is deny-by-default, so a keyless probe sees exactly one tool,
  `aperture_request_access`; asserting a granted tool list from CI would be
  asserting the runner's identity. Keep new claims to what a keyless probe can
  observe, and name the gateway host they came from.
- **The vendor's documentation is the source of truth, and it is Markdown.**
  Append `.md` to any `tailscale.com/docs/…` page, and start from
  `https://tailscale.com/docs/llms.txt` for the page index. The gateway serves
  no docs route, so a doc claim cites tailscale.com, never a `/docs` path on the
  gateway.
- **The MCP entry lives in `../coding-agent/mcp.json`, and it ships closed.**
  `"enabled": false` with `"exposure": "hidden"` (docs/d061), so opening it is an
  operator step in `/mcp` — two parts, the flag and the exposure. The static
  description is load-bearing: it states the trust posture and the tailnet-only
  reachability, and a hidden entry renders no line of its own that could correct
  the text later.
- **No extension entry until there is something to register.** The Aperture CLI
  already generates and loads a temporary Pi provider extension (`pi -e`), and
  the catalog is per-identity, so the only shape that could land is the
  `refreshModels`-only watchdog — and its probe cannot even resolve off the
  tailnet. When code does land it brings `package.json` with
  `pi.extensions`, `index.mjs`, `tests/`, its own `pnpm-lock.yaml` and its
  `knip.jsonc` entry (docs/d192).
- **This folder stays copyable** (docs/d113): no reference to a sibling unit's
  `lib/`, and the URLs it cites live in `README.md`, not in code.

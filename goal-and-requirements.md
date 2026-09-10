---
id: goal
type: goal-and-requirements
status: draft
title: agentcontainer — personal multi-host LLM serving + coding-agent fleet
tags: ["[root]"]
---

## Goal

Serve LLMs on the owner's own fleet of hosts (bazzite GPU desktop, a50
phone/router, WSL2, an OCI VM) through **one llama-swap instance per host**, and
configure the pi coding-agent to consume that catalog — a single-user
infrastructure setup, not a product. *(User-confirmed.)*

The same tree adapts across hosts with wildly different capabilities (GPU or
none, container runtime or none, cloud access or not) without forking per-host
copies: capability detection at generation time decides what a host gets.

## Scope

- **Serving** — `llm-reverse-proxy/` (see `llm-reverse-proxy`): local llama.cpp
  GGUF inference where the host can do it, cloud-provider peers everywhere,
  published on LAN :8080 and reachable through the tailscale FQDN.
- **Usage** — `coding-agent/` (see `coding-agent`): the pi coding-agent's
  container image, generated `models.json`/`opencode.jsonc` layers, static
  settings, and credential handling.
- **Shared infrastructure** — `lib/` (see `lib`): backend-agnostic workload
  runner, structured logging, the provider/model fact tables.
- **Cache tooling** — `local-llm/` (see `local-llm`): provision and audit the
  HuggingFace cache that local inference serves from.
- **Docs & decision records** — `docs/` (environment matrix, `d0XX` design
  notes). The environment matrix lives in `environments`.

## Non-goals

- Not a product or multi-user platform: no account model, no tenant isolation,
  no rate-limiting beyond what llama-swap ships.
- No client-side free-tier catalog scraping: the agent uses pi's own model
  catalog, scoped by `enabledModels` (see `coding-agent`).
- PRoot is not a supported backend; Termux serves natively (see
  `docs/container-tooling.md`). A qemu/libvirt backend is assessed but not
  implemented (`docs/d020-libvirt-qemu-sandbox.md`).

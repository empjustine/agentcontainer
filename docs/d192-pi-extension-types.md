---
id: d192
type: architecture-design
status: active
title: "d192 — the pi extensions carry the host's real types: pnpm devDependency, .mjs entries, one shared store"
parent: architecture
depends-on: [architecture, d045, d096, d107, d113, d118, d190]
references: [d113, d118, d138, d139, d151, d190]
tags: ["pi", "extensions", "types", "pnpm", "dependencies", "dev-toolchain", "tsconfig"]
---

# d192 — the extensions hold the host's types

## Problem

Every `pi-*` extension entry was a `.ts` file importing
`@earendil-works/pi-coding-agent` for one thing: the `ExtensionAPI` type of its
factory's parameter. That package is provided by the host at runtime and was
never a dependency here, so the type had to be declared structurally instead —
each folder wrote its own `RefreshContext` interface with every field optional,
guessed from the shipped declaration, and its provider config carried no check
at all. The alternative, actually loading the host's types, looked free until
it was measured: `tsconfig.json` excluded `pi-*/index.ts` from the program, and
each folder's test imported the entry through a computed specifier so tsc could
not see a host-provided module it would report as missing.

Three costs rode on that: the registration and the emitted model shape were the
only code in the tree no gate read; the exclusions were the last per-file
exemptions in `tsconfig.json` and `knip.jsonc`; and the "`$NAME` reference /
`authHeader` / `compat`" fields were claims in comments rather than in types.

## Decision

**Each extension folder declares `@earendil-works/pi-coding-agent` as an exact
devDependency, installed with pnpm, and its entry is an `.mjs` file whose types
come from that package.**

- **pnpm, not npm.** A folder is a copy unit (docs/d113), so each needs its own
  lockfile and tree; npm would write six unpacked copies of a 24 MB package (149
  MB of tree each). pnpm's content-addressable store hardlinks one copy into all
  six — the six trees plus the store cost about one and a half trees on disk, and
  a copied-out folder stays installable from its own `pnpm-lock.yaml`. The store
  lives at the repo root (`.pnpm-store/`, gitignored) because it cannot hardlink
  across filesystems.
- **pnpm is a pinned dev tool**, in `./dev-tools.sh`'s one pin table with the
  rest (docs/d139); it never appears in a runtime path.
- **Install is one path.** `./npm-tools.sh` gained `pnpm_tools_ensure`, which
  `./check-types.sh` calls beside `npm_tools_ensure`: the gate installs what it
  reads, per folder, stamped by the lockfile's cksum under `node_modules`, and
  skips an unchanged folder. `--frozen-lockfile` makes a drifted `package.json`
  fail at the gate instead of resolving silently.
- **The entry is `index.mjs`**, its factory typed by a JSDoc
  `@typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI}`, and the
  refresh context is DERIVED — `Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0]`
  — rather than imported from `@earendil-works/pi-ai`, which is a transitive
  dependency of the host that pnpm's isolated `node_modules` would not resolve.
  The host's loader reads `pi.extensions` from `package.json` and resolves any
  path that exists, so the extension change is one manifest line.
- **The exclusions are gone.** `tsconfig.json` lost its `pi-*/index.ts` entry and
  `knip.jsonc` names `pi-*/index.mjs` as an entry; the tests import the entry by
  literal specifier. `merge.mjs`'s `toExtensionModel` returns pi's own
  `ProviderModelConfig` (narrowed to the chat arm), so the emitted model shape —
  cost block, thinking map, compat mirror — is checked against the host's schema
  for the first time.
- **`skipLibCheck` is true again.** The development dependency drags pi-ai's
  provider SDK types into the program, and `@google/genai`'s declaration file
  names DOM globals (`RequestInfo`, `ErrorEvent`, `HeadersInit`) and an optional
  `@modelcontextprotocol/sdk` peer this repo does not install. The flag was
  false while `@types/node` was the only library in the program, which measured
  clean; a vendored type graph is the case the flag exists for. The tree carries
  no `.d.ts` of its own, so nothing written here is skipped.

**A source that cannot answer now THROWS.** The four catalog-owning extensions
(`pi-cline-pass`, `pi-hyper`, `pi-synthetic`, `pi-verboo`) used to catch an
unreadable source and return `undefined`, which is pi's "leave this provider's
models alone". A throw is what pi renders: it records the provider in
`ModelsRefreshResult.errors` and the model selector shows "Could not refresh
<provider>; showing cached models." Returning `undefined` instead told the
operator nothing and kept the previous list, which is the remembered lineup
docs/d190 exists to forbid. The two watchdogs already threw, so this makes the
family one policy; each of the four asserts it in its own suite.

## Consequences

- **`undefined` has no spelling in the published type.** `ProviderConfig.refreshModels`
  is typed `Promise<ProviderModelConfig[]>`, while the composer applies a
  returned list only when it is truthy — the behaviour d190 depends on cannot be
  expressed, so each entry casts its refresh function through `unknown` at the
  registration, with a comment naming the composer's truthiness check. A cast
  whose only content is "the host's declaration is narrower than its runtime" is
  the honest minimum; a returned `[]` would REPLACE the catalog with nothing.
- **A gate now needs a network install.** `./check-types.sh` reads six
  `node_modules` trees; on a host with no registry the pi entries cannot resolve
  their types, and the install path fails loudly with a `./dev-tools.sh pnpm`
  hint rather than skipping. The rest of the sweep (biome, oxlint, knip, ruff,
  ty, the text gates) stays offline.
- **Third-party shell now sits in the tree.** shellcheck's find prunes
  `node_modules` at any depth (pi-tui ships a `native/linux/build.sh`), and
  `.gitignore` covers the store and the trees; nothing else in the gates walks
  into them.
- **Six lockfiles.** `pnpm-lock.yaml` is per folder, ~1.1k lines each, because a
  copy unit carries its own lock; the resolution is identical in all six and the
  bytes are the devDependency's own graph, not this repo's choices.
- **The peer range still says `>=1.0.0`.** The devDependency is the version the
  types were checked against; the peer is the runtime contract with whatever host
  loads the package. The two answer different questions and both stay.

## Alternatives rejected

- **npm with six copies.** Plain and homogeneous with the root toolchain, and
  900 MB of duplicated 24 MB package for the privilege.
- **One root devDependency plus `paths` in `tsconfig.json`.** Cheaper still, and
  it makes every folder reference a parent — the dependency a copied-out folder
  cannot satisfy (docs/d113, docs/d082).
- **A local ambient `pi.d.ts` per folder.** Keeps the exclusion and the hand
  declarations: the type would be this repo's guess again, which is the problem.
- **Keep `.ts` entries.** They work through Node's type stripping, but a
  `.mjs` file needs no stripping and joins the JSDoc program; there is no second
  benefit to balance the extra loader behaviour.
- **`npm link` the folders into each other.** Crosses the boundary through
  `node_modules` instead of removing it: the gates would be green only on a host
  where someone had run a global command, and a copied folder would need a
  registry. Operator-side `pi -e ./pi-hyper` is the supported install path.

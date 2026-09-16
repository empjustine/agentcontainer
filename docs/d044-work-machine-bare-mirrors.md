---
id: d044
type: decision
status: implemented
title: "d044 — work-machine reference farm: OCDS clones to bare mirrors on the NTFS profile"
parent: architecture
tags: ["git", "references", "work", "ocds", "wsl2", "mirrors"]
---

# d044 — work-machine reference farm (OCDS → bare mirrors on NTFS)

`git/non-bare-issues.md` and `git/` solve the **home** machine: a farm of
public-forge full clones under `~/Downloads/references`, converted to bare
mirrors and kept pickaxe-fast. The **work** machine is a different animal, and
this record is its equivalent. The short version: the structural tooling
(`audit`, `migrate-to-bare`, `maintain-mirrors`, `search-references`) already
does not care which forge it walks, so the work farm reuses it unchanged; what
is genuinely new is (a) reading Oracle Developer Cloud Service (OCDS) remotes,
whose URLs are not `host/owner/repo`, and (b) putting the mirror storage
outside WSL2 on the Windows NTFS profile.

## Problem

The work machine is WSL2 under a tight disk budget. It is filled with ordinary
full clones that follow the operator's own layout:

```
<clone-root>/fabrikam-contoso/ANY_PROJECT/any_repo
```

They all point at one private **OCDS** tenant. Every clone's
`git remote get-url origin` is a rotating IDCS ssh identity, and the tenant
exposes the same repository through three unrelated URL shapes:

| shape | URL |
|-------|-----|
| ssh | `ssh://idcs-<id>.<email>@<host>/<projectId>/<repo>.git` |
| https | `https://<email>@<host>/<org>/s/<projectId>/scm/<repo>.git` |
| glass | `https://<host>/<org>/#projects/<slug>/scm/<repo>.git/tree?revision=main` |

Worked example (illustrative only — real shape, fictional tenant):

```
ssh    ssh://idcs-0123456789abcdef0123456789abcdef.you%40employer.example@fabrikam-contoso.developer.ocp.oraclecloud.com/fabrikam-contoso_fabrikam-contoso-cicd_7008/any_repo.git
https  https://you%40employer.example@fabrikam-contoso.developer.ocp.oraclecloud.com/fabrikam-contoso/s/fabrikam-contoso_fabrikam-contoso-cicd_7008/scm/any_repo.git
glass  https://fabrikam-contoso.developer.ocp.oraclecloud.com/fabrikam-contoso/#projects/fabrikam-contoso-cicd/scm/any_repo.git/tree?revision=main
```

The three encode one identity — `org=<org>, projectSlug=<slug>, repo=<repo>` —
with `projectId = <org>_<slug>_<numeric>`. The ssh form carries only the id,
the glass form only the slug.

The requirements are then exactly the home farm's, with two additions:

1. **Store only bare mirrors** — a checkout is pure overhead for reference and
   search material (`git/non-bare-issues.md` §1–3), and WSL2 disk is scarce.
2. **Store the mirrors outside WSL2**, on the Windows NTFS C: drive at
   `%USERPROFILE%` → `/mnt/c/Users/<you>/`. The point is to spend
   Windows disk, not the WSL2 ext4 VHD.

## Decision

### 1. Reuse the structural tooling verbatim

`audit.mjs`, `migrate-to-bare.mjs`, `maintain-mirrors.mjs` and
`search-references.mjs` discover repos by **shape** (`findCloneRoots` /
`findBareMirrors`) and read origins as opaque URLs. None of them assumes a
`github.com` host. The work farm is therefore the same commands with the work
roots:

```sh
export REFERENCES_ROOT=<work clone root>          # the existing full clones
export REFERENCES_MIRRORS=/mnt/c/Users/<you>/references-bare

./git/migrate.sh --delete-originals                # clones -> bare mirrors (NTFS)
./git/maintain.sh --root "$REFERENCES_MIRRORS"     # align + repack/commit-graph
./git/audit.sh --root "$REFERENCES_ROOT"           # anomalies before migrating
./git/search-references.sh index --root "$REFERENCES_MIRRORS" --only 'fabrikam-contoso/**'
```

Migration is what handles the already-cloned tree: it preserves each clone's
relative path, so `fabrikam-contoso/ANY_PROJECT/any_repo` becomes
`<dest>/fabrikam-contoso/ANY_PROJECT/any_repo.git`, and it captures the clone's
real origin URL onto the mirror. No URL rewriting is needed for the bulk path.

### 2. Decode OCDS remotes; acquire by identity

The one thing the home tooling cannot do is recognize the OCDS URL family, so
`git/ocds-remotes.mjs` supplies pure parsers/rebuilders:

- `parseOcdsRemote(url)` → `{ kind, host, org, projectId, projectSlug, repo, user }`
  for any of the three shapes (null otherwise, so non-OCDS falls through to the
  host-keyed path).
- `ocdsSshUrl` / `ocdsHttpsUrl` / `ocdsGlassUrl` rebuild the canonical spellings
  from an identity, so the same repo is addressable in whichever transport the
  host can authenticate.
- `ocdsMirrorRelPath` gives `<org>/<projectSlug>/<repo>.git`, the layout used
  when a repo is acquired from a URL rather than migrated from an existing clone.

`git/ocds-mirror.mjs` (shim `git/-ocds-mirror.sh`, the work sibling of
`-forge-mirror.sh`) consumes both: it accepts a clone directory or an OCDS fetch
URL, clones a bare mirror into `--dest`, and aligns an existing one with
`remote update --prune` — idempotent, one repo at a time. It deliberately does
NOT reimplement the bulk migration: `migrate-to-bare.mjs` is the many-repos
path, `-ocds-mirror.sh` the one-repo / not-yet-cloned path.

`audit.mjs` uses `ocds-remotes.mjs` to add an `ocdsRemotes` report section with
each mirror's `org / project / repo` and its glass-pane link, so the work
operator gets the human pointer the raw idcs URL never showed.

### 3. Default the work dest to the NTFS profile

`DEFAULT_WORK_DEST` in `ocds-mirror.mjs` is
`/mnt/c/Users/<you>/references-bare` (overridable by `$WORK_MIRRORS`
or `--dest`). `migrate-to-bare.mjs` keeps its generic `<root>-bare` default but
now warns when root and dest are on different devices, because the WSL2→NTFS
pair makes its `--local` hardlink optimization silently fall back to a full
copy (see caveats).

## Mapping home ↔ work

| concern | home (`git/`) | work (this record) |
|---------|---------------|--------------------|
| farm | `~/Downloads/references`, many public hosts | one OCDS tenant, clones under `<root>/<org>/<PROJECT>/<repo>` |
| acquisition | `-forge-mirror.sh <https-url>` keyed by host | `-ocds-mirror.sh <clone\|url>` keyed by OCDS identity |
| URL model | `host/owner/repo` | `org / projectSlug / repo` across 3 URL shapes |
| conversion | `migrate.sh` (unchanged) | `migrate.sh` (unchanged) |
| upkeep | `maintain.sh` (unchanged) | `maintain.sh --root <NTFS dest>` |
| search | `search-references.sh` (unchanged) | `search-references.sh --root <NTFS dest>` |
| storage | local ext4, `z,U` relabel is the cost | NTFS outside WSL2, disk is the cost |

## Enumerating the work tenant

"Initial mirroring" needs an inventory. There are two very different
situations, and only the second one needs discovery:

**Repos already cloned.** The clone tree *is* the inventory. `migrate-to-bare.mjs`
walks it structurally (`findCloneRoots`), and `audit.mjs` now emits every OCDS
identity it finds:

```sh
./git/audit.sh --root "$REFERENCES_ROOT" | jq -r '.ocdsRemotes[] | [.path, .repo, .https] | @tsv'
```

No SSH introspection and no robot are needed for this — it is the whole point
of the structural discovery inherited from `git/non-bare-issues.md`.

**Repos never cloned here.** Then you need to enumerate the tenant. The
git SSH endpoint cannot do it — Git's SSH transport only speaks
`git-upload-pack` / `git-receive-pack` for one named repo; there is no
"list repositories" verb, and `git ls-remote` requires a URL. A forge can bolt
an admin command onto SSH (Gerrit's `gerrit ls-projects`, GitHub's `ssh -T`
probe), but that is forge-specific and undocumented for this tenant, so it is
not a foundation to build on.

### HAR export + manifest seam

The maintainable split puts the authenticated half where the session already
lives: capture the tenant's responses in the browser as a HAR export, convert
it to a manifest, and mirror from the manifest. No shell replay, no secrets.

- **`git/vbs-har.sh`** — converts a captured HAR export into a normalized
  **manifest** (no credential). The app already made every authenticated call,
  so this route has no session, no CSRF, and no rolling-token handling.
- **`./git/-vbs-mirror-all.sh --manifest FILE`** — the durable half: reads the
  manifest, rebuilds any missing clone URL from the identity, and mirrors. No
  network, no session, deterministic — testable against a fixture.

The manifest is the stable seam:

```json
{ "generatedAt": "…", "base": "https://…", "org": "…",
  "repositories": [ { "projectId": "…", "projectSlug": "…", "repo": "…",
                      "httpsUrl": "…", "sshUrl": "…" } ] }
```

HAR clone URLs are userinfo-less, so `VBS_SSH_USER`/`VBS_HTTP_USER` is
injected when set.

## The realistic ladder

1. **Existing clones** — `./git/migrate.sh` (nothing else required).
2. **Never-cloned repos** — export the tenant's responses as a HAR (DevTools →
   Network, *Export HAR (with sensitive data)* so response bodies are kept),
   then `./git/vbs-har.sh capture.har --out vbs-manifest.json`.
3. **Mirror** — `./git/-vbs-mirror-all.sh --manifest vbs-manifest.json`. It
   mirrors into `<dest>/<org>/<projectSlug>/<repo>.git`; `--list` prints the
   plan without writing. HAR clone URLs are userinfo-less, so
   `VBS_SSH_USER`/`VBS_HTTP_USER` is injected when set.

The verified body schema (used by `vbs-har.mjs`):
`projects/list` is an array whose entries carry `identifier` (id), `urlId`
(slug) and `name`; `scm/api/repository` is `{"scmRepositoryList":[…]}` whose
entries carry `name` (with `.git`), `url` (https clone) and `alternateUrl`
(ssh clone). The `identifier` is `<org>_<slug>_<numeric>`, so the slug is also
derivable when `urlId` is absent.

## Caveats

- **The tenant rate-limits bulk cloning.** A failing mirror is retried with
  exponential backoff + jitter (`VBS_RETRIES`, `VBS_RATE_DELAY`,
  `VBS_BACKOFF_MAX`), the sweep is paced (`--throttle`, default 60 s), and a run
  of consecutive failures triggers a cooldown (`--cooldown`, default 60 s)
  before it keeps hammering the forge. Rate-limit/blocked signatures (403/429/
  throttled) and transient network/5xx errors are retried; a hard failure
  (404/real auth) is not. Nothing is silently dropped — the final summary
  reports the failure count.

- **No hardlinks across the WSL2/Windows boundary.** `git clone --mirror
  --local` hardlinks when it can and copies otherwise; ext4 → drvfs is always
  "otherwise". The first migration therefore writes a full second copy onto
  NTFS and is slower than the home run. `migrate-to-bare.mjs` warns up front; the
  `--redownload` path is no worse in this case.
- **NTFS is case-insensitive by default.** A repo with paths differing only in
  case can collide on checkout; bare mirrors have no working tree, so the
  object store is safe, but `repack`/`fsck` on such a repo is the edge to watch.
- **`/mnt/c` is slow for many small files.** Git on drvfs pays a 9p-style
  penalty versus ext4. `maintain.sh`'s `repack` + `commit-graph` over an
  NTFS-hosted farm is the price of keeping the objects off the WSL2 disk. Run
  maintenance with the default low `--jobs` (2) and expect it to be the slow
  step.
- **The mirror refspec prunes.** `clone --mirror` makes upstream the source of
  truth; a later `maintain.sh` DELETES refs upstream no longer has — including
  local-only branches on the source clones. These are **work** repos, so verify
  no un-pushed branch is being relied on before the first `maintain.sh`, and do
  not point it at a clone holding unpushed work (`git/non-bare-issues.md`
  carries the same warning for the home farm).
- **IDCS ssh identities rotate.** The ssh origin embeds `idcs-<id>.<email>`.
  Keeping the clone's ssh URL is fine while the identity is valid; `--transport
  https` rebuilds the remote as the email-only https form, which a credential
  helper can supply a fresh token for. Neither choice stores a secret — only the
  username.
- **`--delete-originals` is irreversible.** It frees the WSL2 disk the migration
  was meant to save, but the source clones are the only working copies. Run it
  only after verifying the mirrors (`--verify`).
- **podman `z,U` does not apply here.** The home farm's `1.6M files / ~39 s`
  startup cost was a *bind-mount* cost; the work mirrors live on NTFS and are
  never bind-mounted, so that specific pressure is absent.

## Not handled

Same list as `git/non-bare-issues.md` (submodule contents, Git LFS objects,
non-git trees), plus: Windows-side access to the mirrors is assumed to be
read-only tooling (WSL `git` owns the files; DrvFs permission mapping is not a
supported write path for another Git for Windows process).

## Verification record

- `ocds-remotes.mjs` decodes all three example shapes to the same
  `org/projectSlug/repo`; `ocdsHttpsUrl`/`ocdsSshUrl`/`ocdsGlassUrl` rebuild the
  input spellings (checked against the worked example above).
- `ocds-mirror.mjs` dry-run prints the derived target
  (`<dest>/<org>/<projectSlug>/<repo>.git`), the chosen
  origin, and the glass link; `git clone --mirror` is not exercised against the
  private tenant from here.
- `migrate-to-bare.mjs` `warnIfCrossFilesystem` fires on a synthetic
  same-host root/dest pair and stays silent for same-device paths.
- `-vbs-mirror-all.sh --manifest` is exercised against a fake `git`: a repo
  that fails twice with `429` is retried with backoff and then mirrors (3
  attempts); consecutive failures trigger the cooldown; a `not found` error is
  NOT retried; and `--list` performs no git work.
- `audit.mjs` emits the `ocdsRemotes` section for an OCDS-shaped origin and an
  empty one for a GitHub-shaped origin.
- `-vbs-mirror-all.sh` is exercised end-to-end against a fixture manifest,
  including the empty-field rows that exposed a `read` bug — tab is IFS
  *whitespace*, so an empty clone-URL column collapsed and shifted every later
  field; the extractors and loops now use the ASCII Unit Separator, which is
  not whitespace. `shellcheck -x` is clean.
- `vbs-har.mjs` is exercised against a captured HAR (535 entries, all
  200/204): it harvests the app's own response bodies (no replay, no CSRF) and
  emits exactly the manifest schema the shell half's `default_manifest_jq`
  consumes.

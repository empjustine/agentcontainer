---
id: oci-instance-principal-vault
type: research
status: findings — mechanism confirmed in Oracle documentation; live test blocked (this host is not an OCI instance and has no OCI CLI or Go toolchain)
title: "OCI instance principals + Vault: viability for removing credential files from instances"
parent: architecture
depends-on: [d046, d078]
references: [d108]
tags: ["secrets", "oci", "vault", "instance-principal", "security"]
---

# OCI instance principals + Vault

Assessment requested for the fleet's cloud instances: if an instance must
hold provider or tunnel keys at rest, can it obtain them without a hardcoded
credential on disk? This records what the mechanism is, what was verified,
how it would fit, and what could not be tested. It is the cloud half of the
question; [docs/self-hosted-workload-identity.md](self-hosted-workload-identity.md)
is the self-hosted half.

## Verdict

**Viable and recommended**, for OCI-hosted instances, as the *at-rest*
source of the secret-bearing estige config. It removes long-lived API keys
from instances entirely: the instance authenticates as itself, and a policy
lets it read only the named secrets.

It is **not** a universal replacement for `lib/environment.sh` (Infisical)
because it only works on OCI instances. The portable contract stays "a
`0600` file appears on the instance"; OCI Vault is one way to produce it.

**Live verification was not possible here.** This workstation is not an OCI
instance (see Evidence), so no instance-principal certificate exists and
the IMDS endpoint is unreachable. The mechanism below is confirmed from
Oracle's own documentation, not from a successful fetch on this host.

## What the mechanism is

1. **Instance principal.** The instance authenticates to OCI APIs with a
   certificate that the platform creates and rotates automatically. There
   is no user OCID, API key, or config file on the instance.
2. **Dynamic group.** A group whose members are defined by a matching rule
   over instance attributes (compartment OCID, instance OCID, or a defined
   tag), not by an explicit member list.
3. **Policy.** A policy statement grants the dynamic group a verb on a
   resource type in a compartment, optionally narrowed with a `where`
   clause:
   ```
   allow dynamic-group <group-name> to read secret-bundles in compartment <compartment> where target.secret.id = '<secret-ocid>'
   ```
4. **Fetch.** The instance calls the Vault/Secret Management API (or the
   CLI with `--auth instance_principal`) and receives the secret bundle
   content.

## Verified facts

| Fact | Status | Source |
|---|---|---|
| Instance principals use automatically created and rotated certificates; no user credentials or config file on the instance | confirmed | Oracle, *Calling Services from an Instance* |
| A dynamic group is defined by matching rules over `instance.compartment.id`, `instance.id`, or `tag.<namespace>.<key>.value`; syntax `any\|all { <cond>, ... }` | confirmed | Oracle, *Managing Dynamic Groups* / *Writing Matching Rules* |
| Policy can grant `read secret-bundles` scoped to a secret OCID with `where target.secret.id = ...` | confirmed | Oracle, *Calling Services from an Instance* (Vault example) |
| CLI supports `--auth instance_principal` and `OCI_CLI_AUTH=instance_principal` | confirmed | Oracle, *Calling Services from an Instance* |
| Go SDK supports `auth.InstancePrincipalConfigurationProvider()`; region can be read from IMDS | confirmed | Oracle SDK docs / examples |
| IMDS v2 requires the header `Authorization: Bearer Oracle`; instance document at `/opc/v2/instance/` | confirmed | Oracle, *Getting Instance Metadata* |
| Dynamic-group/policy changes take about one hour to propagate | confirmed | Oracle, *Managing Dynamic Groups* |
| An instance can belong to at most 5 dynamic groups; a tenancy can have at most 50 | confirmed | Oracle, *Managing Dynamic Groups* |
| A live end-to-end fetch succeeds on this repo's hosts | **not testable here** | host is not an OCI instance |

## What it buys, and what it does not

**Buys**

- No long-lived OCI credential on the instance: nothing to leak, rotate, or
  commit.
- Least privilege by construction: the policy names the secret OCIDs, and
  the dynamic group can be narrowed by compartment, instance, or tag.
- Rotation on the OCI side (new secret version) without touching the
  instance's identity.
- Auditability: Vault reads are IAM-audited against the instance principal.

**Does not buy**

- Portability. A laptop, a Termux device, or a non-OCI VPS has no instance
  principal; those hosts need another materialization source.
- Protection from a compromised instance. The instance can read the
  secrets it is entitled to; the mechanism removes *standing credentials*,
  not the instance's authority.
- A file on disk by itself. The fetch must write the file (or the process
  must hold it in memory), so the file needs `0600` and, where available,
  tmpfs — the secret still exists on the instance, just briefly and without
  a standing credential behind it.
- Protection from a mis-scoped policy. `read secret-bundles` on a whole
  compartment is broader than needed; scope by secret OCID.

## Fit with this repo

- **estige.** Fits a file-shaped credential surface exactly: a deploy-time or
  boot-time step writes the tunnel credentials to a `0600` file, and estige
  reads only files. estige itself stays free of cloud SDKs, which is the
  reason the fetch is a separate step rather than an in-process call.
- **coding-agent provider keys.** The same mechanism could materialize
  provider-key env or a keys file, but that would change the coding-agent's
  key path (`lib/environment.sh`/Infisical); treat it as a separate
  decision, not a rider on this one.
- **Non-OCI hosts.** Keep `lib/environment.sh`/`infisical run` for those;
  the output contract is still "owner-only file, then exec".
- **Which render shape** (see next section) matters because the repo's
  constraint is that estige is a small, dependency-free Go binary.

## Recommended shape

**Render outside estige; keep estige file-only.**

1. A small deploy step (shell on the instance, or a container init step)
   runs:
   ```
   oci --auth instance_principal secrets secret-bundle get \
     --secret-id "$SECRET_OCID" --stage CURRENT \
     --query 'data."secret-bundle-content".content' --raw-output | base64 -d
   ```
   and writes the result to a `0600` file (or to a tmpfs path) that the
   launcher points the env chain at.
2. The non-secret structure has no file of its own: estige reads no config
   file since d108's tree-shake, and docs/d104's role store (`exit.json` +
   `prv/<role>/`) is where the policy and the key material will live.
3. A startup guard refuses a group/world-readable config.

Why not resolve inside estige:

- Adds the OCI Go SDK (and its auth/IMDS machinery) to the proxy for one
  startup fetch.
- Makes every non-OCI deployment carry an unused code path.
- The fetch is a deployment concern (where the vault is, which OCID), not a
  proxy concern.

Why not the CLI as the only option:

- The CLI is convenient for a shell render step and is the fastest way to
  prove the mechanism on a real instance.
- If the image must not carry the CLI, a ~100-line Go helper using
  `InstancePrincipalConfigurationProvider` produces the same file.

## Live test plan (when an OCI instance is available)

```bash
# 1. Confirm the instance document (region, compartment, instance OCID).
curl -sS -H 'Authorization: Bearer Oracle' \
  http://169.254.169.254/opc/v2/instance/ | jq '{region, compartmentId, id}'

# 2. Create a dynamic group whose rule names this instance (or its tag).
#    Example rule: instance.id = 'ocid1.instance.oc1..xxxx'
#    Allow ~1 hour for propagation.

# 3. Policy (scoped to the one secret):
#    allow dynamic-group estige-vault-readers to read secret-bundles \
#      in compartment <compartment> \
#      where target.secret.id = '<secret-ocid>'

# 4. Fetch with the instance principal.
oci --auth instance_principal secrets secret-bundle get \
  --secret-id "$SECRET_OCID" --stage CURRENT \
  --query 'data."secret-bundle-content".content' --raw-output | base64 -d

# 5. Negative test: fetch a secret outside the policy and confirm 404/403.
# 6. Write the rendered config 0600, start estige, confirm the tunnel
#    handshake with d104 credentials.
```

Success criteria: step 4 returns the secret without any OCI config file or
API key on the instance; step 5 is denied; the rendered file is `0600`;
estige starts and completes a tunnel handshake using only file-sourced
credentials.

## Risks and limits

- **Propagation delay** (~1 hour) after dynamic-group or policy changes
  makes IAM changes slow to debug; plan for it in rollout.
- **Group quotas** (5 per instance, 50 per tenancy) are ample here but
  worth knowing if the fleet grows.
- **Policy breadth.** The `where target.secret.id` narrowing is not
  optional in practice; a compartment-wide grant would let any matching
  instance read every secret there.
- **File lifetime.** A rendered file persists until the instance is
  rebuilt unless it is on tmpfs. Prefer tmpfs and re-render on boot.
- **IMDS dependency.** The instance must reach `169.254.169.254`; the
  relay node's restricted network is a risk if egress rules block link-
  local metadata. The exit node is the natural place to run the fetch.
- **Not tested here.** The mechanism is documented, not exercised in this
  repo; the test plan is the gate before relying on it.

## Evidence: why this host could not be tested

- DMI product `MS-7A38`, vendor Micro-Star International (an MSI desktop
  board, not a cloud instance).
- `http://169.254.169.254/opc/v2/instance/` and `/opc/v2/identity/`
  (with the Oracle bearer header) timed out; AWS IMDS timed out as well.
- No OCI environment variables, and no `oci`, `go`, `podman`, or
  `docker` on `PATH`; only `curl` was available.
- Consequently the commands above are transcribed from Oracle's docs and
  syntax-checked by reading, not executed end to end.


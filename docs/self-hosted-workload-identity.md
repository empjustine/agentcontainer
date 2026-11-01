---
id: self-hosted-workload-identity
type: research
status: findings — mechanisms confirmed in vendor/kernel/project documentation; nothing implemented or exercised (this workstation has no TPM device and no `swtpm`/`qemu`/`tailscale`)
title: "Self-hosted workload identity: granting credentials because a VM lives on a trusted hypervisor in a trusted network"
parent: architecture
depends-on: [d046, d078]
references: [d108]
tags: ["secrets", "attestation", "tpm", "vtpm", "confidential-computing", "self-hosted", "security"]
---

# Self-hosted workload identity

## Question

OCI instance principals work because the cloud runs the identity machinery: the
instance gets a certificate nobody typed in, and a policy decides what that
certificate may read ([docs/oci-instance-principal-vault.md](oci-instance-principal-vault.md)).
Self-hosted VMs have no such authority. The proposed substitute is:

> grant dynamic credentials because the workload lives in a specific VM on a
> **trusted hypervisor**, in a **trusted network**.

This records what that would actually require, which mechanisms exist, and
where each one's trust actually roots — verified against primary documentation,
but **not exercised** (nothing to test on: no TPM device, no `swtpm`, no
`qemu`, no `tailscale` binary on this workstation).

## Verdict

**The shape is achievable, but "trusted hypervisor" and "trusted network" are
not two independent factors — only the first can ever be one, and only if it
has a hardware root.**

- A **trusted network is not an identity.** Reachability (VLAN, route, IP, MAC,
  802.1X port) is a property of the path, not of the workload: any VM that can
  reach the broker can claim any address it is allowed to configure. Network
  position can *scope* a grant; it cannot *be* the grant.
- A **trusted hypervisor is the real root** — but its strength is exactly the
  strength of what it refuses to lie about: a vTPM's state, a measured boot, a
  TEE measurement. Without one of those, "this VM is on my hypervisor" is a
  statement by the hypervisor operator, enforced by config, not by
  cryptography.
- The practical consequence: on self-hosted hardware you can get a **one-shot
  bootstrap then short-lived credentials** cheaply, and a **hardware-attested
  identity** only with a vTPM plus measured boot plus a verifier (or SEV-SNP/
  TDX hardware). There is no middle path that removes the bootstrap secret
  without hardware.

## What any grant must supply

Every scheme — cloud or self-hosted — is the same four pieces:

1. **An identity root** the issuer can name: a TPM endorsement key, a TEE
   measurement, a certificate, a node key.
2. **A proof** the requester holds that root *now*: a TPM quote over fresh
   nonces, an attestation report, a signature.
3. **A verifier** with reference values and a policy: which roots are
   admitted, which measurements are current.
4. **An issuer** that mints a short-lived credential scoped to the verified
   identity, plus a renewal path.

OCI supplies 1–3 as infrastructure. Self-hosted means supplying all four, and
the weakest link decides the answer — usually piece 1.

## The anchors, ranked by what they actually prove

### SEV-SNP / TDX — hardware-attested guest measurement

The guest asks the platform for a signed report over its own measurement:
`SNP_GET_REPORT`/`SNP_GET_EXT_REPORT` on SEV-SNP (the report is produced by
the SEV-SNP firmware via `SNP_GUEST_REQUEST`, with certificate data supplied
by the hypervisor through `SNP_SET_EXT_CONFIG`), `TDX_CMD_GET_REPORT0` for a
TDREPORT on TDX. The report verifies against AMD/Intel roots; the measurement
covers the launched image, so the verifier learns *which code* is asking, not
just *which VM*.

This is the strongest anchor and the most expensive: it needs the CPU
generation, firmware, and a verifier that fetches vendor collateral. It is
also the only anchor where the hypervisor cannot forge the guest's identity
(though it still chooses which image to launch, and on SNP supplies the cert
blob).

### vTPM + measured boot + a verifier (Keylime) — the open-source workhorse

QEMU/libvirt can give a VM a TPM: `<tpm model='tpm-tis'><backend
type='emulator' version='2.0'>` runs `swtpm`, optionally with an
`encryption secret=` for the state and explicit `active_pcr_banks`. With
measured boot (OVMF), the guest's PCRs describe what it booted; Keylime is the
mature end-to-end system — its **Registrar** records agents and vendor TPM
keys, its **Verifier** checks PCR policies continuously and can enable IMA
runtime integrity monitoring, and its **Agent** releases an encrypted payload
"once trust is established". That payload is precisely a credential bundle, and
re-release on re-attestation is precisely rotation.

Two caveats decide whether this is real:

- **Where the EK roots.** A vTPM's endorsement key is only as trustworthy as
  whoever signed its certificate. `swtpm_setup` can generate one
  (`--create-ek-cert`, `--create-platform-cert`), which means the chain roots
  in **the operator**, not a TPM vendor — so the verifier's trust bundle is a
  local CA you enrolled, and a compromised hypervisor can mint another VM with
  the same kind of EK. Hardware TPM passthrough or a vendor-provisioned cloud
  vTPM is what restores a vendor root.
- **vTPM state is a file.** On `swtpm` the VM's TPM state lives on the host;
  anyone who can read it can clone the identity. That is not a defect of the
  design, it is the definition of the trust boundary: you are trusting the
  hypervisor host.

### Hypervisor-injected one-shot bootstrap — the cheap honest tier

The hypervisor can hand the guest a secret at first boot (cloud-init user-data,
`fw_cfg`, an SMBIOS string, a serial channel) which the guest exchanges once
for a short-lived credential, then discards. The hypervisor's own config
becomes the secret store.

What it buys: no *standing* credential inside the VM, and a place to revoke.
What it costs: a secret still exists at provisioning, renewal needs a channel
(the guest agent, or re-injection and a reboot), and the hypervisor's config
handling is now security-critical. It is strictly better than a long-lived key
copy-pasted into the image, and strictly weaker than attestation.

### Network identity — a key file by another name

The fleet already has a network with identities: tailnet nodes. `tsnet`
creates a node per service and authenticates with an auth key or an interactive
login, keeping its state (including the node key) in a state directory; a
broker can call `tailscale whois` on the source address to learn which node is
connecting and allow/deny from that. WireGuard peer keys work the same way.

This is a real improvement over an allowlisted IP, and it composes with a
policy layer (a tailnet ACL already expresses "this node may reach that
service"). But it is **not** hardware attestation: the node key is a file on
the VM, so a copied state directory is a copied identity, and the broker trusts
the tailnet control plane to have authenticated the node. It replaces a
credential file with a node-key file — worth doing when the tailnet is
already the trust boundary, not when the goal is "no keys on the box".

### Not identity at all

MAC address, IP, hostname, DMI/system serial, `machine-id`, SSH host key,
cloud-init metadata *as a claim of provenance*: all are either spoofable by the
guest or clonable with the disk. They are labels and routing hints. A design
that says "trusted network ⇒ trusted workload" has quietly promoted one of
these to a credential.

### The bootstrap problem, restated

SPIFFE/SPIRE shows the shape of a good answer and its limit: it issues
short-lived SVIDs, but its node attestors still need a root — `tpm_devid`
requires DevID certificates provisioned out of band *and* a TPM manufacturer CA
trust bundle, `join_token` is a bootstrap secret, `x509pop` takes a
provisioned certificate. Attestation frameworks move the root; they do not
remove it.

## Why "trusted hypervisor" cannot be stronger than the hypervisor

Every mechanism above terminates in the operator's willingness to be held to
its own configuration:

- the hypervisor can read or clone a `swtpm` state file;
- it chooses the image it launches (SNP/TDX measurement is honest about *what*
  was launched, not about whether that was the right thing);
- it supplies the SNP certificate blob and the TDX collateral path;
- it holds the bootstrap secret in the cheap tier.

So the requirement is real but should be stated honestly: *credentials are
granted to a VM whose boot the platform can prove, on a hypervisor whose
operator is trusted not to re-point that proof at another VM.* Hardware roots
(vendor EK, SEV-SNP, TDX) narrow what the operator can fake; nothing removes
the operator from the trust set.

## What it would take for this fleet

Present state: no TPM device on the workstation (`/dev/tpm*` absent), no
`swtpm`/`qemu`/`tailscale` available to exercise anything, so the tiers
below are documentation-verified only.

- **Tier 0 — do nothing new.** Cloud hosts use instance principals (the other
  study). Self-hosted hosts keep the `lib/environment.sh` vault chain: one
  vault round-trip, plain env to the child. This is a standing credential, and
  it is the current baseline.
- **Tier 1 — one-shot bootstrap + short-lived credential.** Requires: a
  provisioning path that injects per-VM material (cloud-init/fw_cfg), a small
  issuer that validates the one-shot and mints a scoped credential with a TTL,
  and a renewal path (guest agent or restart). No TPM, no verifier, days of
  work. Removes the long-lived secret from the image; keeps a provisioning
  secret in the hypervisor config.
- **Tier 2 — vTPM + measured boot + Keylime.** Requires: a vTPM per VM
  (`swtpm` via libvirt), measured-boot firmware, reference PCR values per
  image, a Registrar/Verifier deployment, EK enrolment into the verifier's
  trust bundle, IMA enforcement if runtime integrity matters, and an agent that
  renews on attestation. Weeks of work plus an operational dependency, and the
  vendor-root gap above means the enrolled EK is the real anchor.
- **Tier 3 — SEV-SNP/TDX.** Requires hardware. Not available here (desktop
  board, no TPM at all), and not a prerequisite for Tiers 1–2.
- **Parallel, cheapest real improvement — network identity as the scope.** If a
  broker already sits behind the tailnet, authorizing by node identity
  (`whois` + ACL) is a small change that removes IP allowlists and gives a
  revocable principal name. It does not remove a key from the VM.

## Recommendation

Do not build hypervisor attestation for this fleet now. The order of value is:

1. keep cloud instances on instance principals — that is the only place where
   the identity root costs nothing to operate;
2. for self-hosted hosts, stop treating "in the trusted network" as a
   credential, and if the standing vault credential is the problem, implement
   Tier 1 (one-shot bootstrap + TTL) — it is the smallest change that removes
   the long-lived secret;
3. treat Tier 2 as a project with an owner (vTPM, measured boot, verifier, EK
   enrolment), and Tier 3 as hardware-gated.

The honest summary for the original framing: a **trusted network** can scope a
grant, and a **trusted hypervisor** can root one — but only with a hardware
anchor, and even then the operator stays in the trust set.

## Sources

- Linux kernel, *SEV-SNP guest API* — `SNP_GET_REPORT`, `SNP_GET_EXT_REPORT`,
  `SNP_SET_EXT_CONFIG` (`docs.kernel.org/virt/coco/sev-guest.html`).
- Linux kernel, *TDX guest API* — `TDX_CMD_GET_REPORT0` / TDREPORT
  (`docs.kernel.org/virt/coco/tdx-guest.html`).
- libvirt, *Domain XML format — TPM device* — `<backend type='emulator'
  version='2.0'>`, `encryption secret=`, `active_pcr_banks`
  (`libvirt.org/formatdomain.html`).
- Keylime — Registrar / Verifier / Agent, TPM 2.0, PCR policies, IMA runtime
  monitoring, payload released on trust (`github.com/keylime/keylime`).
- `swtpm_setup(8)` — `--create-ek-cert`, `--create-platform-cert`,
  `--lock-nvram` (`manpages.debian.org`).
- `systemd-creds(1)` — `--with-key=host|tpm2|host+tpm2`, AES256-GCM,
  `--tpm2-pcrs=`, `LoadCredentialEncrypted=` (freedesktop.org). Relevant as
  **at-rest** protection for a secret you already have, not as an issuer: it
  binds ciphertext to a TPM/host key, which on a vTPM still means the
  hypervisor can decrypt.
- Tailscale, *tsnet* — node creation, auth key or interactive login, state dir
  (`tailscale.com/docs/features/tsnet`); `tailscale whois` for source-address
  identity.
- SPIFFE/SPIRE node attestors — `tpm_devid` prerequisites (DevID CA + TPM
  vendor CA, out-of-band provisioning), `join_token`, `x509pop`
  (`github.com/spiffe/spire/doc/`).
- OCI instance principals — see [docs/oci-instance-principal-vault.md](oci-instance-principal-vault.md).

## Verified status

| Claim | Status |
| --- | --- |
| SEV-SNP/TDX expose guest report ioctls usable by an in-guest verifier client | confirmed in kernel docs |
| libvirt can attach an emulated TPM 2.0 (`swtpm`) to a QEMU guest | confirmed in libvirt docs |
| Keylime verifies PCR policies and releases an encrypted payload on trust | confirmed in project docs/README |
| `swtpm` EK certificates can be locally created (operator-rooted) | confirmed in `swtpm_setup(8)` |
| `systemd-creds` binds ciphertext to TPM2 and/or host key, with PCR binding | confirmed in `systemd-creds(1)` |
| Tailscale nodes authenticate with an auth key or login and keep node state on disk | confirmed in Tailscale docs |
| SPIRE's TPM node attestor requires out-of-band DevID provisioning + vendor CA | confirmed in SPIRE plugin docs |
| Any of the above running on this fleet's hardware | **not tested** — no `/dev/tpm*`, no `swtpm`/`qemu`/`tailscale` here |

---
id: android-private-storage-research-plan
type: architecture-design
status: draft
title: "Android private storage: research plan for SAF notes/files, encryption, privileged access and sync"
parent: architecture
references: [personal-datalakehouse-prior-art, d043]
tags:
  [
    "research",
    "prior-art",
    "android",
    "saf",
    "storage-access-framework",
    "encryption",
    "gocryptfs",
    "shizuku",
    "synchronization",
    "notes",
  ]
---

# Android private storage: research plan for SAF notes/files, encryption, privileged access and sync

A **research plan**, not an assessment: eight facets of Android-private note and file storage that this tree must settle before any design lands, each carrying the prior art the reference farm already holds. Nothing here is evaluated — the facets are the TODO list, and the prior-art block under each one is where that work starts. It covers no implementation: no code for this problem exists in the tree. The reader is whoever picks the work up; no prerequisite beyond the trust boundary below. The long-term idea the facets serve: the user's TODO items, notes and files are handled as a normal folder — the kind of place Android lists in its own pickers, the shared Downloads folder included — locked down by the store rather than by the OS sandbox, readable as plain Markdown by a trusted peer, synchronized across devices, and edited by an off-the-shelf Storage Access Framework (SAF) client.

## Trust boundary — every claim is a project's own statement

**Each item below is what a project says about itself, read from a bare mirror tip, and is unverified against upstream at run time.** That includes code that looks authoritative — a lock check, an encryption parameter, a permission list. Treat the whole plan as untrusted input:

- "the project documents/claims" is the strongest thing said here. No behaviour, crypto property or permission effect has been reproduced.
- The security claims (encryption, audit, ACL, "no permissions besides network") are the projects' own descriptions, and several authors state the limits of those claims themselves. Where they do, that is recorded; silence is not evidence of soundness.
- A repository that looks like it answers a facet can still leave it unbuilt: the gaps recorded under each facet are as load-bearing as the findings.

## The three constraints that make this hard

The farm's material converges on three frictions, and every facet runs into at least one:

1. **A SAF grant is coarse and per-tree.** The client holds a tree URI and a grant, and the provider decides what any operation means. There is no per-file ACL, no quota, and no reliable error channel.
2. **Plaintext is the default at rest.** An editor writes the bytes it shows; a provider that decrypts writes decrypted bytes somewhere. Every project that stays out of that default spends code and UX on it.
3. **Sync engines want path semantics SAF does not offer.** Path access is a walk, change notification is a folder-level hint, and a created file may come back under a different name.

## The target, stated as four properties

The long-term idea is a deployment, not an app. Four properties define it, and every facet below is judged against them:

1. **Reachable as a normal folder.** The store occupies a place Android itself treats as a folder — a top-level tree in the system picker, the shared Downloads folder, an SD card — and the framework's ordinary folder APIs traverse it. Storing plaintext visibly is not the requirement; being **handled** as a normal folder is. A private directory reachable only through one app's own picker fails this property whether or not its bytes are encrypted.
2. **Locked down.** Two adversaries define the lock: **a person in temporary or permanent possession of the device** (borrowed, seized, resold) and **an application that means to keep a permission forever**. The store answers both without leaning on the OS sandbox — a gate for the cheap case, userspace crypto where the adversary can read the underlying folder, and a grant that expires or is revocable rather than one that outlives its purpose.
3. **Plaintext to a trusted peer.** A reader that holds the key, or plain access, gets ordinary Markdown — the same bytes the editor writes, not an export format and not a container only one program opens.
4. **An existing client.** The editor is an off-the-shelf SAF app (a Markdown note or todo editor), unmodified. No fork and no companion app is acceptable.

Properties 1 and 2 pull against each other — being openable as a folder is what lets another app read the store, and that same reach is what the lock must survive — and SAF's grant model supplies neither half: a grant is per client and per tree, so it neither puts the store among the normal folders nor keeps it locked. Properties 3 and 4 rule out the usual answer to 2, a private container that only its own app can read.

## Facet 1 — SAF access control: what a grant actually buys

### To settle

- [ ] Map the grant surface: `ACTION_OPEN_DOCUMENT_TREE`, `takePersistableUriPermission`, the cap on persisted grants, and the events that revoke one (force-stop, uninstall, clear data, provider change, OS upgrade).
- [ ] Treat the persisted grant as the adversary's asset, not a convenience: how long a client holds one across update, force-stop, reboot and backup restore, what the user can revoke, and whether a provider can shorten or bind it. "Permission forever" is a property of this mechanism.
- [ ] Separate what the framework enforces from what the provider enforces: can a provider refuse a granted URI per operation, and what does a client see when it does?
- [ ] Establish whether SAF carries any **resource control** — quota, size ceiling, rate limit, per-tree accounting — or whether every limit is a provider's own invention.
- [ ] Read the AOSP provider path (`packages/apps/DocumentsUI`, the framework's `DocumentsProvider`). It is absent from the farm, so the gate rests on client code and two third-party providers.

### Prior art

- **Anemo** (`2bllw8/anemo`) is the farm's only provider whose ACL is a policy of its own rather than a grant: a lock flag gates every operation, and while locked each call throws `AuthenticationRequiredException` carrying an unlock intent (`.anemo/documents/provider/AnemoDocumentProvider.java`). The lock is soft by construction — files sit in `getFilesDir()/anemo` (`documents/home/HomeEnvironment.java`), the password is an unsalted SHA-256 digest in `SharedPreferences` (`lock/LockStore.java`), and `SECURITY.md` states the real control is the OS: file-based encryption protects the directory, an `adb`/root shell reads it anyway.
- **RSAF** (`chenxiaolong/RSAF`) is a provider over rclone remotes. Its config is encrypted under a hardware-wrapped key, so a root-level backup restore fails by design; the Android-backup opt-in is off by default because it would ship the rclone config in plaintext.
- **DroidFS** (`tangled.org/cipherd.arkensys.dedyn.io/DroidFS`) makes provider exposure of a decrypted volume an explicit unsafe feature, gated behind disabling auto-lock, with a separate switch for write access (`content_providers/VolumeProvider.kt`).
- **Provider-side limits**, from RSAF's own list: `ProxyFileDescriptorCallback` supports only `lseek`/`read`/`pread`/`write`/`pwrite`/`fsync` (no `ftruncate`), `close()` is asynchronous under FUSE, and a listing error cannot be distinguished from an empty directory.
- **Absent**: AOSP's provider implementation, so the claim "the framework bounds X" has no mirror to check it against.

## Facet 2 — Where plaintext lands

### To settle

- [ ] For each candidate architecture, enumerate every place a decrypted byte can land: provider-internal storage, app cache, `/sdcard` export, the temp file a share target hands to a consumer, the rclone VFS on a write.
- [ ] Decide whether "plaintext never leaves the provider process" is reachable on Android at all, and what it costs (memory export, fd passing, size ceiling).
- [ ] Check the share/export path for residue: what removes a temp file when the consumer crashes.

### Prior art

- **DroidFS** names the trade: an export goes through memory first, and falls back to a plaintext temp file in internal storage when the file is too large or the consumer needs a path. Export, share-via-menu and write-access are three separate unsafe switches, and the README states that other apps "could save and send the files thus shared".
- **PlaneTxt** (`brvier/PlaneTxt`) is plaintext by design: Markdown into the tree the user picks, no database, no account, no network.
- **Anemo** keeps plaintext in app-private storage and exposes it only through its provider; its import path is a share receiver writing into that provider.
- **RSAF** documents that rclone answers a random write by downloading and re-uploading the whole file, which is `rclone mount --vfs-cache-mode writes` behaviour.

## Facet 3 — Encryption in userland: gocryptfs and its neighbours

### To settle

- [ ] Weigh gocryptfs's audit and test story against its maintenance surface: the audit is dated March 2017, so what has changed since, and what does the changelog's bug list say about the steady state (truncate corruption, reverse-mode name corruption, symlink races)?
- [ ] Decide the format question: a gocryptfs-compatible overlay (DroidFS in-process, Termux plus `gocryptfs` under proot, RSAF over a `crypt` remote), or a format of the design's own.
- [ ] Trace the key path on a phone: scrypt cost at unlock, Keystore-wrapped key versus passphrase, and what a locked screen, a process kill or a reboot does to an open volume.
- [ ] Find the FUSE story on Android without root — the reason DroidFS is an explorer rather than a mount.
- [ ] Verify what the farm cannot: Cryptomator, CryFS and VeraCrypt are absent as repositories. DroidFS names CryFS as a supported backend, so the CryFS statement is DroidFS's, not CryFS's.
- [ ] Decide what platform encryption already covers — Android file-based encryption on a CDD-compliant device, per Anemo's threat model — before adding a second layer.

### Prior art

- **gocryptfs** (`rfjakob/gocryptfs`): a Go FUSE overlay and EncFS's security successor. AES-GCM for contents, EME with a per-directory `DirIV` for names, AES-SIV in reverse mode for deterministic names, scrypt as the KDF, an 18-byte header and 32 bytes of overhead per 4 KiB block. It passed an external audit in March 2017 (defuse.ca), passes the xfstests generic suite with one exception, signs tags from v0.4, and carries `-fsck`, `-sharedstorage` byte-range locking for concurrent mounts, and `-longnamemax` for storage with path limits. Structural limit: one ciphertext file per plaintext file, so the shape of the tree and the approximate sizes are what the wrapped storage sees.
- **DroidFS**: gocryptfs and CryFS through in-process libraries behind its own explorer, so no mount is needed. Fingerprint unlock wraps the volume password hash under an AES-256-GCM Keystore key; volumes auto-lock when the app leaves the foreground; the disclaimer states the app cannot protect against screen recorders, keyloggers, a compromised root or memory dumps.
- **rclone `crypt`** (`rclone/rclone`): NaCl SecretBox (XSalsa20 + Poly1305) over 64 KiB chunks with a 32-byte key derived from a password, names encrypted by default, the password "lightly obscured" in the config unless configuration encryption is enabled. Round-Sync markets exactly this as its "256 bit encryption".

## Facet 4 — A guarded folder handled as a normal one: Shizuku's part in a safe store

### To settle

- [ ] Determine what Shizuku widens: which system services a Shizuku-held binder reaches, and whether any of them grants file-level access outside a SAF grant.
- [ ] Check ADB's permission set per Android version and what it means for `/sdcard/Android/data` and `/sdcard/Android/obb` on 11 and later.
- [ ] Separate the routes to a folder the user already browses — a SAF grant on that tree, `MANAGE_EXTERNAL_STORAGE`, a Shizuku/ADB binder, GrapheneOS storage scopes — because each has a different review story.
- [ ] Establish what makes the shared **Downloads** tree a normal folder rather than a privileged one: the scoped-storage split (MediaStore collections, DownloadManager ownership, the `Documents/` and `Android/media/` exceptions), and which of those a store living in Downloads can lean on.
- [ ] Keep **reach** and **lock** apart in the design: reach decides who can see the folder, the lock decides who can read the files, and no farm project combines the two.
- [ ] Frame the Shizuku question as handling, not reading: the prior art exists so a privileged folder such as Downloads is reached through the same traversal and write APIs as an ordinary folder, so a store can live there. Settle which binder-supplied operations that needs, and whether a provider can hold them without becoming a privilege-escalation surface.

### Prior art

- **Shizuku** (`RikkaApps/Shizuku`) is in this plan for one reason: it lets an app treat a folder the framework otherwise guards (Downloads, `Android/data`) the way it treats its own folder. Mechanically: a server process started with root or ADB; the app receives a binder to it and the server forwards calls to the system server, so the app-side code looks like a normal API call. Its README states the limits plainly: ADB's permission set is smaller than root's and varies by release, hidden-API use is restricted from Android 9, and API 26 lacks the observer ADB needs.
- **SD Maid SE** (`d4rken-org/sdmaid-se`) models privilege as a backend: an `AdbBackend` enum with `PORTER` and `SHIZUKU`, behind a capability layer rather than a root check (`app-common-adb/…/shizuku/AdbBackend.kt`).
- **Termux** (`termux/termux-app`) takes the other route: `MANAGE_EXTERNAL_STORAGE` declared with `tools:ignore="ScopedStorage"`, i.e. all-files access instead of a grant, plus a runtime request path in `termux-shared`.
- **RSAF** asks for `MANAGE_EXTERNAL_STORAGE` only so a wrapper remote (`crypt` over a local directory) can read `/sdcard`; SAF stays the app-facing door.
- **Absent**: the unbuilt shape is the combination, not the privilege. **RSAF** widens what SAF can reach but keeps the namespace the provider's own, so no normal folder is involved; **Termux** and **SD Maid** reach the guarded folders with no lock at all; **Anemo** locks but inside a private directory, so no file manager and no peer sees the files. Each project holds one half of the target, and none holds a normal-folder position and a store-owned lock at once — which makes this facet a design question rather than a precedent to copy.

## Facet 5 — The editor that must work unchanged, and the share target

### To settle

- [ ] Name the editor X and make "runs unmodified against the store" the acceptance test: no fork, no companion app, no provider-specific setting.
- [ ] Establish what the provider owes X: the exact `DocumentsContract` calls X makes, and the provider behaviours X relies on (`FLAG_SUPPORTS_RENAME`, document-id stability across rename, cursor columns, a `content://` write mode).
- [ ] Catalogue the write paths across candidate editors: temp-write plus rename versus in-place, and how each app copes with a provider that refuses `renameDocument`.
- [ ] Establish the change-notification problem: what a provider is obliged to emit, and how a client learns of an external write.
- [ ] Compare the file layouts — a Markdown file per day plus a notes tree (PlaneTxt), org-style pages (Logseq), a per-device key-value log (DecSync) — against what a sync engine can merge.
- [ ] Determine the share-target contract that keeps plaintext out of the cache: what an app must do with `EXTRA_STREAM` and a consumed `content://` URI.

### Prior art

- **PlaneTxt** (`brvier/PlaneTxt`) is the leading candidate for X and the farm's most complete SAF client: `SafFileStoreHandler.kt` takes the persistable grant, walks trees with `DocumentsContract.buildChildDocumentsUriUsingTree`, rewrites a file only when the provider advertises `FLAG_SUPPORTS_RENAME` and `FLAG_SUPPORTS_DELETE` (otherwise in place), and repairs an interrupted swap from leftover temps on the next listing. Its README claims atomic writes, external edits picked up, and a line-by-line conflict view when a file changed on two devices.
- **Logseq** (`logseq/logseq`) is the second candidate, with a folder picker over `ACTION_OPEN_DOCUMENT_TREE` and a `DocumentsContract` doc-id resolver for the Android shell (`android/app/src/main/java/com/logseq/app/FolderPicker.java`, `FileUtil.java`).
- **DroidFS** shows the reverse direction: the same file set reaches other apps only through an opt-in provider, so the app is both editor and provider.
- **Anemo** is the share-target shape: a `ReceiverActivity` that imports shared content into its own provider, so the receiving store never needs a grant of its own.

## Facet 6 — Synchronization engines over the same tree

### To settle

- [ ] Compare the transport shapes: continuous peer sync (Syncthing), polled remote through an rclone-backed provider (RSAF), an operation log in a synced directory (DecSync), DAV (pimsync), rsync (syncopoli).
- [ ] Measure what each one costs on a SAF tree. BasicSync's documented penalties are the baseline to beat.
- [ ] Decide conflict semantics and the naming that survives them: `.sync-conflict-` copies, a line-level picker, or timestamp-based last-writer-wins.
- [ ] Check what survives a sleeping device: foreground service, boot restart, battery optimization, Android 12's child-process restrictions.
- [ ] Establish whether the sync engine ever sees plaintext: a remote-side encryption layer (rclone `crypt`) keeps the local tree plaintext, an overlay keeps the synced tree ciphertext.

### Prior art

- **Syncthing** (`syncthing/syncthing`) sets the goal order — safe from data loss first, secure against attackers second — and names conflicts mechanically: `name.sync-conflict-20060102-150405-<device>.ext` (`lib/model/folder_sendrecv.go`).
- **BasicSync** (`chenxiaolong/BasicSync`) is the SAF bridge, and its README is the cost sheet. It runs Syncthing as a library in the main process (immune to Android 12's child-process rules), adds a custom `saf` filesystem whose init path is a URL-encoded tree URI plus subpath, and states the penalties: path access is a walk of every parent, change events are folder-level so a change forces a folder rescan, a created file may come back as `file (1).txt`, and errors are likelier. It recommends direct file access over SAF, and points GrapheneOS users at storage scopes. SAF support is the app's, not Syncthing's — a config exported to another Syncthing app loses it.
- **RSAF** is the inverse bridge: a SAF facade over rclone remotes, so any SAF client syncs through rclone's backends without knowing it.
- **Round-Sync** (`newhinton/Round-Sync`) is rclone's Android GUI: cloud remotes, crypt remotes, streaming over FTP/HTTP/WebDAV/DLNA, SAF for SD and USB, and an intent service for third-party tasks.
- **DecSync** (`39aldo39/DecSync`) needs no server: every device writes only its own subdirectory inside a synced directory, so files never collide, and per-key timestamped entries resolve the remaining conflicts last-writer-wins.
- **pimsync** (`git.sr.ht/~whynothugo/pimsync`) is vdirsyncer's successor, with the algorithm in a `vstorage` library: calendars and contacts between CalDAV/CardDAV and local vdirs.
- **syncopoli** (`gitlab.com/fengshaun/syncopoli`) is rsync on Android with profiles, network and charger conditions, and an explicit run-as-root option for directories rsync otherwise cannot reach.

## Facet 7 — Synthesis: safe storage in SAF, encrypted where needed, synchronized

### To settle

- [ ] Check every choice against the four properties, and record which one it costs: a private container satisfies the lock and fails reachability as a folder, a bare folder satisfies reachability and fails the lock, an export step fails the last two.
- [ ] Write the threat model first, around the two adversaries the lock exists for: a person holding the device, and an application that means to keep a permission forever. Record the neighbours as stated limits rather than silent assumptions: a malicious provider, an `adb`/root shell, a lost or powered-off device, the cloud host, the vendor's backup.
- [ ] Make revocation a first-class action of the store: the user withdraws a client's access in one step, a withdrawn client keeps nothing, and the store survives its own revocation.
- [ ] Pick the key anchor and state what it protects: a Keystore key behind biometrics (DroidFS's fingerprint path), a passphrase-derived key (gocryptfs scrypt), a hardware-wrapped config (RSAF), or none beyond file-based encryption (Anemo).
- [ ] Choose the storage and sync unit: one tree, one key, one writer per file, one merge rule.
- [ ] Choose the encryption boundary — provider-internal, a format-compatible overlay, or the remote side — and accept its consequence: decrypted bytes in the provider's process, ciphertext names in the tree, or plaintext locally.
- [ ] Convert the SAF costs into permanent constraints rather than bugs to file: coarse grants, no quotas, folder-level change events, no guaranteed file names, asynchronous close.
- [ ] Decide the exit: the user's files stay readable by other tools (PlaneTxt's premise), which rules out a bespoke container regardless of how much better it encrypts.

Facet 8 collects the extensions that change who may touch the store and how content arrives, without changing the four properties.

## Facet 8 — Tiered exposure, per-client revocation and ingest flows

Three possibilities widen the store's company without widening its trust: a revocation that lands on one app, two provider instances at different privilege, and a pipeline that turns clear arrivals into stored files. Each is optional against the four properties, and each is where the lock meets other software.

### To settle

**Per-client revocation.**

- [ ] Find the caller's identity: whether a `DocumentsProvider` can read the calling package or UID per operation, and hold an allow/deny list, so revocation lands on one app rather than on the store.
- [ ] Inventory what the framework supplies: the per-URI-per-client grant, `revokeUriPermission`, the Settings storage-access screen, and what a provider sees when the call arrives through another app or through DocumentsUI's forwarding.
- [ ] Price the identity: a package name is all the provider gets, it survives neither reinstall nor a changed signing key, and a shared UID or a wrapper shell makes two apps one.

**Two exposure tiers.**

- [ ] Specify the pair before building either: a full-privilege provider for the editor, a reduced one for untrusted clients, and the exact difference — readable subtree, writable subtree, session lifetime, key material.
- [ ] Establish whether two authorities share one backing tree without the weak one weakening the strong one: document-id namespaces, which grants persist where, and whether a lock in one tier reaches the other.
- [ ] Define the rotation and its blast radius: rotate the unlock secret (cheap), rotate the data key (a full re-encrypt), rotate the exposed path (a fresh tree per session), or combine; then state what a client holding a stale grant observes.
- [ ] Check the races: a client mid-write when rotation fires, a temp document left in the retired path, a half-written file visible to the other tier.

**Ingest and generic transforms.**

- [ ] Define the raw-to-encrypted leg: watch a clear folder such as Downloads, transform each arrival into the store, and remove or quarantine the plaintext original.
- [ ] Generalize past one direction: a transform step (convert, rename, split, dedupe) with a record of what moved, what was skipped and what failed.
- [ ] Settle idempotency and recovery: the same arrival twice, an interrupted transform, a file the store already holds.
- [ ] Decide the runner: the provider, a foreground worker, or an existing sync engine's copy/move — rclone's `copy`/`move` into a `crypt` remote is the closest farm equivalent.

### Prior art

- **Anemo** gates globally: the provider checks a lock flag and never the caller, so a per-client policy has no precedent in the farm. **DroidFS** and **RSAF** likewise carry no `getCallingUid`/`getCallingPackage` check, leaving the framework's per-client grant as the only per-client axis here.
- **DroidFS** is the ingest precedent: `importFilesFromUris` and `volume.importFile` move a shared or external URI into an encrypted volume, one file at a time, with encryption as the only transform.
- **gocryptfs** `-passwd` rotates the unlock secret only: the master key is re-wrapped and the ciphertext is untouched, with the old config kept as `gocryptfs.conf.bak`.
- **rclone `crypt`** states the hard case: the key derives from the password, so a password change cannot re-key existing content. The only route is decrypting and re-encrypting everything, either by re-uploading from a clear copy or by copying between two crypt remotes.
- **RSAF** has no rotation path of its own — its config is wrapped by a hardware key, and a backup restore breaks rather than re-keys.
- **The datalakehouse record** ([d178](d178-datalakehouse-workload.md)) and [personal-datalakehouse-prior-art](personal-datalakehouse-prior-art.md) carry the generic ELT shape this leg belongs to: source exporters into a store, a serve layer above it, and their own note that the bridge between capture and store is the thin part.

## Facet order

Facets 1 and 6 bind the architecture: the grant is the ceiling and the sync engine is the floor. Facets 2 and 3 decide the security claim, and neither settles without the other. Facet 4 is an escape hatch to reject unless the SAF route fails a stated requirement. Facet 5 is the proof: an editor that writes, and a second app that reads, over the tree the design chose. Facet 8 is deferred until 1, 5 and 7 stand: tiers and ingest multiply whatever the revocation model turns out to be.

## Verification record

Mirrors read from the forge roots under `~/Downloads/references/` at these tips, on 2026-11-21. Only the repositories named above were opened; a commit hash pins what was read and does not imply the project still looks like this.

`2bllw8/anemo` `e383aa18` · `chenxiaolong/RSAF` `c93b717` · `chenxiaolong/BasicSync` `ca19a9e` · `RikkaApps/Shizuku` `b844bc49` · `cipherd.arkensys.dedyn.io/DroidFS` `16608d88` · `rfjakob/gocryptfs` `3b0f2a7d` · `rclone/rclone` `b339a0512` · `syncthing/syncthing` `f2ed52347` · `newhinton/Round-Sync` `bda00f8d` · `brvier/PlaneTxt` `b6ac5e39` · `39aldo39/DecSync` `655dee6` · `~whynothugo/pimsync` `36a57e2` · `fengshaun/syncopoli` `2f51437` · `termux/termux-app` `8629e632` · `d4rken-org/sdmaid-se` `1cc83e8e1` · `logseq/logseq` `9af1a190bc` · `mihonapp/mihon` `1ed58f5e` (read for its persistable-grant use, quoted nowhere).

## Mirror status

The farm spans several forges under `~/Downloads/references/` — `github.com`, `codeberg.org`, `git.sr.ht`, `gitlab.com`, `tangled.org` and the `gitlab.*`, `salsa.debian.org` instances. The survey searched the storage-relevant names rather than a cross-branch index (d043 was not run).

Present: everything named above. Near-misses and gaps:

- **AOSP** (`packages/apps/DocumentsUI`, `platform_frameworks_base`) is absent. The framework half of facet 1 cannot be settled from the farm.
- **Cryptomator, CryFS, VeraCrypt, vdirsyncer, Etesync** are absent as repositories. DroidFS carries the only CryFS statement, pimsync supersedes vdirsyncer, and no mirror describes an Etesync or Cryptomator implementation.
- **Note/todo apps** other than PlaneTxt and Logseq (Markor, Orgzly, tasks.org, jtx Board) are absent, so facet 5's catalogue is two clients, one provider and one share target.
- **Syncthing's own Android app** and **Material Files** are absent; BasicSync and Anemo stand in for the SAF bridge and the provider respectively.
- **`storaged-project`/`stratis-storage`** cover desktop block storage (LUKS, udisks) and do not bear on a per-app Android tree, so they are left out.

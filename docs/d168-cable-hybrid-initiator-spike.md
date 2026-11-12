---
id: d168
type: architecture-design
status: done
title: "d168 — spike: the hybrid (caBLE) tunnel from the initiator side"
parent: architecture
references: [d043, d044]
tags: [spike, prior-art, webauthn, passkeys, cable, hybrid, fido, noise, ble]
---

# d168 — spike: the hybrid (caBLE) tunnel from the initiator side

Two mirrored projects implement the _responder_ half of the cross-device sign-in
tunnel — the phone at the far end of a QR code — and both were written against a
browser they never controlled. This record files what the mirrors actually do,
then answers the question their shape raises: what does it take to be the
_initiator_, the desktop side that shows the QR code, scans for the advert, opens
the WebSocket and runs the handshake? Both halves of that answer exist in public
sources, but not where one would look: the FIDO Alliance specification now carries
the full wire protocol with reference code, Chromium's source remains the arbiter
for the one branch the specification omits, and neither mirror can serve as the
initiator — each is the mirror image of it.

The short form: an initiator is roughly six hundred lines of portable protocol
code (QR offer, HKDF derivations, advert trial-decrypt, Noise KNpsk0, the padded
GCM framing, message-type dispatch) plus three things no source hands over — a BLE
scanner that can read service data, a relay at a domain the advert's 16-bit
identifier can name, and a WebAuthn client that verifies the assertion. The first
is per-platform, the second has a registration problem, and the third is outside
this protocol's scope.

## Status

Investigation finished, nothing implemented; the requirements at the end are not in
force. Open: whether an initiator belongs in this tree at all, and which platform's
BLE API a scan leg would bind to.

## Trust boundary

Prior art, not a dependency: nothing here is trusted, nothing was executed, and no
mirror code is proposed for adoption. Every claim about a mirror is a reading of
its source at the tip below. Where a mirror's comment disagreed with its code, the
code is what is reported.

| source                                     | tip                     | read as                      |
| ------------------------------------------ | ----------------------- | ---------------------------- |
| `rsnel/passkeychain.git`                   | `66250ac`, 2026-11-09   | responder, Kotlin            |
| `Z1xus/fidont.git`                         | `badc0de8f`, 2026-11-04 | responder, KMP plus Go relay |
| `chromium/chromium`, `device/fido/cable/*` | `2656708d`, 2026-11-11  | initiator, the arbiter       |
| FIDO Alliance, CTAP 2.3 Proposed Standard  | `fido-v2.3-ps-20260226` | the specification            |

The fidont tip carries a provenance warning: every one of its roughly twenty
commits is hash-prefixed `badc0de`, so the history is synthetic and says
nothing about review. Its content still reads as a coherent implementation, which
is why it is compared on bytes rather than provenance.

### Fetching them without a clone

A bare clone of `chromium/chromium` is about 65 GiB, which is why the reading
above was done by fetching files instead. The whole of `device/fido/cable/` plus
`device/fido/README.md` is roughly two hundred kilobytes across a score of files,
one GET each against
`raw.githubusercontent.com/chromium/chromium/<commit>/device/fido/cable/<name>`.
The set that matters is the handshake and crypto (`v2_handshake.cc`, `noise.cc`,
`v2_constants.h`), the client (`fido_tunnel_device.cc`), discovery
(`v2_discovery.cc`), the phone side for the mirror image (`v2_authenticator.cc`),
the identifiers (`fido_ble_uuids.cc`), and the unit test, which is the readable
statement of the framing (`v2_handshake_unittest.cc`).

The specification has no repository to mirror: it is generated HTML on
`fidoalliance.org`, and the transport has since been split into a document of
its own, `specs/hybrid/proximity-exchange-protocol-v1.0-wd-20260717.html`, so the
CTAP section and the standalone draft are the same protocol at different
addresses, and its hybrid section is self-contained enough to clip,
because the reference code is inline text rather than a linked source tree. The
draft number travels with any clip: the 2.2 and 2.3 drafts differ inside this very
section, so a clip without a draft number is a clip without authority.

## Where the protocol is written down

Asked whether those repositories, or Chromium, document the initiator's side, the
answer is that the _specification_ does and Chromium does not.

| source                                 | covers the initiator's side?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTAP 2.3, Hybrid transports            | Yes. The QR map and digit encoding, including key 6, the list of data-channel transports the client supports; the three derivation purposes; advert decrypt and the extended-advertising suffix; tunnel-domain decode; `/cable/connect/`; the `fido.cable` subprotocol; both Noise patterns; transport padding and nonces; the post-handshake map; message types; `/cable/contact/` and its 410; and, since this draft, a second data channel over an L2CAP connection-oriented channel whose server PSM travels in the advert suffix. Go reference code throughout. |
| Chromium `device/fido/cable/`          | Yes, as the one running client, plus what the specification omits: the legacy revision-zero branch, the GATT fallback, and the routing and shard HTTP headers. Not linkable — it is built on `//device/bluetooth`, `//services/network` and Mojo.                                                                                                                                                                                                                                                                                                                    |
| passkeychain `docs/PROTOCOL.md`        | Mostly. A thousand lines of notes on the same wire, including a section comparing itself with CTAP 2.2 and a vector set. Written from the responder's chair, and its own code disagrees with it in one place.                                                                                                                                                                                                                                                                                                                                                        |
| fidont `README.md` and `relay/main.go` | The relay only: the one mirrored artifact on the tunnel's server leg.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Chromium `device/fido/README.md`       | No. It is a roadmap of the FIDO request pipeline and never mentions this transport; the code is the documentation.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Three consequences follow. A from-scratch initiator is no longer an act of reverse
engineering, because the specification is specific enough to write from. And the
specification is not sufficient on its own, because it describes only the current
revision while Chromium still speaks a legacy dialect to old phones, and that
dialect is defined exclusively by Chromium's decode-and-fall-back logic. And the
newest draft leads the deployed clients: it lists a BLE data channel that no
shipping initiator uses, while the one production initiator accepts an advert of
exactly twenty bytes and therefore no suffix at all.

## What an initiator has to do

The work divides into twelve steps. The first eight are protocol, and are fully
specified. The last four are where an implementation spends its time.

| #   | step                          | the fact that decides it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Build the offer               | Generate a P-256 identity key and a 16-byte secret. CBOR map keys 0 (33-byte compressed key), 1 (secret), 2 (assigned-domain count), 3 (timestamp), 4 (state-assisted flag), 5 (flow hint). Encode as 7-byte little-endian chunks of 17 digits, the remainder in 3, 5, 8, 10, 13 or 15, after the `FIDO:/` prefix.                                                                                                                                                                                                                                                                                  |
| 2   | Derive from the secret        | HKDF-SHA256 over the secret with a 32-bit little-endian purpose as info: purpose 1 gives 64 bytes of advert key (AES-256 and HMAC-SHA256 halves), purpose 2 gives the 16-byte tunnel ID, purpose 3 gives the 32-byte PSK salted with the decrypted advert.                                                                                                                                                                                                                                                                                                                                          |
| 3   | Scan and trial-decrypt        | The advert is 20 bytes of service data under `0000fff9-0000-1000-8000-00805f9b34fb`. Accept it when HMAC-SHA256 over the first 16 bytes matches the last four, then decrypt those 16 bytes with AES-256. Reject unless byte 0 is zero. The 2.3 draft also permits an advertisement suffix — a CBOR map from data-channel identifier to channel data, with the Bluetooth L2CAP server PSM under identifier 1 — carried in extended advertising; Chromium accepts service data of exactly twenty bytes and drops anything longer, so the suffix is specification-current and deployment-incompatible. |
| 4   | Unpack the advert             | 16 bytes: flags byte (zero), 10-byte connection nonce, 3-byte routing ID, 16-bit little-endian tunnel-domain identifier. A suffix beyond these twenty bytes is channel negotiation and never part of the connection nonce.                                                                                                                                                                                                                                                                                                                                                                          |
| 5   | Resolve the domain            | Identifiers below 256 index the assigned table (`cable.ua5v.com`, `cable.auth.com`). Identifiers of 256 and above hash to `cable.` plus base32 of a SHA-256 digest over the label, the identifier and a NUL, with the low two bits picking `.com`, `.org`, `.net` or `.info`.                                                                                                                                                                                                                                                                                                                       |
| 6   | Open the tunnel               | `wss://<domain>/cable/connect/<hex routing>/<hex tunnel id>`, subprotocol `fido.cable`, binary frames only, redirects followed, and the subprotocol echoed back or the connection dropped.                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7   | Run the handshake             | Noise KNpsk0 over P-256, SHA-256 and AES-256-GCM with prologue byte 1: mix the local identity point, mix key and hash of the PSK, send the 65-byte ephemeral followed by the 16-byte tag of an empty payload; then mix the peer ephemeral, the ECDH of the two ephemerals and the ECDH of the local identity with the peer ephemeral, and require the peer's payload to decrypt to empty. The initiator's write key is the first half of the split.                                                                                                                                                 |
| 8   | Frame messages                | 32-byte padding granularity with the count of padding bytes in the final byte, nonce of eight zero bytes and a big-endian counter, empty associated data, and a leading type byte: 0 shutdown, 1 CTAP, 2 update, 3 JSON.                                                                                                                                                                                                                                                                                                                                                                            |
| 9   | Arbitrate the revision        | Chromium attempts a plain CBOR read of the decrypted post-handshake message. Success means revision 1, where every later message carries a type byte. Failure means revision 0, and the message is re-read as CBOR, zero padding, and a 16-bit little-endian count at the end. An initiator that implements only revision 1 hangs against a responder that pads.                                                                                                                                                                                                                                    |
| 10  | Speak CTAP2                   | The post-handshake map's key 1 is already the getInfo response. Key 3 lists features, and its absence must be read as `[ctap]`. Requests then leave as type byte 1, the command, and its parameters.                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | Verify as a relying party     | Check the assertion's RP ID hash against the origin, the user-presence and user-verification flags, the signature over the authenticator data and client data hash with the stored credential public key, and the sign counter. This is WebAuthn's work, not the tunnel's, and no mirrored project does it.                                                                                                                                                                                                                                                                                         |
| 12  | Optionally remember the phone | An update message's linking map — contact ID, link ID, link secret, authenticator public key, name, and an HMAC over the handshake hash under the ECDH between the two identities — enables the state-assisted flow: `wss://<domain>/cable/contact/<base64url contact id>` with `X-caBLE-Client-Payload`, an NKpsk0 handshake instead of KNpsk0, and 410 meaning the link is gone.                                                                                                                                                                                                                  |

### The three parts no source hands over

**Scanning is the portability wall.** Steps 1, 2 and 6 through 12 are arithmetic
over byte strings. Step 3 is not: it needs a BLE API that surfaces _service data
from unconnected advertisements_. Chromium reaches this through
`//device/bluetooth`, whose backends differ per platform. A helper on BlueZ
over D-Bus, CoreBluetooth, or Android's `BluetoothLeScanner` with a
service-data filter can do it. A browser page cannot: Web Bluetooth exposes neither
advertisements nor scan results. That asymmetry is why this protocol's initiator
side only ever appears inside an app that already owns the platform, and why a
portable library cannot exist without a pluggable scanner and a way to inject an
advert for tests. The 2.3 draft's alternative raises that bar rather than lowering
it: a data channel over L2CAP needs the same scanner plus a connection-oriented
channel client, so the number of platform APIs an initiator depends on grows.

**The domain identifier is a namespace problem, not a code problem.** A relay lives
at a name the _responder_ chooses in the advert, and for identifiers of 256 and
above that name is the hash output, so it cannot be chosen freely. There are two
ways out, and the mirrors show both: register an identifier in the assigned range,
which is FIDO's to grant, or search the free range for an identifier whose hash
lands on a name that is still available. fidont did the second — its default relay
is identifier 64322, which hashes to `cable.ahhkeysummo2d.com`, a domain the
project registered. The same arithmetic means an initiator cannot invent its own
relay name without an assignment or a searched identifier, which is the least
obvious cost in the whole build.

**Being the initiator means being a WebAuthn client.** The tunnel carries CTAP2
commands; choosing which command to send, and believing the answer, is the
relying-party half — options marshalling, client data JSON, credential allow-lists,
signature verification against a stored public key. Chromium splits that across
`device/fido` and the content layer, and neither mirror contains it because
the phone verifies nothing. An initiator for a website is half written when the
tunnel works.

## What the two mirrors establish

Both implement the responder side of the same protocol and agree with Chromium on
almost every byte. Where they diverge they diverge in ways an initiator cares
about, because an initiator has to talk to whichever one it meets.

| dimension               | passkeychain                                                                                                            | fidont                                                                                                                          | Chromium and CTAP                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Post-handshake framing  | padded: CBOR, zeros, 16-bit little-endian count, multiple of 512                                                        | unpadded CBOR                                                                                                                   | revision 0 padded, revision 1 unpadded; the specification describes revision 1 only |
| Revision this forces    | 0, so no type byte on any later message — the browser suppresses it                                                     | 1, so a type byte on every message, as the specification's reference code does                                                  | Chromium decides by whether the plain CBOR read succeeds                            |
| Message-type constants  | `CTAP=0, JSON=1, SHUTDOWN=2, UPDATE=3` — shifted one from the standard                                                  | exact                                                                                                                           | `0 shutdown, 1 CTAP, 2 update, 3 JSON` in both                                      |
| Consequence of shifting | a bare getAssertion or getNextAssertion command falls outside the accepted range and is dropped, so a real client hangs | none                                                                                                                            | not applicable                                                                      |
| Advert encryption       | AES-256-ECB, one block                                                                                                  | AES-256-CBC with a zero IV, one block                                                                                           | ECB                                                                                 |
| QR parsing              | all six keys, a twenty-minute staleness window, and a hint that drives the UI                                           | keys 0 and 1 only; assigned-domain count, hint and state-assisted flag ignored                                                  | all keys, unknown keys ignored                                                      |
| Derivation purposes     | 1, 2, 3 with little-endian labels, and the advert as PSK salt                                                           | identical                                                                                                                       | identical                                                                           |
| Transport padding       | 32 bytes, count in the final byte                                                                                       | identical                                                                                                                       | identical                                                                           |
| Test evidence here      | handshake, transport, message, domain and vector tests                                                                  | none for the tunnel; a CTAP2 conformance script and a harness                                                                   | extensive                                                                           |
| Relay                   | none; Google's is used                                                                                                  | a Go relay: `fido.cable`, routing header `000000`, two-minute lifetime, 256 KiB budget, 4096 tunnels, 404 for an unknown tunnel | Chromium's is Google's; the only documented status code is 410                      |

Three of these deserve a sentence each.

_The message-type shift is real in one direction only._ Because passkeychain's
padded post-handshake message forces the browser to revision zero, and revision
zero suppresses the type byte entirely, its shifted constants are never exercised
against a current browser, and its tunnel works. Its own notes half-noticed this:
they retract the shifted table as unconfirmed and describe an observed
prefix-less request, while the code keeps the shifted table and a heuristic
dispatcher that tries both forms. The heuristic is the symptom rather than the fix;
the revision rule above is deterministic, and an initiator that implements it
needs no heuristic.

_The advert-encryption divergence is a coincidence worth naming._ AES-256-CBC with
a zero IV over a single block is AES-256-ECB, because the IV is the only
difference and nothing is chained. fidont's decrypt path is correct by accident of
CBC's definition rather than by intent, so it stays correct only while the advert
is exactly one block — which the protocol fixes at 16 bytes, but which nothing in
that code promises.

_The QR narrowing is a compatibility choice with a cost._ Reading only keys 0 and
1 still meets a browser's offer, because the rest are advisory — but a responder
that ignores the assigned-domain count cannot fall back when it does not know the
browser's relay, and one that ignores the state-assisted flag and the hint gives up
the two affordances those fields exist to carry.

## What the mirrors are good for

They are conformance oracles for an initiator, and better ones than a test double,
because they were validated against a browser they did not write.

- passkeychain exercises the **revision-zero** branch — the branch the
  specification omits and the one a from-scratch initiator is likeliest to get
  wrong. It fails loudly if the padded re-read is missing.
- fidont exercises **revision one** and, uniquely among these mirrors, the whole
  **self-hosted relay** path: identifier 64322 forces the hashed-domain
  resolution instead of the assigned-table lookup, so it is the only available
  end-to-end test of the domain decoder.

Neither can serve as an initiator, and neither contains a BLE _scanner_, a WebAuthn
verification path, or the state-assisted contact flow — so a build against these
oracles validates everything except the three hard parts named above.

## If the initiator is a browser

A browser is the natural host for the client platform, and in three of five cases
the question is already answered by delegation.

| Firefox on                    | what answers a hybrid-capable request today                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 13.3 and later          | Apple's platform API: `WebAuthnService` builds a `MacOSWebAuthnService` and routes requests through it, so Apple's cross-device flow comes for free.                                                                                                                                                                                                      |
| Windows with the APIs present | `webauthn.dll` through `WinWebAuthnService`, selected when the API is available and the Rust bridge otherwise.                                                                                                                                                                                                                                            |
| Android                       | `AndroidWebAuthnService`, which is the OS credential provider and owns both halves of the flow.                                                                                                                                                                                                                                                           |
| Linux, and any other desktop  | Nothing in Firefox: `mPlatformService` falls back to the authenticator-rs bridge, which documents its own limit — the crate can dispatch a request to any number of transports, but production supports only the USB one — and the crate ships HID, a device selector and a mock. The work has moved outside the browser instead; see Where Linux stands. |

Firefox does carry the vocabulary — `WebAuthnTransportIdentifiers.h` defines
identifiers for BLE, hybrid and internal transports, and the bridge whitelists the
transport strings a site may hint — but a hint filters the transports that exist,
and on Linux no hybrid transport exists to filter.

### What adding one would take

Three pieces, ordered by what decides whether the work is worth starting.

1. **A transport backend.** authenticator-rs already has the seam: a trait with a
   single register method, an `AuthenticatorService` that fans a request out to
   every registered transport, and a USB-HID implementation beside it. A hybrid
   backend is one more module implementing that trait and driving the twelve steps
   above, after which the bridge's USB-only restriction stops being true.
2. **A scanner.** Gecko has no Bluetooth stack at all: `dom/bluetooth` and
   `dev/bluetooth` are both gone from the tree. A scanner would be new code per
   platform — BlueZ over D-Bus, CoreBluetooth, WinRT — each with its own permission
   story, and it is the one piece no part of the tree can lend.
3. **Prompts.** The offer, the scan state and the "check your phone" messages ride
   the existing WebAuthn prompt path, which already carries presence, PIN and
   credential-selection status between the child and parent transaction. On Linux
   there is now a designed seam: the experimental credential interface in
   `flatpak/xdg-desktop-portal` enumerates sources as `Ble`,
   `HybridLinked`, `HybridQr`, `Internal`, `Nfc` and `Usb`, and its
   `NotifyHybridStarted` hands the frontend's invocation data to the desktop to
   render as a QR code. That is the split this record describes — the browser keeps
   the protocol, the desktop supplies the dialog — and writing the protocol once
   against a portal is cheaper than a BLE stack per desktop.

### Where Linux stands

Linux is the one platform where an initiator exists outside a browser, and it was
built for exactly the sandbox problem: the transports live in a privileged daemon
and the browser is meant to ask for a credential over a portal.

The chain, in the order a request travels it:

| link                         | what exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| xdg-desktop-portal, frontend | `desktop-portal/credential.c` on `main`, exporting an experimental Credential portal with `HybridTransport` set true, so a sandboxed app can request a hybrid ceremony and render nothing itself. No release carries it: the tree of the 1.20.0, 1.21.0 and 1.22.1 tags has no credential source, and Debian trixie ships 1.20.3.                                                                                                                                                             |
| the gate                     | Two switches, both outside the sandbox: the daemon needs `XDG_DESKTOP_PORTAL_ENABLE_EXPERIMENTAL=Credential` in its environment, and a portal configuration entry for `org.freedesktop.impl.portal.experimental.Credential`, without which the frontend returns before exporting the interface.                                                                                                                                                                                               |
| credentialsd                 | Version 0.4.0, Rust over `zbus`, implementing the handler interface the frontend delegates to. The frontend's handler bus name is hardcoded, so credentialsd is currently the only implementation that can answer.                                                                                                                                                                                                                                                                            |
| pxp                          | `linux-credentials/libwebauthn` 0.11.0's `pxp` crate, a complete initiator: QR code and state-assisted initiation, a WebSocket data channel over `tokio-tungstenite`, a BLE channel through `bluer` and `btleplug`, the 2.3 L2CAP channel, Noise through `snow`, and the same advert trial-decrypt as Chromium — twenty-byte prefix, HMAC over the body compared against the trailing four bytes, AES-256 over one block, reserved byte zero, and any suffix parsed separately as a CBOR map. |
| the UI                       | `credentialsd-ui`, GTK4, which is what draws the QR code.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Two details decide what a deployment can promise. Bluetooth scanning is required
even when the data channel is a WebSocket: the proximity stage waits for an
advertisement because the advertisement supplies the PSK salt, the tunnel domain
and the routing ID, so `CloudAssistedOnly` names the channel and not the
proximity. And the QR map is version-gated: pxp omits key 6 unless the peer is
expected to understand it, because a pre-2.3 reader decodes that key as a boolean
and rejects an array.

Nothing on the desktop side of a KDE system is missing for this: the Credential
interface is delegated to a handler, not to a portal backend, and
`xdg-desktop-portal-kde` implements no credential backend at all and needs none.
What a KDE desktop lacks is the frontend version, not an integration.

Packaging says the same thing in another register. No distribution archive carries
any of it: Fedora Rawhide packages xdg-desktop-portal 1.22.1, whose release tarball
has no credential source. The one build that puts the chain together is an Open
Build Service project carrying openSUSE and Fedora repositories — `credentialsd`,
`credentialsd-ui`, a `credentialsd-webextension` package, and an
`xdg-desktop-portal-experimental-credential` subpackage that applies three
upstream pull requests to the 1.22.1 tarball and installs a systemd drop-in
setting the feature flag. The flag's value differs between that backport and
upstream: the 1.22.1 patch compares against `credential`, while `main` exports
the portal when the variable holds `Credential`, because it checks the portal's
name rather than a flag. A patched Firefox flatpak bundle sits in the same
project.

### In a flatpak

The sandbox is the least of the obstacles, because every step that needs privilege
is on the other side of the portal boundary. The BLE scan, the QR display and the
WebSocket all live in credentialsd; the browser asks, and
`org.freedesktop.portal.Desktop` is on the session-bus proxy's allow-list for
every application, which is how a portal interface reaches a sandboxed application
without a manifest change.

Three things the sandbox does change:

- A native-messaging helper runs inside it, so the extension route needs the helper
  installed in the application's own profile directory and a bus policy for the
  handler's name, which is an override rather than a rebuild.
- A stock browser never calls the portal, so the flow is unreachable from an
  unmodified build whatever the host provides; the working arrangements are a
  patched build or the native-messaging extension.
- Moving the BLE stack inside the sandbox instead would need the bluetooth allow
  rule plus a policy for the host's BlueZ on the system bus, and it buys nothing,
  since the daemon outside already has both.

### What an extension cannot do

An extension can do the cryptography: WebCrypto has ECDH over P-256, HKDF, HMAC
and AES-GCM, and with a host permission it can open the WebSocket to the relay. It
cannot do either end of the flow, for two reasons no permission fixes.

- **No radio.** Firefox does not implement Web Bluetooth — its compatibility entry
  records the absence with a Bugzilla pointer — and the WebExtension API surface
  has no Bluetooth, USB or HID entry at all: fifty-three interfaces, none of which
  scans. Without a scanner there is no advert, and without an advert there is
  neither a proximity proof nor a PSK.
- **No origin.** A page's `navigator.credentials.get` is answered by the
  browser's own WebAuthn machinery, and an extension cannot claim that call. A
  credential created from an extension page belongs to the extension's own origin,
  not to the site whose sign-in is being attempted.

A helper process beside the browser inherits the same split and fixes neither half:
it can scan and tunnel, and the page still cannot reach it.

### The responder half is not a browser feature anywhere

Responding needs BLE peripheral advertising rather than scanning, a credential
store with user verification, and a wakeup path so that a tunnel can start while
the app is closed. Desktop browsers have none of the three, which is why every
platform delegates this half to its credential provider — and why both mirrored
implementations are phone apps.

## Verification status

Checked against source, byte for byte: the advert layout and its zero flags byte;
the HMAC-then-AES trial decrypt; the three derivation purposes and their
little-endian info labels; the assigned-domain table and the hash-to-domain
construction, including that identifier 64322 hashes to
`cable.ahhkeysummo2d.com`; the `FIDO:/` digit widths; the KNpsk0 prologue
byte and the order of the four mixes; the transport padding count and nonce
construction; the message-type values in all three sources; the revision
arbitration in Chromium's tunnel device; the post-handshake map's keys and its
feature default; and the passkeychain shift in both its code and its tests.

Also checked in the same pass, for the browser question: Gecko's WebAuthn service
per platform and the default it builds; the Rust bridge's own statement that
production supports only USB; that the crate's transport modules are HID, a device
selector, a mock and per-platform HID backends; that `dom/bluetooth` and
`dev/bluetooth` are absent; the transport identifiers header; Web Bluetooth's
compatibility entry; and the WebExtension interface list. For the Linux and
flatpak question: the xdg-desktop-portal trees at the 1.20.0, 1.21.0 and 1.22.1
tags, its experimental-portal gate, the frontend's handler bus name and its
`HybridTransport` property, the handler and frontend XML alike, credentialsd's
tree and dependency list, pxp's crate manifest and its advert, crypto and
connection-stage sources, the absence of a credential backend in
`xdg-desktop-portal-kde`, and the Debian trixie package versions. The 2.3 draft was read
for its hybrid section only, to establish the data-channel list and the
advertisement suffix; the rest of that document is unread.

Not checked: any of it running. No tunnel was established, no browser was involved,
and the CTAP2 halves of both mirrors were read for structure only. The
specification was read as rendered HTML at the pinned draft and not compared across
drafts, so whether an earlier draft named a different prologue byte or padding
granularity is unexamined.

## Requirements not in force

- An initiator must implement the revision arbitration before anything else: a
  plain CBOR read of the decrypted post-handshake message decides whether a type
  byte is present, and assuming revision one breaks every padded responder.
- An initiator must run without BLE by accepting an advert from its caller. The
  scanner is the only platform-bound step, and a protocol that can only be tested
  on hardware is a protocol that is never tested.
- An initiator must treat the advert as its only proximity evidence, and must take
  the tunnel identifier and routing ID from nothing except a decrypted advert.
- A self-hosted relay must own a name its advert identifier can produce: either a
  FIDO-assigned identifier, or one searched for so that the hash lands on an
  available domain.
- An initiator must verify the assertion as a relying party would — RP ID hash,
  flags, signature, counter — before reporting a sign-in. The tunnel's
  authentication ends at the phone; the credential's does not.
- An initiator must trial-decrypt the first twenty bytes of an advert and treat
  anything beyond them as channel negotiation, so that it works both against a
  peer that appends a suffix and against one that cannot.
- A protocol layer built for a browser must take the scanner from its host and
  hand the offer to its host for display, so that one implementation serves a
  desktop that scans natively and one that borrows the dialog from a portal.

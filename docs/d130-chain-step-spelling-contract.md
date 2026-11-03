---
id: d130
type: module-design
status: active
title: "d130 — the chain step's spelling is a contract with the relay's listener: socks5h for ALL_PROXY, both env cases for every variable"
parent: estige
depends-on: [d073, d094, d095, d120]
references: [d080, d103, d110, d123]
tags: ["estige", "proxy", "socks5", "env", "chain-step", "regression"]
---

# d130 — the chain step's spelling is a contract with the listener

## Status

Accepted — the implementing change landed: `estige proxy-env` prints
`ALL_PROXY='socks5h://…'` and exports every conventional variable in both
cases, with the exported line set pinned by test.

## Problem

d120 replaced the POSIX launchers with a packaged service plus one binary verb,
`estige proxy-env` — the chain step that hands an operator's shell the loopback
spelling (d095's step 4). The rewrite moved the export from shell to Go and
silently changed two of its values. Neither change was a security decision,
neither was noticed at the time, and both are invisible while the relay is
healthy and the child is written in a language that reads the surviving
spelling.

Two regressions against d095's own text, found by diffing v3's `vpn-relay.sh`
against `estige/proxyenv.go`:

- **The SOCKS scheme lost its `h`.** v3 exported
  `ALL_PROXY="socks5h://$relay_socks"`; `proxyEnvLines` exported
  `ALL_PROXY='socks5://…'`. The `h` is not cosmetic: it is the difference
  between a client sending the target's *name* and a client resolving it
  first and sending an address. The relay's SOCKS5 listener refuses a literal
  target address (`socksReply(conn, 0x08)`) because resolution and pinning
  belong to the exit node (VPN-R22) — so the two halves of a `socks5://`
  deployment contradict each other by construction.
- **The lowercase spellings disappeared.** v3 exported `http_proxy`,
  `https_proxy`, `all_proxy`, `no_proxy` beside the uppercase names; the Go
  rewrite exported only the uppercase four — exactly the case d095 step 4
  names as required ("`HTTP_PROXY`/`HTTPS_PROXY` (and their lowercase
  spellings)").

## Evidence

Measured against a live exit node + relay node pair (exit `PORT=23400`, relay
`-proxy-listen 127.0.0.1:23410 -socks-listen 127.0.0.1:23411`, egress
`{"allowCidrs":["127.0.0.0/8"],"ports":[18100]}`, an origin on
`127.0.0.1:18100`).

### The SOCKS scheme, same relay, same hostname target

```
--proxy socks5h://127.0.0.1:23411 http://localhost:18100/
  * SOCKS5 connect to localhost:18100 (remotely resolved)
  * SOCKS5 request granted.  →  HTTP/1.0 200 OK

--proxy socks5://127.0.0.1:23411  http://localhost:18100/
  * Host localhost:18100 was resolved.
  * SOCKS5 connect to [::1]:18100 (locally resolved)
  * cannot complete SOCKS5 connection to localhost. (8)
```

The refusal is the listener doing its job: `0x08` is "address type not
supported", VPN-R22's fail-closed answer to a pre-resolved target. What was
wrong was telling the client to resolve. Every real target is a hostname, so
`ALL_PROXY=socks5://` broke the SOCKS leg for all of them — loopback survived
only because it is in `NO_PROXY`.

### The lowercase spellings

GNU wget (1.25) reads only the lowercase variable; it ignores `HTTP_PROXY`
entirely and therefore dials the internet **direct**, past the kill switch:

```
$ env -i PATH=/usr/bin:/bin HTTP_PROXY=http://127.0.0.1:23410 wget … http://127.0.0.2:18100/
  wget exit=0            ← answered
  tunnel log entries: 0  ← nothing crossed the tunnel: a direct dial

$ env -i PATH=/usr/bin:/bin http_proxy=http://127.0.0.1:23410 wget … http://127.0.0.2:18100/
  wget exit=8            ← 403 from the tunnel's egress policy
  tunnel log entries: 1  ← reached the exit, as the spelling promised
```

curl behaves the same way for `http://` URLs (it prefers `http_proxy` and
ignores `HTTP_PROXY`), while for `https://` it accepts either. "Which case does
a client read" is therefore not a settled fact a chain step may pick a side on:
a child bypassing the tunnel is the one outcome VPN-R26's fail-closed posture
forbids, and it is silent — the request succeeds.

## Decision

The exported spelling is a **contract with the listener**, and both ends are
pinned:

- **`ALL_PROXY`/`all_proxy` name `socks5h://<socks-listen>`.** The client
  keeps the name on the wire; the exit node resolves, validates and pins
  (VPN-R22/VPN-R36). The relay's literal-address refusal stays unchanged — it
  is the invariant this spelling satisfies, not a defect the spelling works
  around.
- **Every conventional variable is exported in both cases, with identical
  values**: `HTTP_PROXY`/`http_proxy`, `HTTPS_PROXY`/`https_proxy`,
  `ALL_PROXY`/`all_proxy`, `NO_PROXY`/`no_proxy`. One table in
  `proxyEnvLines` is the single source of both spellings, so a future edit
  cannot separate them.
- **`NODE_USE_ENV_PROXY` stays one assignment.** It is node's own switch, has
  no lowercase form and no case convention, and node ignores the proxy
  variables entirely without it (d074).

## Consequences

- A child of the chain step is proxied whichever case it reads, and the SOCKS
  leg works by name for every target — the v3 behaviour, restored.
- The pairing "spelling ↔ what the listener accepts" is now test-visible:
  `TestProxyEnvLinesMergesNoProxyAndQuotes` pins the exact line set,
  `TestProxyEnvLinesPairsEveryCase` forbids a half-exported variable, and an
  end-to-end subtest drives the relay's SOCKS listener with an ATYP=IPv4
  literal to assert the `0x08` refusal. A future edit that picks the wrong
  scheme, or drops a case, fails a test instead of failing on a restricted
  host.
- `net/http` and Node's `NODE_USE_ENV_PROXY` ignore `ALL_PROXY`, and d103's
  cleartext forward branch is what carries those children's plain `http://`
  traffic — so the SOCKS regression never hid a second bug behind it, and the
  forward branch remains necessary regardless of this spelling.
- The relay's SOCKS listener still accepts only the domain address type. That
  is deliberate and unchanged; a future transport that must address a literal
  needs a decision record, not a spelling.

## Alternatives rejected

- **Teach the relay's SOCKS listener to accept literal addresses.** It makes
  `socks5://` work — and deletes VPN-R22: the client would resolve (on a
  restricted host, through whatever resolver it has), and the exit would dial
  an address the client chose, with no name to check the egress policy's
  binding against. The `0x08` refusal is the requirement, and the spelling is
  the cheaper end to move.
- **Keep `socks5://` and rely on `NO_PROXY`.** It leaves every non-loopback
  hostname target broken, and `NO_PROXY` covers the opposite case (targets that
  must stay direct), so it cannot repair this one.
- **Keep the uppercase-only export and document it.** The documentation would
  say "if your client reads `http_proxy`, you must export it yourself", i.e.
  the chain step would hand out a spelling that silently fails open for a
  whole class of clients. d095 already required both cases; documenting the
  narrower behaviour would amend a requirement to match a bug.
- **Export both cases from a shell fragment instead of the binary** (a
  `proxy-env --sh` mode kept in POSIX sh). It re-introduces the second language
  d120 retired for the same reasoning, to fix a value.

## Verification

- `go test ./...` in `estige/` — the three `proxyenv` cases plus the
  end-to-end SOCKS case above, all green (`./test.sh` runs the suite since
  d123).
- `estige proxy-env` prints nine assignments: the four conventional variables
  twice (upper and lower, equal values) and `NODE_USE_ENV_PROXY` once.
- `eval "$(estige proxy-env)"` then `curl` through the SOCKS leg
  (`--proxy socks5h://…`) answers from the tunnel; the same request spelled
  `socks5://` is refused with SOCKS reply `0x08`.
- With only the lowercase variables present, GNU wget's request appears in the
  exit node's tunnel log; with only the uppercase ones it does not (the
  pre-fix bypass).

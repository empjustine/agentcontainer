---
id: d181
type: module-design
status: draft
title: "d181 — the session ingest route: a write-only local HTTP sink, so the sandbox never holds write access to the archive"
parent: datalakehouse
depends-on: [d180]
references: [d026, d167, d172, d179, coding-harness-persistence, d182, d183, d184]
tags: ["datalakehouse", "sessions", "diode", "http", "ingest", "push", "append-only", "read-only"]
---

# d181 — the session ingest route

This record moves the session collector's input from a read-write filesystem mount
to a dedicated local HTTP route, so the sandbox never holds write access to the
archive. It covers the route contract, the receiver and the residual fidelity gap,
and it is not the d026 FUSE implementation. The reader is whoever writes the
receiver and the harness emitter. What it decides: the sandbox may only POST, the
host-side receiver is the archive's only writer, and the diode property becomes a
property of the route.

## Status

Draft; nothing implemented. The route ships independently of d026 and composes
with it.

## Problem

[d180](d180-session-collection-leg.md) keeps the diode property by mounting the
archive read-only and writing it host-side, but the harness still needs a
writable path, so the live stage is a read-write mount the sandbox can rewrite.
The sandbox therefore holds write access to a path, and only the collector's
timing separates it from the archive. An HTTP route removes the path entirely:
the sandbox emits, and never writes the store.

## Decision

- A **dedicated local HTTP route** on the host, reachable from the sandbox — a
  published loopback port or a bind-mounted Unix socket — modelled on the push
  listener of [d172](d172-push-based-browsing-index.md) and hister.
- **Write-only contract.** The route exposes an ingest verb
  (`POST /ingest/session`) and no destructive or read-back verb. There is no DELETE
  and no in-place update; each POST appends a version.
- **The host-side receiver is the archive's only writer**, exactly as d180's
  collector is. The sandbox never sees the archive writable.
- **Token authentication**, per the d172 ingest token, so a stray host process
  cannot post.
- **Idempotent by natural key** (d167's keys), so a replay is not a duplicate.

## What the route guarantees, and what it does not

It guarantees that the sandbox cannot delete or modify captured data: the sandbox
holds no writable path, and the route has no destructive verb. That is the diode
property, now at the route level.

It does not force emission. An adversary that withholds or forges events is
d026's stated non-goal — no diode can compel a compromised emitter to be
truthful. The route can authenticate and rate-limit; it cannot compel.

## Emission and the fallback

The harnesses have no native HTTP emitter, so emission needs a component. Two
channels compose:

- The **route** is the trustworthy channel: whatever reaches it is append-only
  and unalterable by the sandbox.
- The **live stage plus d180's collector** stays as a fidelity backstop, because
  a harness that never posts still leaves a file the host can sweep. It is
  tamperable, so it is second-class and not the archive contract.

An in-sandbox forwarder that tails the stage and posts is possible, but it is
killable by the adversary it audits (d026's Approach A flaw). A harness-native
emitter is better and is the pending per-harness work d167 names. The
per-harness emitter surfaces are [d182](d182-harness-emitter-surfaces.md), and the
multi-root capture is [d183](d183-thinkrail-and-delegated-loop-capture.md).

## Why this is not d026

d026's FUSE store makes a version at write time and covers every file the harness
touches. The route covers only what is emitted, so it trades completeness for
zero in-sandbox write access and no FUSE daemon. The two compose: the route for
the events that have emitters, the FUSE store for the rest.

## Consequences

- The sandbox launch gains the route, a port or a socket, and loses nothing; the
  read-write stage can stay as the backstop.
- The route is the **second push sink** in the warehouse, beside d172's browsing
  listener. A shared ingest shape is possible but not required, because the
  payloads differ (session entries versus visits).
- A compromised sandbox can pollute the warehouse through the route, but cannot
  damage the archive — the same trade d180 records for the reader.
- With the route in place, the archive's writer set is exactly the host-side
  receiver and collector, and no sandbox is in it.

## Alternatives rejected

- **Keep only the read-write stage.** The sandbox then holds write access to a
  path that a timing sweep protects — d180's residual window.
- **An in-sandbox tailer as the only emitter.** Killable by the adversary it
  audits.
- **Read-back or delete verbs on the route.** They would hand the sandbox the
  destructive access the route exists to remove.
- **Wait for d026.** The route ships now and composes with d026 later.

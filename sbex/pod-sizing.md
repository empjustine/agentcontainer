---
id: sbex-pod-sizing
type: submodule-design
status: active
title: "Pod sizing: finding the heap limit and throughput frontier per replica"
parent: sbex
tags: ["kubernetes", "capacity", "load-testing", "sizing"]
---

# Pod sizing: finding the heap limit and throughput frontier per replica

This file is a method for answering one question: **which per-pod heap limits are worth deploying**, as a Pareto frontier of memory against throughput (at a fixed latency target), when replicas are spread onto dedicated machines. It does not tune the JVM inside a pod (`sbex/memory.md` owns the flags), automate the cluster (`kubernetes.io` owns the scheduling model), or export the measurements (`sbex/observability.md` owns the telemetry path). The reader is sizing requests and limits with evidence instead of a guessed ratio.

## Spread before measuring

The spread is a precondition for a clean measurement, not only a DR/HA posture:

- `topologySpreadConstraints` with `topology.kubernetes.io/region`, `topology.kubernetes.io/zone` and `topology.kubernetes.io/node` as `topologyKey`, `maxSkew: 1`, and `whenUnsatisfiable` chosen per requirement — `ScheduleAnyway` for balance, `DoNotSchedule` when a replica must not share a failure domain.
- Inter-pod **anti-affinity** on `kubernetes.io/hostname` for the strictest form: one replica per node, so a pod's machine belongs to it.

With that in place every replica measures its own machine: no co-tenant's CPU steal, no neighbouring noisy loop, no shared GC of a half-occupied node. The curve measured for pod A is reproducible for pod B of the same shape. The cost is real — spreading trades bin-packing efficiency for isolation — and that trade is exactly what the frontier below prices: the memory a deployment _cannot_ save because the spread already spent it.

## Define one point

A point in the experiment is **one configuration with one knob moved**:

- **Fixed:** replica count, node class, CPU limit, thread and pool bounds, application version, topology spread.
- **Swept:** the effective heap ceiling — either the container limit with `-XX:MaxRAMPercentage` held constant, or `-Xmx` directly against a fixed limit (the container limit always keeps the non-heap headroom from the `memory.md` table above it).
- **Measured:** throughput achieved _while holding the latency SLO_ (requests per second at p99 ≤ target), p50/p99 latency, working-set RSS, GC time share, error rate.

Throughput-at-SLO is the scalar on purpose: a configuration that is faster but blows the latency target is not comparable to one that does not.

## Sweep procedure

1. Fix the topology spread above and one node class; place the load generator outside the measured pods so its own CPU is never on the curve (k6, or any open-loop generator that can hold a constant arrival rate).
2. Run each point to steady state — JIT compilation and GC warm-up settle in the first window — then measure a fixed interval and discard the warm-up.
3. Sweep the heap knob across the plausible band (for example 40/55/70/85 percent of the container limit), three or more repetitions per point, **randomising the order** so a machine or broker drift does not line up with one end of the sweep.
4. Record per point: throughput at the SLO, percentiles, `container_memory_working_set_bytes`, GC counts and pauses (Micrometer's JVM GC metrics or `-Xlog:gc*`), error rate.
5. Drop dominated points and keep the frontier.

## The dominance rule

Point **A dominates B** when A uses no more memory, delivers at least the throughput, and is no worse at p99 — with at least one strict inequality. The **Pareto frontier** is the set of points nothing dominates; the deployment choice is the _knee_ of that set, where one more unit of heap stops buying throughput.

The shape a sweep produces (the numbers are illustrative, not a measurement):

| Heap limit | Throughput at SLO | Verdict                                |
| ---------- | ----------------- | -------------------------------------- |
| 128 MiB    | 400 rps           | dominated — GC churn caps it           |
| 256 MiB    | 950 rps           | **frontier** — the knee                |
| 512 MiB    | 980 rps           | dominated — 2× memory for 3%           |
| 1 GiB      | 975 rps           | dominated — pauses now cost throughput |

Automation follows the procedure literally: a CI job deploys a candidate, runs the load window, scrapes the metrics, computes the frontier from the result set, and promotes the knee as the new `resources.limits`. Vertical Pod Autoscaler recommendations are a good _starting band_ for the sweep — they read observed usage, not throughput at an SLO, so they locate the neighbourhood rather than the frontier.

## What bends the curve

The frontier is not linear because three effects fight inside one number:

- **Too little heap** buys GC churn: collection frequency climbs until throughput collapses — the cliff at the left of the table.
- **Too much heap** buys longer pauses and committed-but-idle pages; past the knee, memory stops converting to work.
- **The non-heap floor** (metaspace, direct buffers, stacks, code cache) sits outside the heap knob, so shrinking the heap below the floor saves total RSS far less than it appears to — the reason the container limit and the heap ceiling are swept as two related numbers, never as one.

CPU limit is the hidden third axis: GC threads compete with request threads for it, so either hold CPU fixed across the sweep or promote it to a third dimension of the frontier rather than letting it drift.

## References

- [Kubernetes — Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [Kubernetes — Inter-pod affinity and anti-affinity](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/#inter-pod-affinity-and-anti-affinity)
- [Kubernetes Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler) (the starting band, not the answer)
- [k6 documentation](https://k6.io/docs/) (the load generator used in the procedure)
- [Oracle — Java SE GC tuning guide](https://docs.oracle.com/en/java/javase/21/gctuning/) and the [java man page](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html) (the JVM half of the curve)

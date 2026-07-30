---
name: segment-performance-auditor
description: Measure, review, and improve Segment performance without sacrificing correctness or readability. Use for trie and leaf materialization, subscriptions, transactions, derivations, resources, hot paths, allocation, memory retention, benchmark changes, performance claims, or suspected regressions.
targets: ['*']
codexcli:
  interface:
    display_name: Segment Performance Auditor
    short_description: Audit Segment latency, work, and memory
    default_prompt: Use $segment-performance-auditor to measure and improve this Segment hot path.
  policy:
    allow_implicit_invocation: true
---

# Segment Performance Auditor

Treat performance as a falsifiable contract. Prefer deterministic work and lifecycle
counts; use timing and heap measurements only with controls that make them meaningful.

## Define the performance question

1. Name the operation, workload shape, data size, observed window, and expected
   complexity before measuring.
2. Separate primary metrics—callbacks, selector runs, live nodes or entries,
   revisions, allocations—from secondary wall-clock and heap measurements.
3. Identify the protected contract: targeted work, O(observed) state-layer memory,
   allocation-free common paths, or a documented lifecycle cost.
4. Read `docs/core.md` and `benchmarks/segment-state/README.md`; their measurement
   caveats are part of the benchmark contract.

## Inspect before optimizing

- Trace reads, writes, stamping, staging, commit construction, wake walks, ref
  creation, subscribe/unsubscribe, pruning, and async cleanup as applicable.
- Look for hidden total-subscriber or total-data scans, eager per-key objects,
  retained descriptors, unconditional Sets or Maps, stack capture, environment
  access, cloning, and closures that keep paths or stores alive.
- Confirm ownership and eviction for every new cache. A bounded cache still needs a
  demonstrated hit rate and benefit; an unbounded keyed cache violates the memory
  model.
- Reject complexity that buys no resolved improvement. Readability and extensibility
  are part of the cost model.

## Measure reproducibly

- Run `pnpm benchmark` for the cross-library workload and `pnpm benchmark:hot` for
  core operations.
- For candidate A/B work, build the candidate with
  `benchmarks/segment-state/build.mjs` and compare it using
  `benchmarks/segment-state/ab.mjs`. Alternate order and use identical source,
  dependencies, Node version, and machine conditions.
- Isolate timing and memory cases in fresh processes. Warm or settle only as the
  existing fixture prescribes; do not invent a favorable warm-up for one variant.
- Report the noise floor. Treat a delta inside it as unresolved, not as a win. In the
  comparison suite, differences below the documented roughly twofold threshold are
  directional unless exact counts distinguish them.
- Record the command, revision, Node version, hardware context, repetitions, primary
  counts, and trade-offs for any durable benchmark claim.

## Guard the result

1. Add deterministic tests for work counts, pruning, revisions, or lifecycle when
   possible. Never make CI depend on nanosecond or heap-delta thresholds.
2. Run targeted tests, `pnpm check`, and the relevant benchmark more than once.
3. Confirm that optimization does not change commits, wake unrelated observers,
   retain addresses after detach, weaken types, or move renderer concerns into core.
4. Update benchmark documentation or recorded images only from a valid run, and state
   when a result is machine-specific.
5. Report regressions and ambiguous measurements as directly as improvements.

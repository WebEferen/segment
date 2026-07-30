---
name: segment-bug-hunter
description: Reproduce, isolate, and prevent Segment defects and regressions using adversarial, deterministic tests. Use for incorrect state, missed or duplicate notifications, leaks, transaction failures, derivation errors, resource races, SSR or port mismatches, Octane lifecycle issues, flaky tests, or suspicious edge cases.
---
# Segment Bug Hunter

Turn symptoms into a minimal, deterministic failing case, then prove the root cause
and the absence of nearby regressions.

## Reproduce before explaining

1. Capture the exact API calls, values, paths, commit sources, observer counts,
   environment, and timing or ordering needed to see the defect.
2. Establish expected behavior from public types, docs, existing tests, and core
   invariants. Mark assumptions that are not yet specified.
3. Reduce the case to the smallest store shape and operation sequence. Replace UI,
   network, and timers with controlled fixtures unless the integration itself is the
   suspected boundary.
4. Add a focused test that fails for the observed reason. For flaky or combinatorial
   cases, use a fixed seed and print the operation trace needed to replay a failure.

## Search the state-space deliberately

Exercise relevant neighboring cases:

- **Writes:** direct and transactional, same-value, multiple writes to one path,
  nested calls, read-your-writes, throw and rollback, observer re-entrancy, and the
  re-entry limit.
- **Addresses:** cells, branches, missing segment keys, flat and structured segments,
  lists, whole-container replacement, path resolution, and revision changes.
- **Observers:** exact and deep, one and multiple listeners, attach/detach order,
  self-disposal, disposal during notification, churn, pruning, and resubscription.
- **Derivations:** clean and dirty caches, diamonds, dynamic dependencies, equality,
  cycles, observed and unobserved locations, and errors.
- **Resources:** synchronous throw, rejection, abort, superseded refresh, stale
  dependencies, save races, live emissions, unmount, retry, and late completion.
- **Boundaries:** SSR hydration, serialized commits, port echo prevention, packed
  entry points, DOM-free core types, and Octane mount/unmount scheduling.

Choose the smallest matrix that can disprove the current hypothesis; do not add a
large undirected test suite as a substitute for isolation.

## Find and fix the root cause

- Trace the first point where actual state diverges from the invariant. Distinguish
  storage, ref resolution, staging, commit, notification, cache, adapter, and cleanup
  failures.
- Instrument deterministic counters or operation logs temporarily. Do not use timing
  coincidence as proof of a race.
- Check recent diffs and adjacent code, but verify causality by making the reproducer
  fail before the fix and pass after it.
- When authorized to implement, prefer the narrowest fix that restores the invariant
  for all paths. Do not hide a lifecycle bug with retries, leaked retention, broad
  invalidation, or duplicate notification.

## Close with evidence

1. Run the focused regression test in the correct Vitest project.
2. Run the neighboring suite, then `pnpm check`.
3. Run `pnpm pack:check` for entry-point, export, metadata, or consumer-only failures.
4. Use `segment-performance-auditor` if the fix touches a hot path or retention and
   `segment-principal-engineer` if it changes a public contract or architecture.
5. Report the reproducer, root cause, fix or diagnosis, commands run, and residual
   risk. Never call a defect fixed solely because the original symptom disappeared.

---
name: segment-principal-engineer
description: Design, implement, refactor, or review Segment architecture and public APIs with principal-engineer rigor. Use for changes involving src/core, src/octane, exported types, state semantics, module boundaries, maintainability, extensibility, compatibility, or substantial cross-cutting work.
---
# Segment Principal Engineer

Build changes that remain understandable and extensible without weakening Segment's
behavioral or performance contracts.

## Establish the contract

1. Read the nearest generated agent rules, then inspect the affected public types,
   implementation, tests, and documentation. Treat tests as evidence, not the sole
   specification.
2. State the observable behavior and invariants before designing. Include cleanup,
   errors, re-entrancy, serialization, and compatibility where relevant.
3. Trace the complete data flow from declaration and ref resolution through read,
   staged write, commit, notification, and disposal. For async work, include abort,
   supersession, stale data, save, and live-channel paths.
4. Identify every consumer of the changed contract: core callers, Octane adapter,
   SSR, ports, playground, docs, type tests, package exports, and benchmarks.

## Design for durable extension

- Keep `src/core` framework- and DOM-independent. Put renderer-specific scheduling
  and lifecycle logic in `src/octane`.
- Preserve one authoritative path for state. Materialized nodes and leaf records are
  indexes over stored values, not competing copies.
- Keep writes atomic and notifications commit-scoped. Do not expose intermediate
  state or make rollback depend on an undo log.
- Extend an existing primitive when the semantics match. Add a new abstraction only
  when it owns a distinct invariant and reduces total complexity.
- Keep public APIs orthogonal and minimal. Prefer exported functions for ordinary
  module behavior; use addressed store composition when reactive identity or
  lifecycle state is part of the model.
- Avoid speculative flags, generic indirection, global registries, and caches without
  an explicit owner, eviction rule, caller, and regression test.
- Prefer readable branches and precise names over compressed cleverness. Document
  why an unusual representation exists and which invariant or measurement requires
  it.

## Review the implementation

Check these dimensions explicitly:

- **Correctness:** same-value writes, missing values, nested transactions, rollback,
  observer re-entrancy, derivation invalidation, async races, and disposal.
- **Complexity:** state operation cost should follow path depth, actual writes, and
  observers woken—not total data or total subscribers.
- **Memory:** unbounded keyed data must not create permanent per-key state merely
  because it was read or once observed.
- **Compatibility:** exported names, types, entry points, paths, commits, SSR, and
  ports require deliberate migration or preservation.
- **Extensibility:** the next adjacent feature should have a clear insertion point
  without duplicating state or bypassing validation.

## Prove the result

1. Add the smallest test that pins the contract and would fail for the wrong design.
   Add misuse/type coverage when the guarantee is compile-time.
2. Run the narrow Vitest project while iterating, then `pnpm check`.
3. Run `pnpm pack:check` when exports, packaging, metadata, or release behavior moves.
4. Invoke `segment-performance-auditor` for a hot-path or memory-sensitive change and
   `segment-bug-hunter` for high-risk state transitions or race conditions.
5. Before opening a pull request, add a release changeset for published API or
   runtime behavior, or an empty changeset for non-release work. The generated
   `changeset-release/*` version PR is the only exception because it consumes those
   files. Report validation evidence, compatibility impact, and unresolved
   trade-offs clearly.

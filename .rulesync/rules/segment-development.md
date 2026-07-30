---
root: true
targets: ['*']
description: Engineering and validation rules for every change to Segment.
---

# Segment development contract

Segment is a framework-agnostic, path-addressed TypeScript state engine. Optimize
for correctness first, then for measurable work and memory, while keeping the public
surface small enough to evolve.

## Choose the right review lens

- Use `segment-principal-engineer` for architecture, API design, implementation,
  refactoring, and broad code review.
- Use `segment-performance-auditor` for hot paths, observer work, allocation,
  materialization, benchmarks, or performance claims.
- Use `segment-bug-hunter` for defects, regressions, race conditions, edge cases,
  and adversarial test design.
- Combine the skills when a change crosses those concerns; do not let a performance
  optimization bypass the architecture or correctness bar.

## Preserve the core contracts

- Keep `src/core` independent from Octane, browser globals, and the DOM. Its
  DOM-free TypeScript configuration is an enforced boundary.
- Preserve structural path identity, targeted notification, atomic commit and
  rollback semantics, read-your-writes transactions, and deterministic revisions.
- Keep state-layer memory proportional to currently observed addresses. Detaching
  the last observer must release unbounded per-key bookkeeping.
- Keep renderer behavior in `src/octane`; the core must remain useful without a UI
  adapter, provider, or hidden global store.
- Treat exported types, package entry points, serialized commits, SSR payloads, and
  port messages as compatibility surfaces.

## Work from evidence

1. Read the public types, existing tests, and the relevant guide before changing a
   contract. Read `docs/core.md` before altering trie, transaction, observer,
   derivation, or resource internals.
2. Trace every affected entry point and lifecycle, including cleanup and failure
   paths. Prefer the smallest coherent design over a local special case.
3. Add a focused regression or contract test. Use deterministic counters for work
   and lifecycle properties; do not encode noisy timing thresholds in unit tests.
4. Run the narrow test while iterating, then `pnpm check`. Run `pnpm pack:check` for
   exports, entry points, package metadata, or release changes.
5. Every ordinary pull request must contain a changeset. Run `pnpm changeset` and
   select a semantic bump for a published API or runtime behavior change. Run
   `pnpm changeset --empty` for docs, tests, examples, benchmarks, CI, or other
   non-release work. A generated `changeset-release/*` version PR is the only
   exception because it consumes the pending changesets.

## Maintainability bar

- Prefer explicit names, short control flow, and one source of truth. Comments
  should explain invariants or non-obvious measured trade-offs, not restate code.
- Reuse existing primitives before adding another abstraction. Avoid speculative
  hooks, flags, caches, or public API that have no current caller and test.
- Keep types precise at module boundaries. Do not use casts to conceal an invalid
  state or weaken a public contract for implementation convenience.
- Preserve user changes and keep unrelated cleanup outside the patch.
- Never edit recorded benchmark claims without running the documented methodology
  and reporting the environment and uncertainty.

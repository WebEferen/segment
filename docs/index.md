---
layout: home

hero:
  name: Segment
  text: State you can address.
  tagline: A framework-agnostic, type-safe state engine built around structural paths, targeted subscriptions, and atomic commits.
  image:
    src: /logo.svg
    alt: Segment
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/WebEferen/segment

features:
  - title: Structural paths
    details: Reach declared state through typed refs or stable path strings such as users/42/profile/name.
  - title: Targeted updates
    details: Wake observers of the affected address instead of evaluating every subscriber on every write.
  - title: Atomic commits
    details: Publish several writes together, attribute them to one source, and roll them all back if the transaction throws.
  - title: O(observed) memory
    details: Large keyed segments materialize nodes for watched addresses and prune them after the last observer leaves.
  - title: Async state built in
    details: Resources share addressing with local state and add caching, cancellation, staleness, live values, and save-back.
  - title: Runtime independent
    details: Use the DOM-free core from UI code, workers, tests, sockets, persistence layers, or server rendering.
---

<section class="home-section">

## One model from state to transport

```ts
import { createStore, segment } from 'segment-state';

const store = createStore({
	todos: segment({ title: '', completed: false }),
});

const completed = store.state.todos.at('docs').completed;

store.observe(completed, () => console.log(store.get(completed)));
store.set(completed, true, 'todo/complete');
```

A ref identifies state without exposing a mutable object. The same address can be
observed by a component, written inside a transaction, serialized for hydration,
or matched by an external port.

</section>

<section class="home-section benchmark-section">

## Measured behavior

![Segment benchmark comparison against Valtio, Jotai, Redux, and Zustand](/benchmark-comparison.png)

The benchmark suite prioritizes deterministic counts—callbacks woken, selector
runs, and bookkeeping retained after churn—then measures write, memory, and mount
costs in isolated processes. Timing and heap results are machine-specific.

[Read the methodology and reproduce the run](https://github.com/WebEferen/segment/blob/main/benchmarks/segment-state/README.md)

</section>

<section class="home-section home-next">

## Start with the shape of your data

The [getting-started guide](/guide/getting-started) builds a store from plain values,
shows how refs and transactions work, and introduces keyed segments. Continue with
the [state model](/guide/state-model) or go directly to the
[advanced guide](/advanced) for resources, SSR, ports, and lifecycle guarantees.

</section>

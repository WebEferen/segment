<p align="center">
	<img src="https://raw.githubusercontent.com/WebEferen/segment/main/assets/lockup.svg" alt="Segment" width="520" />
</p>

<p align="center">
	<strong>State you can address.</strong><br />
	A framework-agnostic, type-safe state engine built around structural paths,
	targeted subscriptions, and atomic commits.
</p>

<p align="center">
	<a href="https://github.com/WebEferen/segment/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/WebEferen/segment/ci.yml?branch=main&amp;style=flat-square&amp;label=CI" alt="CI status" /></a>
	<a href="https://github.com/WebEferen/segment/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-5B5751?style=flat-square" alt="MIT license" /></a>
	<a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A522-5B5751?style=flat-square" alt="Node.js 22 or newer" /></a>
	<a href="https://webeferen.github.io/segment/"><img src="https://img.shields.io/badge/docs-GitHub%20Pages-E90826?style=flat-square" alt="Documentation" /></a>
</p>

<p align="center">
	<a href="https://webeferen.github.io/segment/">Documentation</a>
	·
	<a href="https://webeferen.github.io/segment/guide/getting-started">Getting started</a>
	·
	<a href="https://webeferen.github.io/segment/advanced">Advanced guide</a>
	·
	<a href="https://github.com/WebEferen/segment/tree/main/playground">Playground</a>
</p>

> [!WARNING]
> Segment is experimental and currently follows `0.x` versioning. Its core behavior
> is tested, but public APIs may still change before `1.0`.

## What is Segment?

Segment is a small state engine for applications where data has a natural address:
records, documents, caches, server payloads, and large keyed collections.

Many state APIs make a selector, atom object, or store snapshot the identity at the
call site. Segment instead gives every declared value a structural path:

```text
users/42/profile/name
```

That path can be read, written, observed, serialized, or passed to an external
service without sharing an in-memory object reference. The same addressing model
powers fine-grained subscriptions, transaction logs, server hydration, resources,
and adapters.

|                          | What it means                                                                 |
| ------------------------ | ----------------------------------------------------------------------------- |
| **Structural paths**     | Any declared value can be reached through a typed ref or a plain path string. |
| **Targeted updates**     | A write wakes observers of the affected address, not the whole store.         |
| **Atomic commits**       | Multiple writes land together; a thrown transaction is rolled back.           |
| **O(observed) memory**   | Large segments materialize nodes only for addresses currently being watched.  |
| **Async state built in** | Resources support caching, cancellation, staleness, live data, and save-back. |
| **Runtime independent**  | The core imports neither a UI framework nor the DOM.                          |

## Benchmark

<p align="center">
	<img src="https://raw.githubusercontent.com/WebEferen/segment/main/assets/benchmark-comparison.png" alt="Segment benchmark comparison against Valtio, Jotai, Redux, and Zustand across targeted subscription work, observer churn, write time, memory, and mount lifecycle" width="1200" />
</p>

The suite combines exact work counts with a 20,000-record workload, 2,000 targeted
writes, and a 200-row mounted window. Callback, selector, and retained-entry counts
are the primary results; elapsed time and heap measurements are machine-specific
and should be read directionally.

Run it locally with `pnpm benchmark`. The full
[benchmark methodology](https://github.com/WebEferen/segment/blob/main/benchmarks/segment-state/README.md)
documents the fixture, library versions, measurement caveats, and the commands used
to compare a candidate change against an identical baseline. The comparison
describes design trade-offs, not a universal ranking for every application shape.

## Installation

```sh
npm install segment-state
```

```sh
pnpm add segment-state
```

Segment is ESM-only. Node.js `22+` is required for Node runtimes and development
tooling. Browser and worker builds do not depend on Node or the DOM.

For the optional Octane adapter, install the peer dependency too:

```sh
pnpm add segment-state octane
```

## Quick start

Declare the shape of the state once. Segment turns it into a typed tree of
addresses while keeping values inside the store.

```ts
import { createStore, segment } from 'segment-state';

export const store = createStore({
	todos: segment({ title: '', completed: false }),
});

export const s = store.state;

s.todos.replaceAll({
	docs: { title: 'Ship the documentation', completed: false },
	release: { title: 'Publish the package', completed: false },
});

const completed = s.todos.at('docs').completed;

const stop = store.observe(completed, () => {
	console.log('completed:', store.get(completed));
});

store.update(completed, (value) => !value, 'todo/toggle');

console.log(completed.path); // todos/docs/completed
stop();
```

There is no provider and no hidden global store:

1. `createStore()` creates one isolated state container.
2. `store.state` exposes typed refs; it does not expose mutable state objects.
3. `store.get()` reads once, while `store.observe()` subscribes.
4. Every write becomes a named commit that adapters and external services can see.

### Atomic updates

Use `store.act()` when several writes must become visible together:

```ts
store.act((tx) => {
	tx.set(s.todos.at('docs').completed, true);
	tx.set(s.todos.at('release').completed, true);
}, 'release/complete');
```

Observers see one commit and never an intermediate state. If the callback throws,
none of its writes are published.

## Define the state model

Ordinary values are ordinary writable state. Markers are only needed when the
value itself cannot describe the behavior you want.

| Declaration        | Use it for                                                           |
| ------------------ | -------------------------------------------------------------------- |
| `count: 0`         | A writable value with an inferred type.                              |
| `profile: { … }`   | A branch whose fields each receive an address.                       |
| `cell<T>(initial)` | A narrowed union or a plain object stored as one value.              |
| `segment({ … })`   | A large keyed collection with observation-scaled memory.             |
| `list({ … })`      | An addressable array whose items have addressable fields.            |
| `derived<T>()`     | A cached synchronous value computed from other addresses.            |
| `resource<T>()`    | Async state with load, save, cancellation, staleness, and live data. |
| `action()`         | One synchronous, atomic state transition.                            |
| `task()`           | An async flow made of several atomic transitions.                    |

Computed slots and callable actions receive their implementations through
`.with()`. A store containing only plain data does not need this step.

```ts
import { action, createStore, derived } from 'segment-state';

export const counter = createStore({
	count: 0,
	doubled: derived<number>(),
	increment: action<[by?: number]>(),
}).with((s) => ({
	doubled: (get) => get(s.count) * 2,
	increment: (tx, by = 1) => tx.update(s.count, (count) => count + by),
}));

counter.state.increment(2);
console.log(counter.get(counter.state.doubled)); // 4
```

See the [state model guide](https://webeferen.github.io/segment/guide/state-model) for
collections, refs, derivations, actions, and tasks. Resources, SSR, ports, and
persistence boundaries live in the
[advanced guide](https://webeferen.github.io/segment/advanced).

## Read and write from anywhere

The core API is deliberately small:

| Operation                | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `store.get(ref)`         | Read a value without subscribing.                      |
| `store.observe(ref, cb)` | Subscribe to one address or subtree.                   |
| `store.set(ref, value)`  | Replace one writable value.                            |
| `store.update(ref, fn)`  | Apply one read-modify-write transition.                |
| `store.patch(ref, data)` | Update selected fields as one commit.                  |
| `store.act(fn)`          | Group multiple reads and writes atomically.            |
| `store.ref(path)`        | Resolve an address from a structural path string.      |
| `store.commits(cb)`      | Subscribe to the serializable stream of state changes. |

This makes the same store usable from UI code, tests, workers, sockets, persistence
layers, and developer tools.

## Octane integration

`segment-state/octane` is the optional render-aware adapter. It has no provider and
keeps subscriptions scoped to the address read by a component.

```tsx
import { useValue } from 'segment-state/octane';

export function TodoRow({ id }: { id: string }) @{
	const [completed, setCompleted] = useValue(s.todos.at(id).completed);

	<button onClick={() => setCompleted(!completed)}>
		{completed ? 'Done' : 'Mark complete'}
	</button>
}
```

- `useValue(ref)` reads writable, derived, branch, and resource addresses.
- `useStatus(ref)` exposes resource state without suspending.
- `useDraft(ref)` keeps a local edit and publishes it on demand.

The core remains usable without Octane through `get`, `observe`, commit streams, and
ports. No React or Vue adapter is bundled today.

## Where Segment fits

Segment is a strong fit when:

- a large keyed dataset has a much smaller visible or observed window;
- state must be addressed outside the component that created it;
- several writes must be atomic and attributable;
- server payloads, workers, sockets, or devtools need one serializable protocol;
- async values should share the same address and lifecycle model as local state.

For a small amount of component-local UI state, the state primitive built into your
renderer is usually simpler. Segment is also intentionally not a router, database,
or request client—it coordinates application state around those systems.

## Package entry points

| Import                 | Contents                                   |
| ---------------------- | ------------------------------------------ |
| `segment-state`        | Framework-agnostic core.                   |
| `segment-state/core`   | Compatibility alias for the same core.     |
| `segment-state/octane` | Core plus the optional Octane integration. |

## Documentation

| Resource                                                                     | What it covers                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [Documentation site](https://webeferen.github.io/segment/)                   | Searchable guide and API concepts.                          |
| [Getting started](https://webeferen.github.io/segment/guide/getting-started) | Installation, first store, subscriptions, and transactions. |
| [State model](https://webeferen.github.io/segment/guide/state-model)         | Cells, branches, segments, lists, derivations, and actions. |
| [Advanced guide](https://webeferen.github.io/segment/advanced)               | Resources, Octane, SSR, hydration, ports, and guarantees.   |
| [Core internals](https://webeferen.github.io/segment/core)                   | Trie design, commit protocol, complexity, and measurements. |
| [Release guide](https://webeferen.github.io/segment/releasing)               | Maintainer release and trusted publishing workflow.         |

## Development

```sh
pnpm install
pnpm check
```

Run the interactive example with `pnpm playground`, or build it with
`pnpm playground:build`. The playground consumes the package through `workspace:*`;
`pnpm pack:check` additionally installs the real tarball in a clean offline consumer
to catch missing files or broken exports.

## License

[MIT](https://github.com/WebEferen/segment/blob/main/LICENSE) © Michal Makowski

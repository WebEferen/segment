# State model

Segment separates the **shape** of state from the implementations that compute or
mutate it. The shape creates a typed address tree; `.with()` fills only the slots
that need behavior.

## Plain values and branches

A primitive, array, `Date`, `Map`, `Set`, or `RegExp` is stored as one writable
value. Its initial value is widened to the corresponding TypeScript value type.

```ts
const store = createStore({
	count: 0, // Ref<number>
	theme: 'light', // Ref<string>
	tags: ['state'], // Ref<string[]>
	openedAt: new Date(0), // Ref<Date>
	ui: {
		compact: false, // a branch containing Ref<boolean>
	},
});
```

A plain object creates a branch by default. Use `cell()` when a plain object should
remain one indivisible value, or when a literal needs a narrower union type:

```ts
import { cell, createStore } from 'segment-state';

const store = createStore({
	theme: cell<'light' | 'dark'>('light'),
	layout: cell({ columns: 3, gap: 8 }),
});
```

## Segments and lists

Both markers describe addressable collections. Their difference is the key space:

| Marker           | Key                 | Typical use                                  |
| ---------------- | ------------------- | -------------------------------------------- |
| `segment(shape)` | `string` or a brand | Entities, caches, documents, normalized data |
| `list(shape)`    | `number`            | Ordered, addressable items                   |

```ts
import { createStore, list, segment } from 'segment-state';

const store = createStore({
	users: segment({ name: '', active: false }),
	lines: list({ sku: '', quantity: 1 }),
});
const s = store.state;

const userName = s.users.at('u1').name;
const firstQuantity = s.lines.at(0).quantity;
```

An outer segment owns one bulk value and exposes `replaceAll()` and `snapshot()`:

```ts
s.users.replaceAll({
	u1: { name: 'Ada', active: true },
	u2: { name: 'Grace', active: false },
});

const allUsers = s.users.snapshot();
```

Writing a field updates that bulk value directly. Observed nodes are an index over
the data, never a second authoritative copy, so they can be pruned safely when their
last observer leaves.

## Computed and callable slots

Some behavior has no meaningful initial value. Declare those slots with a marker:

```ts
import { action, createStore, derived, resource, task } from 'segment-state';

const store = createStore({
	count: 0,
	doubled: derived<number>(),
	profile: resource<{ name: string }>(),
	increment: action<[by: number]>(),
	sync: task<[], void>(),
});
```

The declaration fixes the public type and address. `.with()` supplies an exhaustive
implementation tree after TypeScript has resolved the shape:

```ts
const store = createStore({
	count: 0,
	doubled: derived<number>(),
	increment: action<[by: number]>(),
	sync: task<[], void>(),
}).with((s) => ({
	doubled: (get) => get(s.count) * 2,
	increment: (tx, by) => tx.update(s.count, (count) => count + by),
	sync: async ({ act, signal }) => {
		const response = await fetch('/api/count', { signal });
		const count = Number(await response.text());
		act((tx) => tx.set(s.count, count), 'sync/apply');
	},
}));
```

Forgetting one declared implementation is a type error. A store containing only
plain data does not call `.with()`.

## `.with()` or exported functions?

`.with()` is an organizational choice, not a requirement for changing state. A
data-only store can expose ordinary module functions instead:

```ts
import { createStore } from 'segment-state';

const store = createStore({ count: 0, updatedAt: 0 });
const s = store.state;

export function increment(by = 1): void {
	store.update(s.count, (count) => count + by, 'counter/increment');
}

export function reset(): void {
	store.act((tx) => {
		tx.set(s.count, 0);
		tx.set(s.updatedAt, Date.now());
	}, 'counter/reset');
}

export const doubled = store.derive((get) => get(s.count) * 2);
```

Do not leave an `action()`, `derived()`, `resource()`, or `task()` marker in the
schema without `.with()`; those markers deliberately require implementations.
Instead, move that behavior outside the schema and use the corresponding store API.

| Schema with `.with()`                 | Exported module API                               |
| ------------------------------------- | ------------------------------------------------- |
| `action()` implemented in `.with()`   | Ordinary function using `set`, `update`, or `act` |
| `derived()` implemented in `.with()`  | `store.derive()` created once                     |
| `resource()` implemented in `.with()` | `store.resourceOf()`                              |
| `task()` implemented in `.with()`     | Ordinary async function with explicit state       |

Use `.with()` when behavior belongs on the typed accessor tree, needs a stable
schema address, or benefits from exhaustive implementation checking. Export
functions when the module itself is the public API and direct composition is
simpler.

An ordinary async function does not receive the automatic `status`, `result`, and
`error` refs of `task()`. Standalone `resourceOf()` addresses are numbered by
creation order and should be treated as session-local. The
[advanced composition section](../advanced.md#composition-without-with) shows the
complete pattern.

## Derived values

A derivation receives `get` and records the addresses it actually reads. Its value is
cached and recomputed only when one of those dependencies changes.

```ts
const store = createStore({
	price: 10,
	quantity: 2,
	total: derived<number>(),
}).with((s) => ({
	total: (get) => get(s.price) * get(s.quantity),
}));
```

Derivations must be pure. They are read-only and cannot be written through `set`,
`patch`, or a transaction.

Use `store.derive()` for a computed address that should not live in the schema:

```ts
const hasItems = store.derive((get) => get(store.state.quantity) > 0);
```

Create anonymous derivations once, not during a render. Call `store.release(ref)`
when an instance-scoped derivation is no longer needed.

## Actions

An action is a synchronous transaction exposed directly on `store.state`:

```ts
const store = createStore({
	count: 0,
	increment: action<[by?: number]>(),
}).with((s) => ({
	increment: (tx, by = 1) => tx.update(s.count, (count) => count + by),
}));

store.state.increment(3);
```

Every action is one all-or-nothing commit named after its address.

## Tasks

A task represents an async flow. It receives `act`, not a long-lived transaction,
because a synchronous transaction cannot safely cross an `await` boundary.

```ts
const store = createStore({
	status: cell<'idle' | 'saving' | 'done'>('idle'),
	save: task<[payload: string], void>(),
}).with((s) => ({
	save: async ({ act, signal }, payload) => {
		act((tx) => tx.set(s.status, 'saving'));
		await fetch('/api/save', { method: 'POST', body: payload, signal });
		act((tx) => tx.set(s.status, 'done'));
	},
}));
```

Tasks expose readable `status`, `result`, and `error` addresses on the callable
slot. Each `act()` inside the task remains an independent atomic commit.

## Branch reads and revisions

Reading a branch returns the record as stored and may therefore return `undefined`
for a missing dynamic key. Reading an individual leaf returns its declared default.

Branch object identity does not change when one of its fields is updated. Adapters
should use `store.revision(ref)` as the change token for a whole subtree and
`store.kindOf(ref)` to choose the correct subscription strategy.

## Reserved names

The accessor tree owns these keys:

- `path`
- `at`
- `observe`
- `replaceAll`
- `snapshot`

They cannot be used as schema field names. Prefixes beginning with `$derive:` and
`$fetch:` are also reserved for anonymous addresses created by the store.

## Continue

The [advanced guide](../advanced.md) covers resources, server rendering, ports, and
the complete lifecycle guarantees. For implementation constraints and measured
complexity, read [Core internals](../core.md).

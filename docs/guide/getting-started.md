# Getting started

This guide starts with the store model underneath the Octane hooks: it builds a
small store, reads and observes individual addresses, and groups several writes
into one transaction.

## Install

::: code-group

```sh [npm]
npm install segment-state octane
```

```sh [pnpm]
pnpm add segment-state octane
```

:::

Install the renderer you use: `octane` for the hooks on the package root, or
`react` (19 or newer) for the `segment-state/react` entry point. Both peers are
optional. Segment ships as ESM and requires Node.js 22 or newer when it runs under
Node. Server, worker, and tooling code that must not load a renderer can import
the DOM-free engine from `segment-state/core`.

## Create a store

`createStore()` receives the shape of the state. Plain values supply their initial
values, while a plain object creates a branch of individually addressable fields.

```ts
import { createStore } from 'segment-state';

export const store = createStore({
	session: {
		userId: '',
		online: false,
	},
	visits: 0,
});

export const s = store.state;
```

`store.state` is an accessor tree. Its leaves are typed refs, not mutable copies of
the stored values:

```ts
s.session.userId.path; // session/userId
s.session.online.path; // session/online
s.visits.path; // visits
```

Refs can be safely exported and passed between modules. A ref knows which store owns
it, and its `path` is the portable identity of the address.

## Read once or subscribe

Use `get()` outside a render when you need the current value once:

```ts
const visits = store.get(s.visits);
```

Use `observe()` when a service or adapter needs to react to changes:

```ts
const stop = store.observe(s.session.online, () => {
	console.log('online:', store.get(s.session.online));
});

store.set(s.session.online, true);
stop();
```

The callback receives no possibly stale value. It reads the current snapshot from
the store, and repeated writes wake it only when its address is affected.

## Write state

The common mutations each create one commit:

```ts
store.set(s.session.userId, 'user-42', 'session/login');
store.update(s.visits, (count) => count + 1, 'visit');
store.patch(s.session, { online: true }, 'session/online');
```

`patch()` writes only the keys provided and leaves every other field untouched.

When several writes belong to one logical transition, use `act()`:

```ts
store.act((tx) => {
	tx.set(s.session.userId, 'user-42');
	tx.set(s.session.online, true);
	tx.update(s.visits, (count) => count + 1);
}, 'session/login');
```

Transactions provide read-your-writes behavior through `tx.get()`. Observers and
commit subscribers see one transition after the callback completes. If it throws,
the staged write set is discarded.

## Model a keyed collection

Use `segment()` for data keyed by an unbounded string space. The records live in one
bulk value, while nodes below it exist only for addresses currently being observed.

```ts
import { createStore, segment } from 'segment-state';

const store = createStore({
	users: segment({ name: '', role: '' }),
});
const s = store.state;

s.users.replaceAll({
	ada: { name: 'Ada Lovelace', role: 'admin' },
	grace: { name: 'Grace Hopper', role: 'member' },
});

const ada = s.users.at('ada');
store.set(ada.role, 'owner');

console.log(store.get(ada.name)); // Ada Lovelace
console.log(s.users.snapshot()); // the complete bulk value
```

For a branded key type, use the curried form:

```ts
type UserId = string & { readonly __brand: 'UserId' };

const users = segment<UserId>()({ name: '', role: '' });
```

TypeScript now refuses an unbranded string at `.at()`.

## Address state by string

Typed refs are the normal application API. Path strings are the boundary API for
services that should not depend on your accessor objects:

```ts
const name = store.ref('users/ada/name');

store.get(name);
store.set(name, 'Ada');
```

Unknown schema paths throw immediately. Ports, commit logs, dehydration, and
hydration all use the same path representation.

## Listen to commits

Every published transition has an id, a source, and its applied writes:

```ts
const unsubscribe = store.commits((commit) => {
	console.log(commit.source, commit.writes);
});
```

Commit sources make changes attributable in devtools, logs, persistence adapters,
and tests. Pass one explicitly when it is part of your protocol.

## Next steps

- [State model](./state-model.md): cells, lists, derived values, actions, and tasks.
- [Advanced guide](../advanced.md): resources, SSR, hydration, Octane, and ports.
- [Core internals](../core.md): the trie, commit protocol, and performance model.

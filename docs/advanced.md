# Advanced guide

This guide covers the parts of Segment that cross module, process, and network
boundaries. Start with [Getting started](./guide/getting-started.md) and the
[State model](./guide/state-model.md) if refs and transactions are new to you.

## Implement computed and callable slots

The schema fixes the public type and address of a derived value, resource, action,
or task. `.with()` supplies the implementation after TypeScript has resolved the
complete state tree:

```ts
import { action, createStore, derived, task } from 'segment-state';

const store = createStore({
	count: 0,
	doubled: derived<number>(),
	increment: action<[by?: number]>(),
	sync: task<[], void>(),
}).with((s) => ({
	doubled: (get) => get(s.count) * 2,
	increment: (tx, by = 1) => tx.update(s.count, (count) => count + by),
	sync: async ({ act, signal }) => {
		const response = await fetch('/api/count', { signal });
		const count = Number(await response.text());
		act((tx) => tx.set(s.count, count), 'sync/apply');
	},
}));
```

Forgetting a declared implementation is a type error. A store containing only data
does not need `.with()`.

### Actions and tasks

An action is a synchronous transaction exposed directly on `store.state`. It
publishes one commit and rolls back its complete write set if it throws.

A task is an async flow. It receives `act`, not a transaction held across an
`await`, so every state transition remains atomic. A task also exposes `status`,
`result`, and `error` addresses on its callable slot.

```ts
store.state.increment(2);

await store.state.sync();
console.log(store.get(store.state.sync.status));
```

### Anonymous derivations

Use `store.derive()` when a computed address should not be part of the schema:

```ts
const isPositive = store.derive((get) => get(store.state.count) > 0);
```

Create an anonymous derivation once rather than during a render. If it belongs to a
shorter-lived scope, call `store.release(isPositive)` when that scope ends.

## Resources

A resource gives async data the same structural address as local data. The store
owns its load state, cached value, dependency tracking, cancellation, and optional
write-back or live channel.

```ts
import { createStore, resource, segment } from 'segment-state';

interface Profile {
	name: string;
	bio: string;
}

const store = createStore({
	users: segment({
		profile: resource<Profile>(),
	}),
}).with(() => ({
	users: {
		profile: {
			load: async ({ key, signal }) => {
				const response = await fetch(`/api/users/${key}`, { signal });
				return (await response.json()) as Profile;
			},
			save: async ({ key, value, signal }) => {
				await fetch(`/api/users/${key}`, {
					method: 'PUT',
					body: JSON.stringify(value),
					signal,
				});
			},
		},
	},
}));

const profile = store.state.users.at('42').profile;
const snapshot = store.resource(profile);

console.log(snapshot.status); // idle | pending | ready | error
await snapshot.promise;
await store.save(profile, { name: 'Ada', bio: 'Programmer' });
```

The first read starts the load. Reads of the same address share one cache entry and
one in-flight request. `save()` updates optimistically and restores the previous
value if the save rejects.

The remaining lifecycle operations are explicit:

```ts
await store.refresh(profile); // supersede the current load and fetch again
store.forget(profile); // drop the cached value and resource state
```

A loader may call `get` to depend on ordinary state. When a dependency changes, a
settled resource becomes stale. A full implementation can also provide `live`, which
receives `emit` and `fail` and returns its teardown function.

### Resources with arguments

Arguments become path segments, so each argument set receives its own cache entry:

```ts
interface Result {
	title: string;
}

const searchStore = createStore({
	search: resource<Result[], [query: string, page: number]>(),
}).with(() => ({
	search: async ({ args: [query, page], signal }) => {
		const response = await fetch(`/search?q=${query}&page=${page}`, { signal });
		return (await response.json()) as Result[];
	},
}));

const pageTwo = searchStore.state.search('segment', 2);
console.log(pageTwo.path); // search/segment/2
```

Arguments must be primitives because they are encoded into the structural path. If
a value is a filter rather than part of identity, model it as state and read it from
the loader instead; changing that state will mark the resource stale.

### Standalone composition

Not every behavior needs a named schema slot. Plain stores can export ordinary
functions, anonymous derivations, and standalone resources:

```ts
const store = createStore({ query: '' });
const s = store.state;

export const queryLength = store.derive((get) => get(s.query).length);

export const search = store.resourceOf<Result[], [query: string]>(
	async ({ args: [query], signal }) => {
		const response = await fetch(`/search?q=${query}`, { signal });
		return (await response.json()) as Result[];
	},
);

export function setQuery(query: string): void {
	store.set(s.query, query, 'query/set');
}
```

Standalone resource addresses are numbered by creation order. Use them within a
session; use a declared resource when the address must be stable across persistence
or server rendering.

## Octane integration

Install `octane` next to Segment and import the optional adapter:

```sh
pnpm add segment-state octane
```

```tsx
import { useDraft, useStatus, useValue } from 'segment-state/octane';

function ProfileEditor({ id }: { id: string }) @{
	const profileRef = store.state.users.at(id).profile;
	const [profile] = useValue(profileRef);
	const status = useStatus(profileRef);
	const [draft, setDraft, publishDraft] = useDraft(profileRef);

	<p>{profile.name as string}</p>
	<p>{status.status as string}</p>
	<button onClick={() => setDraft({ ...draft, name: 'Ada' })}>{'Rename draft'}</button>
	<button onClick={publishDraft}>{'Publish draft'}</button>
}
```

`useValue(resourceRef)` waits for the resource through Octane's suspense model.
Passing an array to `useValue` starts independent resource reads in parallel.
`useStatus` never suspends; it returns the resource snapshot so the component can
draw each state itself. `useDraft` keeps a local edit and publishes it on demand.

There is no provider. A ref knows which store owns it. On the server, create one
store per request and pass that request's refs down; a module-global mutable store
would be shared across concurrent requests.

## Server rendering and hydration

`dehydrate()` produces a versioned, flat path-to-value payload. Derivations, actions,
and task run state are omitted because the client recomputes or re-creates them.

```ts
const full = store.dehydrate({ at: Date.now() });
const shell = store.dehydrate({ include: ['ui/**'] });

store.hydrate(full);
store.hydrate(full, { maxAge: 60_000 });
```

A hydrated resource is immediately ready and does not repeat the server's request.
When a stamped payload is older than `maxAge`, its value is adopted for first paint
but marked stale so it can refresh.

Scope any payload received from an external endpoint:

```ts
const result = store.hydrate(responsePayload, {
	allow: ['cart/**'],
	source: 'rpc:reprice',
});

console.log(result.applied, result.rejected, result.unknown);
```

Without `allow`, the payload may write any address represented in the store. Treat
the allow-list as the authority boundary for RPC responses and persisted data.

## Ports and commit streams

A port lets an external system participate using path strings rather than in-memory
refs:

```ts
const detach = store.attach({
	name: 'socket',
	attach(ctx) {
		const stopWatching = ctx.watch('users/*/profile', (path) => {
			console.log(path, ctx.read(path));
		});

		return stopWatching;
	},
});

const stopCommits = store.commits((commit) => {
	console.log(commit.id, commit.source, commit.writes);
});
```

`*` matches exactly one path segment. `**` matches one or more trailing segments
and must be the final token. A port that throws is isolated and detached so it
cannot break later commits.

Call the returned functions to detach the port or stop the commit subscription.

## Guarantees and boundaries

Segment guarantees:

- read-your-writes behavior inside a transaction;
- one commit per action and rollback of the full write set on throw;
- no commit for an `Object.is`-equal write;
- stable paths for a given schema within a major version;
- resource cancellation and stale-result suppression;
- pruning of dynamic nodes after their final observer detaches.

Do not depend on:

- observer notification order;
- whether a particular internal node is materialized;
- how many times a pure derivation evaluates;
- retention of node objects for an unobserved subtree;
- the exact numbering of `commit.id`;
- ref object identity inside an unbounded segment—compare `ref.path` instead.

For the trie, commit protocol, and complexity behind these guarantees, continue to
[Core internals](./core.md).

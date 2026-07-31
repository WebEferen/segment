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

### Composition without `.with()`

Not every behavior needs a named schema slot. `.with()` can be replaced by a
data-only schema plus ordinary exported functions, anonymous derivations, and
standalone resources:

```ts
import { createStore } from 'segment-state';

const store = createStore({ query: '', page: 1, updatedAt: 0 });
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

export function startNewSearch(query: string): void {
	store.act((tx) => {
		tx.set(s.query, query);
		tx.set(s.page, 1);
		tx.set(s.updatedAt, Date.now());
	}, 'search/start');
}

export async function publish(query: string): Promise<void> {
	const response = await fetch('/api/searches', {
		method: 'POST',
		body: JSON.stringify({ query }),
	});

	if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
```

Single calls to `set()` or `update()` already produce one commit. Use `act()` when a
function performs several writes that must be observed together. An ordinary async
function can return its natural result, but its lifecycle is yours to model; unlike
a declared `task()`, it has no automatic `status`, `result`, or `error` addresses.

Standalone derivations should be created once, not during a render, and released
with `store.release()` when their owning scope ends. Standalone resource addresses
are numbered by creation order. Use them within a session; use a declared resource
when the address must be stable across persistence or server rendering.

The two styles can coexist. A store may keep domain actions and persistent resources
in `.with()` while exporting small application-specific helpers as normal functions.

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

Segment does not move a live store from Node to the browser. The server and client
create separate stores from the same model, while `dehydrate()` and `hydrate()` move
only a versioned snapshot of addressable data between them:

Both functions live in the optional `segment-state/ssr` entry point, so an
application that only needs local state does not ship serialization code.

```text
request → fresh server store → render + dehydrate → HTML/JSON
                                                     ↓
first client render ← hydrate ← fresh client store ← payload
```

Hydration must finish before the client renderer mounts. That makes the first
browser read match the state that produced the server HTML and avoids a flash of
schema defaults or a hydration mismatch.

### 1. Share the model, not a store instance

Put the model in a module that both runtimes can import, and export a factory. The
factory also reinstalls derivations, actions, tasks, and resource implementations
when the model uses them.

```ts
// app-state.ts
import { cell, createStore } from 'segment-state';

export interface Viewer {
	id: string;
	name: string;
}

export function createAppStore() {
	return createStore({
		page: {
			title: '',
			viewer: cell<Viewer | null>(null),
		},
		ui: { theme: cell<'light' | 'dark'>('light') },
	});
}

export type AppStore = ReturnType<typeof createAppStore>;
```

Do not export one mutable `store` from this shared module for server use. Concurrent
requests would read and overwrite each other's state. Create one instance per
request and let it be collected when that request completes.

### 2. Render and dehydrate on the server

Populate the request's store, render with it, and stamp the payload. Escaping `<`
prevents user-controlled JSON from closing the raw-text `<script>` element early.
Use your framework's serializer instead when it provides an equivalent safe JSON
transport, and apply the application's normal CSP nonce when required.

```ts
// server.ts
import { dehydrate } from 'segment-state/ssr';
import { createAppStore } from './app-state.js';

export async function renderRequest(request: Request): Promise<string> {
	const store = createAppStore(); // isolated to this request

	store.patch(store.state.page, {
		title: 'Dashboard',
		viewer: await loadViewer(request),
	});

	const appHtml = await renderApp(store);
	const payload = dehydrate(store, { at: Date.now() });
	const payloadJson = JSON.stringify(payload).replaceAll('<', '\\u003c');

	return `<!doctype html>
		<div id="app">${appHtml}</div>
		<script id="segment-state" type="application/json">${payloadJson}</script>
		<script type="module" src="/client.js"></script>`;
}
```

Call `dehydrate()` only after all state needed for the server render has settled.
The payload is a flat `path → value` map with format version `v: 1`; `at` is
included only when the producer supplies it.

### 3. Hydrate before the first client render

Create a browser-owned store from the same factory, parse the payload, and hydrate
it before mounting the application:

```ts
// client.ts
import { hydrate, type Payload } from 'segment-state/ssr';
import { createAppStore } from './app-state.js';

const element = document.querySelector<HTMLScriptElement>('#segment-state');
const root = document.querySelector('#app');
if (!element?.textContent || !root) throw new Error('Incomplete SSR document');

const payload = JSON.parse(element.textContent) as Payload;
const store = createAppStore();
const result = hydrate(store, payload, { maxAge: 60_000 });

mountApp(store, root);
console.log(result.unknown); // paths absent from the current client model
```

`hydrate()` validates the payload version and applies known writable paths as one
atomic commit. Unknown paths are skipped and reported, which allows a controlled
schema rollout; an unsupported payload version throws instead of guessing.

### What crosses the boundary?

| State                                       | Serialized? | Client behavior                                            |
| ------------------------------------------- | ----------- | ---------------------------------------------------------- |
| Cells, branches, lists, and segment data    | Yes         | Adopted in one hydration commit.                           |
| Settled resource values                     | Yes         | Immediately ready; the initial request is not repeated.    |
| Derived values                              | No          | Recomputed from hydrated dependencies.                     |
| Actions and task run state                  | No          | Re-created by the shared store factory.                    |
| Observers, promises, and cancellation state | No          | Runtime-local and created only when the client needs them. |

When a stamped payload is older than `maxAge`, its resource value is still adopted
for first paint but marked stale so it can refresh behind that value. Without `at`
or `maxAge`, hydration does not infer an age.

### Partial and untrusted payloads

`include` and `exclude` make it possible to send a shell first and merge another
slice later. Every `hydrate()` call remains its own atomic commit:

```ts
import { dehydrate, hydrate } from 'segment-state/ssr';

const shell = dehydrate(serverStore, { include: ['ui/**'] });
const page = dehydrate(serverStore, { include: ['page/**'], at: Date.now() });

hydrate(clientStore, shell);
hydrate(clientStore, page, { maxAge: 60_000 });
```

Scope any payload received from an external endpoint or persistent storage:

```ts
const result = hydrate(store, responsePayload, {
	allow: ['cart/**'],
	source: 'rpc:reprice',
});

console.log(result.applied, result.rejected, result.unknown);
```

Without `allow`, the payload may write any writable address represented in the
store. Treat the allow-list as the authority boundary for RPC responses and
persisted data. The server-rendered payload in your own HTML is normally controlled
by the application; endpoints that accept or return state fragments should still
receive the narrowest practical `allow` list.

## Ports and commit streams

A port lets an external system participate using path strings rather than in-memory
refs:

```ts
import { attachPort } from 'segment-state/ports';

const detach = attachPort(store, {
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

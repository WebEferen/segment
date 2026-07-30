<p align="center">
	<img src="./assets/segment-state-logo.png" alt="Segment logo" width="240" />
</p>

<p align="center">Framework-agnostic state, addressed by path.</p>

# segment-state

```ts
import { createStore } from 'segment-state';

export const store = createStore({ theme: 'light', count: 0 });
export const s = store.state;

store.observe(s.count, () => console.log('count:', store.get(s.count)));
store.update(s.count, (count) => count + 1);
```

That is the whole core setup. A plain value is a piece of state, every value has a
structural address, and subscriptions wake only for the address that changed.

The default export and the compatibility `segment-state/core` entry point import
neither a UI framework nor the DOM, so they run in a browser, Node.js, and a worker.
The optional Octane hooks live at `segment-state/octane`.

> **Status: experimental.** APIs still move.

## Install

```sh
npm install segment-state
```

## Package entry points

| Import                 | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `segment-state`        | Framework-agnostic state engine         |
| `segment-state/core`   | Compatibility alias for the same engine |
| `segment-state/octane` | Optional Octane hooks                   |

Run the included interactive example with `pnpm playground`, or create a production
build with `pnpm playground:build`.

The playground consumes `segment-state` through `workspace:*`, so it never depends
on an already-published version. `pnpm publish` runs the full check, creates a real
tarball, installs it in a clean temporary consumer, and verifies the public exports
before anything is published. Run that packaging smoke test directly with
`pnpm pack:check`.

## Releasing

Publishing is driven by `.github/workflows/publish.yml`. Configure `segment-state`
on npm with a GitHub Actions trusted publisher for organization `WebEferen`,
repository `segment`, workflow `publish.yml`, and the `npm publish` action. Then bump
the package version on `main` and publish a GitHub Release tagged with the matching
`v<version>` value. The workflow validates that tag, runs the package lifecycle
checks, and publishes through short-lived OIDC credentials with automatic
provenance; no long-lived `NPM_TOKEN` is required.

## Why this exists

Every other store identifies a value by a **reference to an object** you created.
Segment identifies it by a **structural path** (`users/42/name`). Three things
follow that no reference-based store can offer:

- A service outside your components (a socket, a worker, a persistence layer,
  devtools) can read, write, and subscribe **without holding any JavaScript
  reference** into your state.
- The commit stream and the server payload are serializable by construction, so
  SSR, partial prerendering, and incremental regeneration are one mechanism rather
  than three plugins.
- **Memory is O(observed), not O(data).** A million records with 200 rows on
  screen keeps 402 live nodes. A node-per-field design needs 11,000,002.

## Declaring a store

A raw value declares state and supplies its initial value. You only reach for a
marker where a value cannot carry the information.

```ts
import { createStore, action, cell, derived, list, resource, segment, task } from 'segment-state';

type UserId = string & { readonly __brand: 'UserId' };

export const store = createStore({
	// Plain values. No marker needed.
	ui: { query: '', page: 1, compact: false },

	// Markers, only where a value cannot say it:
	theme: cell<'light' | 'dark'>('light'), // a narrowed union
	users: segment<UserId>()({
		// lots of records, keyed
		name: '',
		avatar: resource<string>(), // fetched
		initials: derived<string>(), // computed
	}),
	cart: {
		items: list({ sku: '', qty: 1 }), // each item's fields addressable
		total: derived<number>(),
		add: action<[sku: string]>(), // one commit
		checkout: task<[coupon?: string]>(), // async, several commits
	},
}).with((s) => ({
	users: {
		avatar: ({ key, signal }) => fetch(`/api/users/${key}`, { signal }).then((r) => r.json()),
		initials: (get) => get(s.users.at('x' as UserId).name).slice(0, 2),
	},
	cart: {
		total: (get) => get(s.cart.items.at(0).qty),
		add: (tx, sku) => tx.set(s.cart.items.at(0).sku, sku),
		checkout: async ({ act, get, signal }, coupon) => {
			act((tx) => tx.set(s.ui.page, 1));
			await fetch('/api/checkout', { body: JSON.stringify({ coupon }), signal });
		},
	},
}));

export const s = store.state;
```

`.with()` supplies the implementations for everything the shape declared as
computed. It is a separate call for a measured reason: a callback written **inside**
the shape literal cannot see the type being inferred from that literal, because
TypeScript collapses it to `never`. In `.with()` the shape is already resolved, so
`s` is in scope and no callback needs a `root` parameter. Its argument is
exhaustive by construction, so forgetting a derivation is a compile error.

A store of plain data never calls `.with()` at all.

### The whole vocabulary

Two of these three words never appear in your code, and that is the point.

| What you write        | Who answers a read               | Writable               |
| --------------------- | -------------------------------- | ---------------------- |
| `theme: 'light'`      | the store's memory               | yes                    |
| `derived<T>()`        | your function, on demand         | no, it is computed     |
| `resource<T>()`       | the network, cached by the store | through `save()`       |
| `ui: { … }`           | the addresses below it, together | through `patch()`      |
| `segment({ … })`      | the same, for a lot of data      | through `replaceAll()` |
| `action()` / `task()` | nothing, you call these          | no                     |

## Octane adapter

The optional adapter keeps the core independent from Octane while adding render-aware
subscriptions, Suspense integration, and drafts.

```tsx
import { useDraft, useStatus, useValue } from 'segment-state/octane';

const [theme, setTheme] = useValue(s.theme); //         read and write
const [total] = useValue(s.cart.total); //               derived: the setter is `never`
const [user] = useValue(s.users.at(id)); //              a whole record
const [avatar] = useValue(s.users.at(id).avatar); //     fetched: WAITS
const [[a, b]] = useValue([refA, refB]); //              two fetches, one wait
const [label] = useValue(store, (get, s) => …); //       computed here, per call site

const status = useStatus(s.users.at(id).avatar); //      the same, without waiting
const [name, setName, save] = useDraft(s.users.at(id).name); // edit, then publish
```

`useValue` reads **any** address, so you never have to know what kind of thing you
are reading before you can read it. A fetched address makes the component wait: it
does not render, the nearest `<Suspense>` shows its fallback, and a failure reaches
the nearest `@catch`. Pass an array to wait for several at once, which starts every
load before anything waits so the requests overlap.

You never combine these on one address. `useStatus` is the opt-out when you would
rather draw the loading and error states yourself, and `useDraft` is for an edit that
should wait for a Save button.

The setter's **type** is `never` for anything the store computes, so taking it is a
compile error rather than a runtime surprise.

Actions need no hook. They are plain functions on the tree:

```tsx
<button onClick={() => s.cart.add('sku-1')}>Add</button>
<button onClick={() => s.cart.checkout('SUMMER')}>Pay</button>
```

No provider, and no context on the read path: a ref knows which store it belongs
to. On the server you create a store per request and pass that request's `s` down;
a module-global store would be shared between concurrent requests, which is a
correctness bug rather than a style question.

## A component that fetches, and then writes back

```ts
// store.ts
export const store = createStore({
	users: segment({ profile: resource<Profile>() }),
}).with(() => ({
	users: {
		profile: {
			load: ({ key, signal }) => fetch(`/api/users/${key}`, { signal }).then((r) => r.json()),
			save: ({ key, value, signal }) =>
				fetch(`/api/users/${key}`, { method: 'PUT', body: JSON.stringify(value), signal }),
		},
	},
}));
export const s = store.state;
```

```tsx
// Profile.tsrx
function Body({ id }: { id: string }) @{
	const [profile] = useValue(s.users.at(id).profile);
	const status = useStatus(s.users.at(id).profile);
	const [draft, setDraft] = useState(profile.name);

	<div>
		<h2>{profile.name as string}</h2>
		<input value={draft as string} onInput={(e) => setDraft(e.currentTarget.value)} />
		<button onClick={() => void store.save(s.users.at(id).profile, { ...profile, name: draft })}>
			{'Save'}
		</button>
		@if (status.status === 'error') { <p>{'Could not save; the old name is back.'}</p> }
	</div>
}

export function Profile({ id }: { id: string }) @{
	<Suspense fallback={<p>{'Loading…'}</p>}>
		<Body id={id} />
	</Suspense>
}
```

No `useEffect`, no `isLoading`, no cache key, no invalidation. The fetch starts when
the component reads it, the result is cached at `users/<id>/profile`, and a second
component reading the same id shares it. `save` applies the new name immediately and
puts the old one back if the round trip rejects.

## Without `.with()`: everything as exported functions

`.with()` is optional. Declare only data, and make every computed thing an ordinary
export:

```ts
export const store = createStore({
	ui: { query: '', page: 1 },
	users: segment({ name: '', votes: 0 }),
});
export const s = store.state;

// A derivation: created once, at module scope.
export const queryLength = store.derive((get) => get(s.ui.query).length);

// A fetched value: call it with arguments to get an address.
export const fetchUserName = store.resourceOf<string, [id: string]>(
	async ({ args: [id], signal }) => (await fetch(`/api/users/${id}/name`, { signal })).text(),
);

// A getter and a setter, for use OUTSIDE a render.
export function getUserName(id: string): string {
	return store.get(s.users.at(id).name);
}
export function setUserName(id: string, name: string): void {
	store.set(s.users.at(id).name, name);
}

// An async flow: an ordinary async function. Each write is its own commit.
export async function publish(label: string): Promise<string> {
	store.set(s.ui.page, 1);
	const response = await fetch('/api/publish', { method: 'POST', body: label });
	return response.text();
}
```

```tsx
const [name] = useValue(s.users.at(id).name); //   in a render: subscribes
const [length] = useValue(queryLength);
const [fetched] = useValue(fetchUserName(id)); //  waits
<button onClick={() => setUserName(id, 'Ada')}>{'Rename'}</button>;
```

No source string is passed to `store.set`: in development the commit is named after
the calling function, so devtools shows `setUserName` without you writing it. Pass
one explicitly when you want a different name, or when you need names in production,
where the automatic one is not derived.

What you give up by skipping `.with()`: actions are not discoverable on `s.`, and an
async function has no automatic `status` / `result` / `error` addresses the way a
declared `task()` does. `store.resourceOf` addresses are also numbered by creation
order, so they are fine within a session but should not be persisted.

## Reading and writing outside a component

```ts
store.get(s.theme);
store.get(store.ref('users/u1/name')); //  by path, as an outside service would

store.set(s.theme, 'dark');
store.update(s.ui.page, (n) => n + 1);
store.patch(s.users.at(id), { name: 'Ada' }); //  the keys you give; the rest untouched
store.act((tx) => {
	//                                             several writes, ONE commit
	tx.set(s.ui.query, 'ada');
	tx.set(s.ui.page, 1);
}, 'search'); //                                   named in the commit stream
```

`store.*` is for OUTSIDE a render: an event handler, module code, a port, a test. It
reads a value but subscribes to nothing, so a component that called it would never
re-render. Inside a render use the hooks, which are the only thing that can
subscribe, wait, and clean up.

Actions are the only writers, and one action is one commit: no observer sees an
intermediate state, and **a throw rolls the entire write set back**. An optimistic
`save()` is the same machinery, restored if the round trip never confirms.

`store.patch` is deliberately one operation with one meaning: the keys you provide
are written, the rest are left alone. So "add a field" and "overwrite the record"
are the same call, with no merge-or-replace flag to get wrong.

## Fetching with arguments

Arguments become **path segments**, so `s.search('ada', 2)` addresses
`search/ada/2`. That is why the cache is per argument set with no separate cache
key, and why staleness, dehydration, and ports need no special case for it.

```ts
search: resource<Result[], [q: string, page: number]>(),
// .with():
search: async ({ args: [q, page], signal }) =>
	(await fetch(`/search?q=${q}&page=${page}`, { signal })).json(),
```

```tsx
const [hits] = useValue(s.search('ada', 2));
```

Arguments must be primitives, because they are stringified into the path.

If the loader has no slot in the schema, `store.resourceOf` gives it one:

```ts
export const search = store.resourceOf(async ({ args: [q] }) => fetchSearch(q));
// in a component: const [hits] = useValue(search('ada'));
```

When a parameter is a **filter** rather than an identity, it is usually better as
state: put it in a cell, read it through `get`, and moving it marks the resource
stale automatically, so a refetch can never be forgotten.

## Server rendering

One flat path-to-value payload covers all three shapes.

```ts
const payload = store.dehydrate({ at: Date.now() }); //  plain SSR
const shell = store.dehydrate({ include: ['ui/**'] }); // the static half, for PPR

store.hydrate(payload); //                               adopt, one commit
store.hydrate(payload, { maxAge: 60_000 }); //           past the window: ready AND stale
```

A resource adopted from a payload is ready **without fetching**, so the client does
not repeat the server's work.

For a payload that arrived over the wire, pass `allow`:

```ts
const result = store.hydrate(response, { allow: ['cart/**'], source: 'rpc:reprice' });
result.rejected; //  paths the server tried to write and was not allowed to
```

Without it, a response can write any address in the store, including local UI state
the server has no business touching.

## Ports

A port is how anything outside participates, addressing state by path so nothing
has to hand out object references.

```ts
store.attach({
	name: 'socket',
	attach(ctx) {
		const stop = ctx.watch('users/*/name', (path) => socket.send(path, ctx.read(path)));
		socket.on('patch', (path, value) => ctx.write(path, value));
		return stop;
	},
});
```

`*` matches one segment, `**` matches one or more trailing segments. A port that
throws is isolated and detached rather than breaking every future commit.
`store.commits(cb)` gives the same stream without a port.

## What is deliberately unspecified

Rely on these and a future release will break you:

- the order observers are notified in
- whether any particular node is materialized (that is the whole point)
- how many times a derivation runs, so it must be pure
- whether an unobserved subtree retains node objects
- the numbering of `commit.id`

Guaranteed instead: read-your-writes inside an action, one commit per action,
rollback on throw, an `Object.is`-equal write being a no-op, and path stability for
a given schema within a major version. Ref **identity** is not guaranteed through a
dynamic segment; compare `ref.path`, because interning an unbounded key space is
the leak this design exists to avoid.

## Further reading

- [`docs/core.md`](./docs/core.md) covers the agnostic core in detail: the trie,
  the commit protocol, the complexity of every operation, and the two measurements
  that constrain the implementation.

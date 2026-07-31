// A store that uses every kind of slot, plus every way to read and write it.
//
// This file exists to be TYPECHECKED: it is the worked example the docs quote, so
// nothing in the docs can drift away from what actually compiles.
import {
	action,
	cell,
	createStore,
	derived,
	list,
	resource,
	segment,
	task,
} from '../src/core/index.js';
import type { Port, Ref } from '../src/core/index.js';
import { attachPort } from '../src/ports/index.js';
import { dehydrate, hydrate, type Payload } from '../src/ssr/index.js';

type UserId = string & { readonly __brand: 'UserId' };
type Theme = 'light' | 'dark';

interface Profile {
	bio: string;
	links: string[];
}

// ── The store ───────────────────────────────────────────────────────────────

export const store = createStore({
	// PLAIN STATE. A raw value is the declaration; the type is widened, so a cell
	// holding 'light' still accepts any string.
	ui: {
		query: '',
		page: 1,
		compact: false,
		openedAt: new Date(0),
		// Markers only where a value cannot carry the information:
		theme: cell<Theme>('light'), //  a narrowed union
		recent: [] as string[], //        an array is ONE value
		layout: cell({ cols: 3, gap: 8 }), // a plain object kept whole
	},

	// A SEGMENT: bulk data, nodes below it materialize only while observed.
	users: segment<UserId>()({
		name: '',
		age: 0,
		// async, fetched per key
		profile: resource<Profile>(),
		// sync computed, per key
		initials: derived<string>(),
	}),

	// Many, keyed. `segment` is the only "many keyed" marker: there is no second
	// one to choose between.
	flags: segment({ on: false, note: '' }),

	cart: {
		// A LIST: each item's fields get their own address.
		items: list({ sku: '', qty: 1, price: 0 }),
		// sync computed
		total: derived<number>(),
		count: derived<number>(),
		// sync mutator: ONE commit, all or nothing
		add: action<[sku: string, price: number]>(),
		clear: action(),
		// async mutator: SEVERAL commits over time, each atomic
		checkout: task<[coupon?: string]>(),
	},

	checkout: { status: cell<'idle' | 'sending' | 'done' | 'failed'>('idle'), error: '' },
}).with((s, act) => ({
	users: {
		// A resource in its full form: load, write-back, and an outside push channel.
		profile: {
			load: async ({ key, signal }): Promise<Profile> => {
				const response = await fetch(`/api/users/${key}/profile`, { signal });
				return (await response.json()) as Profile;
			},
			save: async ({ key, value, signal }) => {
				await fetch(`/api/users/${key}/profile`, {
					method: 'PUT',
					body: JSON.stringify(value),
					signal,
				});
			},
			live: ({ key, emit }) => {
				const socket = new EventTarget();
				const onMessage = () => emit({ bio: `pushed for ${key}`, links: [] });
				socket.addEventListener('profile', onMessage);
				return () => socket.removeEventListener('profile', onMessage);
			},
		},
		// A derivation reads through `get`; `s` is in scope from the closure.
		initials: (get) =>
			get(s.ui.query)
				.split(' ')
				.map((word) => word[0] ?? '')
				.join(''),
	},

	cart: {
		total: (get) =>
			get(s.cart.items.at(0).qty) * get(s.cart.items.at(0).price) +
			get(s.cart.items.at(1).qty) * get(s.cart.items.at(1).price),
		count: (get) => get(s.cart.items.at(0).qty) + get(s.cart.items.at(1).qty),

		// SYNC mutator. One transaction: either every write lands or none does.
		add: (tx, sku, price) => {
			tx.set(s.cart.items.at(0).sku, sku);
			tx.set(s.cart.items.at(0).price, price);
			tx.update(s.cart.items.at(0).qty, (n) => n + 1);
		},
		clear: (tx) => {
			tx.set(s.cart.items.at(0).sku, '');
			tx.set(s.cart.items.at(0).qty, 0);
		},

		// ASYNC mutator. It receives `act`, not `tx`: a `tx` is live only for one
		// synchronous transaction, so a write after an `await` would be staged into
		// an already-committed set and lost.
		checkout: async ({ act: run, get, signal }, coupon) => {
			run((tx) => tx.set(s.checkout.status, 'sending'));
			try {
				const response = await fetch('/api/checkout', {
					method: 'POST',
					body: JSON.stringify({ total: get(s.cart.total), coupon }),
					signal,
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				run((tx) => {
					tx.set(s.checkout.status, 'done');
					tx.set(s.cart.items.at(0).qty, 0);
				});
			} catch (error) {
				run((tx) => {
					tx.set(s.checkout.status, 'failed');
					tx.set(s.checkout.error, String(error));
				});
			}
			void act; // the outer `act` is the same runner, available to any impl
		},
	},
}));

export const s = store.state;
declare const uid: UserId;

// ── Anonymous derivation: computed, shared, not named in the schema ─────────

export const heavySubtotal = store.derive((get) => get(s.cart.total) * 1.23);

// ── GETTERS, outside a component ───────────────────────────────────────────

export const theme: Theme = store.get(s.ui.theme);
export const qty: number = store.get(s.cart.items.at(2).qty);
export const name: string = store.get(s.users.at(uid).name);
export const initials: string = store.get(s.users.at(uid).initials); // derivation
export const withTax: number = store.get(heavySubtotal); // anonymous derivation
export const layout: { cols: number; gap: number } = store.get(s.ui.layout);

// A whole record, as stored. Undefined for a key nothing has written.
export const record = store.get(s.users.at(uid));

// A resource: the full state machine, never a bare value.
const profile = store.resource(s.users.at(uid).profile);
export const profileStatus: 'idle' | 'pending' | 'ready' | 'error' = profile.status;
export const profileValue: Profile | undefined = profile.value;
export const profileWaiting: Promise<Profile> | null = profile.promise;
export const profileStale: boolean = profile.stale;

// Addressing from outside: a path string, validated against the schema.
export const byPath: Ref<unknown> = store.ref('users/u1/name');
export const viaPath: unknown = store.get(byPath);

// O(1) staleness for a whole subtree, without holding its value.
export const usersRevision: number = store.revision(store.ref('users'));
export const what = store.kindOf(s.cart.total); // 'derived'

// ── SETTERS ────────────────────────────────────────────────────────────────

store.set(s.ui.theme, 'dark'); //                one write, one commit
store.update(s.ui.page, (n) => n + 1); //         read-modify-write
store.act((tx) => {
	//                                            several writes, ONE commit
	tx.set(s.ui.query, 'ada');
	tx.set(s.ui.page, 1);
}, 'search'); //                                  attributed in the commit stream

s.cart.add('sku-1', 9.99); //                     sync action from the tree
export const running: Promise<void> = s.cart.checkout('SUMMER'); // async task

await store.save(s.users.at(uid).profile, { bio: 'hi', links: [] }); // optimistic
await store.refresh(s.users.at(uid).profile); //  force a reload
store.forget(s.users.at(uid).profile); //         drop value and state

// Bulk: O(1) at the segment, only materialized observers are woken.
s.users.replaceAll({ [uid]: { name: 'Ada', age: 36, profile: { bio: '', links: [] } } } as never);
export const everyUser = s.users.snapshot();

// ── SERVER RENDERING ───────────────────────────────────────────────────────

export const full: Payload = dehydrate(store, { at: 1 });
export const shell: Payload = dehydrate(store, { include: ['ui/**'], at: 1 });
hydrate(store, full, { maxAge: 60_000 }); //        adopt, marking stale past the window
// From the wire: scope what a response may touch.
const applied = hydrate(store, shell, { allow: ['ui/**'], source: 'rpc:loadShell' });
export const rejectedPaths: readonly string[] = applied.rejected;

// ── PORTS: anything outside, addressing by path ─────────────────────────────

const socketPort: Port = {
	name: 'socket',
	attach(ctx) {
		const stop = ctx.watch('users/*/name', (path) => void ctx.read(path));
		const unsubscribe = ctx.commits((commit) => void commit.writes.length);
		return () => {
			stop();
			unsubscribe();
		};
	},
};
export const detach = attachPort(store, socketPort);
export const counts = store.stats();

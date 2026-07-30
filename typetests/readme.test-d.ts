// The README and guide examples, typechecked. Documentation that has never been
// compiled drifts, and the first snippet a reader tries is the worst place to be
// wrong.
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

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// ── "Quick start" ───────────────────────────────────────────────────────────

const quick = createStore({ todos: segment({ title: '', completed: false }) });
const q = quick.state;
q.todos.replaceAll({ docs: { title: 'Ship the documentation', completed: false } });
const completed = q.todos.at('docs').completed;
export type _QuickCell = Expect<Equal<ReturnType<typeof quick.get<boolean>>, boolean>>;
const stop = quick.observe(completed, () => void quick.get(completed));
quick.update(completed, (value) => !value, 'todo/toggle');
stop();

// ── "Declaring a store" ─────────────────────────────────────────────────────

type UserId = string & { readonly __brand: 'UserId' };

interface Result {
	title: string;
}

export const store = createStore({
	ui: { query: '', page: 1, compact: false },
	theme: cell<'light' | 'dark'>('light'),
	users: segment<UserId>()({
		name: '',
		avatar: resource<string>(),
		initials: derived<string>(),
	}),
	cart: {
		items: list({ sku: '', qty: 1 }),
		total: derived<number>(),
		add: action<[sku: string]>(),
		checkout: task<[coupon?: string]>(),
	},
	search: resource<Result[], [q: string, page: number]>(),
}).with((s) => ({
	users: {
		avatar: ({ key, signal }) => fetch(`/api/users/${key}`, { signal }).then((r) => r.text()),
		initials: (get) => get(s.ui.query).slice(0, 2),
	},
	cart: {
		total: (get) => get(s.cart.items.at(0).qty),
		add: (tx, sku) => tx.set(s.cart.items.at(0).sku, sku),
		checkout: async ({ act, signal }, coupon) => {
			act((tx) => tx.set(s.ui.page, 1));
			await fetch('/api/checkout', { body: JSON.stringify({ coupon }), signal });
		},
	},
	search: async ({ args: [text, page], signal }) =>
		(await fetch(`/search?q=${text}&page=${page}`, { signal })).json() as Promise<Result[]>,
}));

export const s = store.state;
declare const uid: UserId;

// ── "Reading and writing outside a component" ──────────────────────────────

export const theme: 'light' | 'dark' = store.get(s.theme);
export const byPath: unknown = store.get(store.ref('users/u1/name'));

store.set(s.theme, 'dark');
store.update(s.ui.page, (n) => n + 1);
store.patch(s.users.at(uid), { name: 'Ada' });
store.act((tx) => {
	tx.set(s.ui.query, 'ada');
	tx.set(s.ui.page, 1);
}, 'search');

s.cart.add('sku-1');
export const paying: Promise<void> = s.cart.checkout('SUMMER');

// ── "Fetching with arguments" ──────────────────────────────────────────────

export const hitsRef = s.search('ada', 2);
export type _SearchAddress = Expect<Equal<typeof hitsRef.path, string>>;

export const standalone = store.resourceOf<Result[], [q: string]>(
	async ({ args: [text] }) => (await fetch(`/search?q=${text}`)).json() as Promise<Result[]>,
);
export const standaloneRef = standalone('ada');

// ── "Server rendering" ─────────────────────────────────────────────────────

const payload = store.dehydrate({ at: 1 });
const shell = store.dehydrate({ include: ['ui/**'] });
store.hydrate(payload);
store.hydrate(payload, { maxAge: 60_000 });
const applied = store.hydrate(shell, { allow: ['cart/**'], source: 'rpc:reprice' });
export const rejected: readonly string[] = applied.rejected;

// ── "Ports" ────────────────────────────────────────────────────────────────

export const detach = store.attach({
	name: 'socket',
	attach(ctx) {
		const stop = ctx.watch('users/*/name', (path) => void ctx.read(path));
		ctx.write('ui/query', 'ada');
		return stop;
	},
});
export const unsubscribe = store.commits((commit) => void commit.writes.length);

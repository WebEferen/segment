// A resource whose arguments ARE its address. This is what makes the cache per
// argument set without a separate cache key, and what lets staleness, dehydrate,
// and ports treat it like any other address.
import { describe, expect, it, vi } from 'vitest';
import { createStore, resource } from '../src/core/index.js';
import type { LoadContext } from '../src/core/index.js';
import { dehydrate, hydrate } from '../src/ssr/index.js';
import { flush } from './resource-fixture.js';

// The loader lives OUTSIDE `.with()`: it is an ordinary exported function, which
// is what makes it unit-testable on its own.
export async function loadSearch({ args: [q, page] }: LoadContext<[string, number]>) {
	return `hits:${q}:${page}`;
}

function makeSearchStore() {
	const calls: Array<[string, number]> = [];
	const store = createStore({
		region: 'eu',
		search: resource<string, [q: string, page: number]>(),
	}).with(() => ({
		search: (ctx: LoadContext<[string, number]>) => {
			calls.push(ctx.args);
			return loadSearch(ctx);
		},
	}));
	return { store, s: store.state, calls };
}

describe('a resource with arguments', () => {
	it('turns its arguments into the address', () => {
		const { s } = makeSearchStore();
		expect(s.search('ada', 2).path).toBe('search/ada/2');
	});

	it('caches per argument set, because the address IS the cache key', async () => {
		const { store, s, calls } = makeSearchStore();
		store.resource(s.search('ada', 1));
		store.resource(s.search('ada', 1));
		store.resource(s.search('ada', 2));
		await flush();

		// Two distinct addresses, so two loads; the repeat shared the first.
		expect(calls).toEqual([
			['ada', '1'],
			['ada', '2'],
		]);
		expect(store.get(s.search('ada', 1))).toBe('hits:ada:1');
		expect(store.get(s.search('ada', 2))).toBe('hits:ada:2');
	});

	it('wakes only the observer of the address that settled', async () => {
		const { store, s } = makeSearchStore();
		const one = vi.fn();
		const two = vi.fn();
		store.observe(s.search('ada', 1), one);
		store.observe(s.search('ada', 2), two);
		await flush();
		expect(one).toHaveBeenCalled();
		expect(two).toHaveBeenCalled();
		one.mockClear();
		two.mockClear();
		await store.refresh(s.search('ada', 1));
		expect(one).toHaveBeenCalled();
		expect(two).not.toHaveBeenCalled();
	});

	it('dehydrates and rehydrates without refetching', async () => {
		const server = makeSearchStore();
		server.store.resource(server.s.search('ada', 1));
		await flush();
		const payload = dehydrate(server.store);

		const client = makeSearchStore();
		hydrate(client.store, payload);
		const snap = client.store.resource(client.s.search('ada', 1));
		expect(snap.status).toBe('ready');
		expect(snap.value).toBe('hits:ada:1');
		expect(client.calls).toEqual([]);
	});

	it('refuses a non-primitive argument, because arguments are path segments', () => {
		const { s } = makeSearchStore();
		expect(() => (s.search as unknown as (a: unknown, b: unknown) => void)({}, 1)).toThrow(
			/must be strings, numbers, or booleans/,
		);
	});

	it('pins the argument count after the first use', () => {
		const { s } = makeSearchStore();
		s.search('ada', 1);
		expect(() => (s.search as unknown as (a: string) => void)('ada')).toThrow(
			/addressed with 2 argument\(s\)/,
		);
	});

	it('still works as a plain address when it declares no arguments', async () => {
		const store = createStore({ plain: resource<string>() }).with(() => ({
			plain: async () => 'value',
		}));
		const snap = store.resource(store.state.plain);
		expect(snap.status).toBe('pending');
		await snap.promise;
		expect(store.get(store.state.plain)).toBe('value');
	});
});

describe('store.resourceOf', () => {
	// The standalone form: the loader is an ordinary exported function, and calling
	// the result with arguments produces an address.
	const store = createStore({ n: 0 });
	const search = store.resourceOf<string, [q: string, page: number]>(
		async ({ args: [q, page] }) => `hits:${q}:${page}`,
	);

	it('produces an address from its arguments', () => {
		expect(search('ada', 2).path).toMatch(/^\$fetch:\d+\/ada\/2$/);
	});

	it('loads, caches per argument set, and reads back', async () => {
		store.resource(search('ada', 1));
		store.resource(search('ada', 1));
		await flush();
		expect(store.get(search('ada', 1))).toBe('hits:ada:1');
		expect(store.resource(search('ada', 1)).status).toBe('ready');
	});

	it('takes the no-argument form too', async () => {
		const local = createStore({ n: 0 });
		const all = local.resourceOf(async () => 'everything');
		await local.resource(all).promise;
		expect(local.get(all)).toBe('everything');
	});

	it('can be released, like an anonymous derivation', () => {
		const local = createStore({ n: 0 });
		const baseline = local.stats().nodes;
		const one = local.resourceOf(async () => 'x');
		expect(local.stats().nodes).toBe(baseline + 1);
		local.release(one);
		expect(local.stats().nodes).toBe(baseline);
	});

	it('refuses to release something the schema declared', () => {
		const local = createStore({ n: 0 });
		expect(() => local.release(local.state.n)).toThrow(/lives as long as the store/);
	});

	it('keeps its reserved prefix out of an author address space', () => {
		expect(() => createStore({ '$fetch:0': 1 })).toThrow(/reserved/);
	});
});

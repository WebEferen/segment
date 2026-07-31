// Server rendering. The point of a FLAT payload is that plain SSR, partial
// prerendering, and incremental regeneration stop being three mechanisms:
// slicing by pattern and merging two payloads are both trivial on a flat map.
import { describe, expect, it, vi } from 'vitest';
import { dehydrate, hydrate } from '../src/ssr/index.js';
import { makeStore, uid } from './fixture.js';
import { flush, makeResourceStore } from './resource-fixture.js';

describe('dehydrate', () => {
	it('captures cells and bulk partitions, and omits computed slots', () => {
		const { store, s } = makeStore();
		store.act((tx) => {
			tx.set(s.ui.count, 7);
			tx.set(s.users.at(uid(1)).name, 'Ada');
		});
		const payload = dehydrate(store);

		expect(payload.v).toBe(1);
		expect(payload.data['ui/count']).toBe(7);
		expect(payload.data['ui/theme']).toBe('light');
		expect(payload.data['users']).toEqual({ u1: { name: 'Ada' } });
		// A derivation is recomputed on arrival; an action is code.
		expect(Object.keys(payload.data)).not.toContain('calc/sum');
		expect(Object.keys(payload.data)).not.toContain('cart/bump');
	});

	it('ships only the requested slice, which is what a static shell needs', () => {
		const { store, s } = makeStore();
		store.act((tx) => tx.set(s.users.at(uid(1)).name, 'Ada'));
		const shell = dehydrate(store, { include: ['ui/**'] });
		expect(Object.keys(shell.data).sort()).toEqual(['ui/count', 'ui/theme']);

		const dynamic = dehydrate(store, { exclude: ['ui/**'] });
		expect(Object.keys(dynamic.data)).not.toContain('ui/count');
		expect(dynamic.data['users']).toEqual({ u1: { name: 'Ada' } });
	});

	it('records a production time only when asked', () => {
		const { store } = makeStore();
		expect(dehydrate(store).at).toBeUndefined();
		expect(dehydrate(store, { at: 1000 }).at).toBe(1000);
	});
});

describe('hydrate', () => {
	it('adopts a payload as ONE commit', () => {
		const source = makeStore();
		source.store.act((tx) => {
			tx.set(source.s.ui.count, 5);
			tx.set(source.s.ui.theme, 'dark');
			tx.set(source.s.users.at(uid(1)).name, 'Ada');
		});
		const payload = dehydrate(source.store);

		const client = makeStore();
		const commits: string[] = [];
		client.store.commits((commit) => commits.push(commit.source));
		hydrate(client.store, payload);

		expect(client.store.get(client.s.ui.count)).toBe(5);
		expect(client.store.get(client.s.ui.theme)).toBe('dark');
		expect(client.store.get(client.s.users.at(uid(1)).name)).toBe('Ada');
		expect(commits).toEqual(['hydrate']);
	});

	it('wakes an observer of a hydrated leaf', () => {
		const source = makeStore();
		source.store.act((tx) => tx.set(source.s.ui.count, 5));
		const payload = dehydrate(source.store);

		const client = makeStore();
		const observer = vi.fn();
		client.store.observe(client.s.ui.count, observer);
		hydrate(client.store, payload);
		expect(observer).toHaveBeenCalledTimes(1);
	});

	it('wakes an observer inside a hydrated partition', () => {
		const source = makeStore();
		source.store.act((tx) => tx.set(source.s.users.at(uid(1)).name, 'Ada'));
		const payload = dehydrate(source.store);

		const client = makeStore();
		const observer = vi.fn();
		client.store.observe(client.s.users.at(uid(1)).name, observer);
		hydrate(client.store, payload);
		expect(observer).toHaveBeenCalledTimes(1);
		expect(client.store.get(client.s.users.at(uid(1)).name)).toBe('Ada');
	});

	it('recomputes derivations from hydrated inputs rather than trusting a shipped value', () => {
		const source = makeStore();
		source.store.act((tx) => tx.set(source.s.ui.count, 5));
		const payload = dehydrate(source.store);

		const client = makeStore();
		hydrate(client.store, payload);
		expect(client.store.get(client.s.calc.sum)).toBe(5 * 2 + 6);
	});

	it('merges a static shell and a dynamic slice, which is partial prerendering', () => {
		const source = makeStore();
		source.store.act((tx) => {
			tx.set(source.s.ui.theme, 'dark');
			tx.set(source.s.users.at(uid(1)).name, 'Ada');
		});
		const shell = dehydrate(source.store, { include: ['ui/**'] });
		const dynamic = dehydrate(source.store, { exclude: ['ui/**'] });

		const client = makeStore();
		hydrate(client.store, shell);
		expect(client.store.get(client.s.ui.theme)).toBe('dark');
		hydrate(client.store, dynamic);
		expect(client.store.get(client.s.users.at(uid(1)).name)).toBe('Ada');
		// The shell survived the second merge.
		expect(client.store.get(client.s.ui.theme)).toBe('dark');
	});

	it('skips a path the current schema no longer describes', () => {
		const client = makeStore();
		expect(() =>
			hydrate(client.store, { v: 1, data: { 'gone/away': 1, 'ui/count': 3 } }),
		).not.toThrow();
		expect(client.store.get(client.s.ui.count)).toBe(3);
	});

	it('rejects a payload version it cannot read', () => {
		const client = makeStore();
		expect(() => hydrate(client.store, { v: 2 as never, data: {} })).toThrow(
			/unsupported payload version/,
		);
	});
});

describe('hydrate: resources', () => {
	it('adopts a server-resolved resource without fetching', async () => {
		const server = makeResourceStore();
		server.store.resource(server.s.users.at('u1').avatar);
		server.settle('avatar:u1', 'https://img/1');
		await flush();
		const payload = dehydrate(server.store);

		const client = makeResourceStore();
		hydrate(client.store, payload);
		const snap = client.store.resource(client.s.users.at('u1').avatar);
		expect(snap.status).toBe('ready');
		expect(snap.value).toBe('https://img/1');
		expect(snap.promise).toBeNull();
		// The whole point: the client did not repeat the server's work.
		expect(client.loads).toEqual([]);
	});

	it('marks an adopted resource stale past maxAge, without blocking the first paint', () => {
		const client = makeResourceStore();
		hydrate(
			client.store,
			{ v: 1, at: Date.now() - 60_000, data: { users: { u1: { avatar: 'cached' } } } },
			{ maxAge: 1_000 },
		);
		const snap = client.store.resource(client.s.users.at('u1').avatar);
		expect(snap.status).toBe('ready');
		expect(snap.value).toBe('cached');
		expect(snap.stale).toBe(true);
		// Adopted, so nothing was fetched to render it.
		expect(client.loads).toEqual([]);
	});

	it('leaves a fresh payload unmarked', () => {
		const client = makeResourceStore();
		hydrate(
			client.store,
			{ v: 1, at: Date.now(), data: { users: { u1: { avatar: 'cached' } } } },
			{ maxAge: 60_000 },
		);
		expect(client.store.resource(client.s.users.at('u1').avatar).stale).toBe(false);
	});

	it('does not judge staleness without a production time', () => {
		const client = makeResourceStore();
		hydrate(client.store, { v: 1, data: { users: { u1: { avatar: 'cached' } } } }, { maxAge: 1 });
		expect(client.store.resource(client.s.users.at('u1').avatar).stale).toBe(false);
	});

	it('keeps two stores isolated, which is what per-request rendering needs', () => {
		const a = makeStore();
		const b = makeStore();
		a.store.act((tx) => tx.set(a.s.ui.count, 111));
		expect(b.store.get(b.s.ui.count)).toBe(0);
		expect(a.store.get(a.s.ui.count)).toBe(111);
	});
});

describe('hydrate: a payload from the wire', () => {
	it('drops any path the allowlist does not cover', () => {
		const { store, s } = makeStore();
		const result = hydrate(
			store,
			{ v: 1, data: { 'cart/items': [{ sku: 'a', qty: 2 }], 'ui/theme': 'dark' } },
			{ allow: ['cart/**'] },
		);
		expect(result.applied).toEqual(['cart/items']);
		expect(result.rejected).toEqual(['ui/theme']);
		// The server had no business touching local UI state, and it did not.
		expect(store.get(s.ui.theme)).toBe('light');
		expect(store.get(s.cart.items.at(0).sku)).toBe('a');
	});

	it('applies everything when no allowlist is given', () => {
		const { store, s } = makeStore();
		const result = hydrate(store, { v: 1, data: { 'ui/theme': 'dark' } });
		expect(result.applied).toEqual(['ui/theme']);
		expect(result.rejected).toEqual([]);
		expect(store.get(s.ui.theme)).toBe('dark');
	});

	it('reports an unknown path separately from a rejected one', () => {
		const { store } = makeStore();
		const result = hydrate(
			store,
			{ v: 1, data: { 'gone/away': 1, 'ui/theme': 'dark', 'ui/count': 2 } },
			{ allow: ['ui/**', 'gone/**'] },
		);
		expect(result.unknown).toEqual(['gone/away']);
		expect(result.applied.sort()).toEqual(['ui/count', 'ui/theme']);
	});

	it('refuses to write a derived or an action even when allowed', () => {
		const { store } = makeStore();
		const result = hydrate(
			store,
			{ v: 1, data: { 'calc/sum': 999, 'cart/bump': 1 } },
			{ allow: ['**'] },
		);
		expect(result.applied).toEqual([]);
		expect(result.rejected.sort()).toEqual(['calc/sum', 'cart/bump']);
	});

	it('attributes a server patch so devtools can show where it came from', () => {
		const { store } = makeStore();
		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));
		hydrate(store, { v: 1, data: { 'ui/theme': 'dark' } }, { source: 'rpc:updateTheme' });
		expect(sources).toEqual(['rpc:updateTheme']);
	});

	it('round-trips a slice a client sent up and a server sent back', () => {
		const client = makeStore();
		client.store.act((tx) => tx.set(client.s.cart.items.at(0).qty, 3));

		// What the client would send as the RPC argument.
		const request = dehydrate(client.store, { include: ['cart/**'] });
		expect(request.data['cart/items']).toEqual([{ qty: 3 }]);

		// What a server function would return, scoped on arrival.
		const response = { v: 1 as const, data: { 'cart/items': [{ sku: 'x', qty: 9 }] } };
		hydrate(client.store, response, { allow: ['cart/**'], source: 'rpc:repriceCart' });
		expect(client.store.get(client.s.cart.items.at(0).qty)).toBe(9);
	});

	it('wakes an observed derivation whose inputs arrived by hydration', () => {
		const server = makeStore();
		server.store.act((tx) => tx.set(server.s.ui.count, 21));
		const payload = dehydrate(server.store);

		const client = makeStore();
		const woken = vi.fn();
		client.store.observe(client.s.calc.double, woken);
		expect(client.store.get(client.s.calc.double)).toBe(0);
		hydrate(client.store, payload);
		// The derivation's readers subscribed to an address nothing writes
		// directly, so the hydrate commit itself has to push it.
		expect(woken).toHaveBeenCalledTimes(1);
		expect(client.store.get(client.s.calc.double)).toBe(42);
	});
});

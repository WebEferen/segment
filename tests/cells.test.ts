import { describe, expect, it } from 'vitest';
import { makeStore, uid } from './fixture.js';

describe('cells', () => {
	it('reads a schema-bounded cell before anything is written', () => {
		const { store, s } = makeStore();
		expect(store.get(s.ui.count)).toBe(0);
		expect(store.get(s.ui.theme)).toBe('light');
	});

	it('falls back to the declared initial value inside a segment', () => {
		const { store, s } = makeStore();
		// Nothing has ever touched u7, and no node exists for it.
		expect(store.get(s.users.at(uid(7)).name)).toBe('anonymous');
		expect(store.get(s.users.at(uid(7)).age)).toBe(0);
	});

	it('writes and reads back through a segment', () => {
		const { store, s } = makeStore();
		store.act((tx) => tx.set(s.users.at(uid(1)).name, 'Ada'));
		expect(store.get(s.users.at(uid(1)).name)).toBe('Ada');
		// A sibling key is untouched.
		expect(store.get(s.users.at(uid(2)).name)).toBe('anonymous');
	});

	it('writes into a list by index', () => {
		const { store, s } = makeStore();
		store.act((tx) => {
			tx.set(s.cart.items.at(0).sku, 'abc');
			tx.set(s.cart.items.at(0).qty, 3);
			tx.set(s.cart.items.at(1).sku, 'def');
		});
		expect(store.get(s.cart.items.at(0).sku)).toBe('abc');
		expect(store.get(s.cart.items.at(0).qty)).toBe(3);
		expect(store.get(s.cart.items.at(1).sku)).toBe('def');
		expect(store.get(s.cart.items.at(1).qty)).toBe(1);
	});

	it('treats an Object.is-equal write as no change', () => {
		const { store, s } = makeStore();
		let commits = 0;
		store.commits(() => commits++);
		store.act((tx) => tx.set(s.ui.count, 0));
		expect(commits).toBe(0);
		store.act((tx) => tx.set(s.ui.count, 1));
		expect(commits).toBe(1);
		store.act((tx) => tx.set(s.ui.count, 1));
		expect(commits).toBe(1);
	});

	it('exposes a stable path on every ref', () => {
		const { s } = makeStore();
		expect(s.ui.count.path).toBe('ui/count');
		expect(s.users.at(uid(3)).name.path).toBe('users/u3/name');
		expect(s.cart.items.at(2).qty.path).toBe('cart/items/2/qty');
	});

	it('addresses the same state from a path string and from the accessor tree', () => {
		const { store, s } = makeStore();
		store.act((tx) => tx.set(s.users.at(uid(9)).age, 41));
		expect(store.get(store.ref('users/u9/age'))).toBe(41);
	});

	it('runs an action as one transaction', () => {
		const { store, s } = makeStore();
		let commits = 0;
		store.commits(() => commits++);
		s.cart.reset();
		// reset writes theme='light' (unchanged) and count=0 (unchanged): no commit.
		expect(commits).toBe(0);
		s.cart.bump(5);
		expect(store.get(s.ui.count)).toBe(5);
		expect(commits).toBe(1);
	});
});

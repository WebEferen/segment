// `revision` is the O(1) subtree staleness check. It exists because the version
// stamps were otherwise write-only state: the README described a mechanism that
// nothing read, which is a claim the code did not back. This file is what makes
// it real.
import { describe, expect, it } from 'vitest';
import { makeStore, uid } from './fixture.js';

describe('revision', () => {
	it('moves when the addressed value is written', () => {
		const { store, s } = makeStore();
		const before = store.revision(s.ui.count);
		store.act((tx) => tx.set(s.ui.count, 1));
		expect(store.revision(s.ui.count)).not.toBe(before);
	});

	it('does not move for an unchanged write', () => {
		const { store, s } = makeStore();
		store.act((tx) => tx.set(s.ui.count, 1));
		const before = store.revision(s.ui.count);
		store.act((tx) => tx.set(s.ui.count, 1));
		expect(store.revision(s.ui.count)).toBe(before);
	});

	it('does not move for a write to an unrelated branch', () => {
		const { store, s } = makeStore();
		const before = store.revision(s.ui.count);
		store.act((tx) => tx.set(s.ui.theme, 'dark'));
		expect(store.revision(s.ui.count)).toBe(before);
	});

	it('moves on an ancestor when a descendant is written', () => {
		const { store, s } = makeStore();
		const users = store.ref('users');
		const before = store.revision(users);
		store.act((tx) => tx.set(s.users.at(uid(1)).name, 'Ada'));
		expect(store.revision(users)).not.toBe(before);
	});

	it('moves on an ancestor when a MATERIALIZED descendant is written', () => {
		// Mutation testing found this uncovered. An unmaterialized write stamps the
		// nearest materialized ancestor directly, so the ancestor's number moves
		// even with propagation broken. Only a materialized leaf write exercises the
		// walk up the parent chain.
		const { store, s } = makeStore();
		const off = store.observe(s.users.at(uid(1)).name, () => {});
		const users = store.revision(store.ref('users'));
		const key = store.revision(store.ref('users/u1'));
		store.act((tx) => tx.set(s.users.at(uid(1)).name, 'Ada'));
		expect(store.revision(store.ref('users'))).not.toBe(users);
		expect(store.revision(store.ref('users/u1'))).not.toBe(key);
		off();
	});

	it('moves at the root for a materialized write anywhere', () => {
		const { store, s } = makeStore();
		const off = store.observe(s.users.at(uid(1)).age, () => {});
		const before = store.revision(store.ref('users'));
		store.act((tx) => tx.set(s.users.at(uid(1)).age, 5));
		expect(store.revision(store.ref('users'))).not.toBe(before);
		off();
	});

	it('gives one integer that covers a whole subtree', () => {
		const { store, s } = makeStore();
		const users = store.ref('users');
		const seen = store.revision(users);
		// A consumer holding `seen` needs no knowledge of what is inside.
		store.act((tx) => {
			tx.set(s.users.at(uid(1)).name, 'a');
			tx.set(s.users.at(uid(9)).age, 9);
		});
		expect(store.revision(users)).not.toBe(seen);
		const settled = store.revision(users);
		store.act((tx) => tx.set(s.ui.theme, 'dark'));
		expect(store.revision(users)).toBe(settled);
	});

	it('moves after a bulk replacement', () => {
		const { store, s } = makeStore();
		const users = store.ref('users');
		const before = store.revision(users);
		s.users.replaceAll({});
		expect(store.revision(users)).not.toBe(before);
	});

	it('is conservative, never optimistic, for an unobserved address', () => {
		// Nothing is materialized under `users`, so both addresses report the
		// segment's stamp. A spurious change is acceptable; a missed one is not.
		const { store, s } = makeStore();
		const a = s.users.at(uid(1)).name;
		const before = store.revision(a);
		store.act((tx) => tx.set(s.users.at(uid(2)).name, 'sibling'));
		expect(store.revision(a)).not.toBe(before);

		// Once observed, the leaf gets its own node and stops reporting sibling churn.
		const off = store.observe(a, () => {});
		const observed = store.revision(a);
		store.act((tx) => tx.set(s.users.at(uid(3)).name, 'other'));
		expect(store.revision(a)).toBe(observed);
		off();
	});

	it('rejects a path the schema does not describe', () => {
		const { store } = makeStore();
		expect(() => store.revision({ path: 'users/u1/nmae' })).toThrow(/no such path/);
	});
});

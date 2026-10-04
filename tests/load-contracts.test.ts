import { describe, expect, it, vi } from 'vitest';
import { createStore, derived } from '../src/core/index.js';

describe('fixed-cell create', () => {
	it('does not materialize a trie node per plain cell', () => {
		const cells: Record<string, number> = {};
		for (let i = 0; i < 1000; i++) cells['c' + i] = i;
		const store = createStore(cells);
		expect(store.stats().nodes).toBe(1);
		expect(store.get(store.state.c0)).toBe(0);
		expect(store.get(store.state.c999)).toBe(999);
		store.set(store.state.c1, 7);
		expect(store.get(store.state.c1)).toBe(7);
		const before = store.revision(store.state.c0);
		store.set(store.state.c2, 3);
		expect(store.revision(store.state.c0)).toBe(before);
		expect(store.revision(store.state.c2)).not.toBe(before);
	});

	it('materializes a fixed cell only while it is observed', () => {
		const store = createStore({ n: 1 });
		const baseline = store.stats().nodes;
		const off = store.observe(store.state.n, () => {});
		expect(store.stats().nodes).toBe(baseline + 1);
		store.set(store.state.n, 4);
		expect(store.get(store.state.n)).toBe(4);
		off();
		expect(store.stats().nodes).toBe(baseline);
		expect(store.get(store.state.n)).toBe(4);
	});
});

describe('derived propagation contracts', () => {
	it('notifies a diamond once with the final value', () => {
		const store = createStore({
			n: 0,
			b: derived<number>(),
			c: derived<number>(),
			d: derived<number>(),
		}).with((s) => ({
			b: (get) => get(s.n) + 1,
			c: (get) => get(s.n) + 1,
			d: (get) => get(s.b) + get(s.c),
		}));
		const seen: number[] = [];
		store.observe(store.state.d, () => {
			seen.push(store.get(store.state.d));
		});
		store.set(store.state.n, 3);
		expect(seen).toEqual([8]);
	});

	it('propagates a chain to the leaf and does not re-run unrelated deriveds', () => {
		const store = createStore({ root: 0, other: 1 });
		let prev = store.state.root;
		let leaf = prev;
		for (let depth = 0; depth < 5; depth++) {
			const src = prev;
			leaf = store.derive((get) => get(src) + 1);
			prev = leaf;
		}
		const seen: number[] = [];
		store.observe(leaf, () => {
			seen.push(store.get(leaf));
		});
		let runs = 0;
		const other = store.derive((get) => {
			runs++;
			return get(store.state.other);
		});
		store.observe(other, () => {});
		const seeded = runs;
		store.set(store.state.root, 4);
		expect(seen).toEqual([9]);
		expect(runs).toBe(seeded);
	});

	it('rolls a thrown act back without notifying', () => {
		const store = createStore({ n: 1, m: 2 });
		const observer = vi.fn();
		store.observe(store.state.n, observer);
		expect(() =>
			store.act((tx) => {
				tx.set(store.state.n, 9);
				tx.set(store.state.m, 8);
				throw new Error('boom');
			}),
		).toThrow('boom');
		expect(store.get(store.state.n)).toBe(1);
		expect(store.get(store.state.m)).toBe(2);
		expect(observer).not.toHaveBeenCalled();
	});
});

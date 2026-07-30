// The S0 regressions. These are the measurements that decided the design, so
// they are pinned as behaviour: node count is the deterministic signal (heap
// numbers are too noisy inside a test runner, but node count is exact).
import { describe, expect, it, vi } from 'vitest';
import { makeStore, uid, type UserId } from './fixture.js';

function bulk(rows: number): Record<UserId, { name: string; age: number }> {
	const out = Object.create(null) as Record<UserId, { name: string; age: number }>;
	for (let i = 0; i < rows; i++) out[uid(i)] = { name: `name-${i}`, age: 20 + (i % 50) };
	return out;
}

describe('segments: memory is O(observed), not O(data)', () => {
	it('adds no nodes when a hundred thousand records are loaded', () => {
		const { store, s } = makeStore();
		const baseline = store.stats().nodes;
		s.users.replaceAll(bulk(100_000));
		expect(store.stats().nodes).toBe(baseline);
		// The data is readable without any node existing for it.
		expect(store.get(s.users.at(uid(99_999)).name)).toBe('name-99999');
	});

	it('materializes exactly the spine of what is observed', () => {
		const { store, s } = makeStore();
		s.users.replaceAll(bulk(50_000));
		const baseline = store.stats().nodes;
		const offs = [];
		for (let i = 0; i < 200; i++) offs.push(store.observe(s.users.at(uid(i)).name, () => {}));
		// 200 key nodes plus 200 leaves.
		expect(store.stats().nodes).toBe(baseline + 400);
		for (const off of offs) off();
		expect(store.stats().nodes).toBe(baseline);
	});

	it('keeps node count flat under observer churn', () => {
		const { store, s } = makeStore();
		s.users.replaceAll(bulk(50_000));
		const baseline = store.stats().nodes;

		let live = [];
		for (let i = 0; i < 200; i++) live.push(store.observe(s.users.at(uid(i)).name, () => {}));
		const withWindow = store.stats().nodes;

		// A scrolling list: each round detaches the window and attaches a disjoint one.
		for (let round = 1; round <= 100; round++) {
			for (const off of live) off();
			live = [];
			const start = round * 200;
			for (let i = 0; i < 200; i++) {
				live.push(store.observe(s.users.at(uid(start + i)).name, () => {}));
			}
		}
		// 20,200 distinct leaves have been observed; only 200 are live.
		expect(store.stats().nodes).toBe(withWindow);
		for (const off of live) off();
		expect(store.stats().nodes).toBe(baseline);
	});

	it('never materializes on a write alone', () => {
		const { store, s } = makeStore();
		const baseline = store.stats().nodes;
		store.act((tx) => {
			for (let i = 0; i < 500; i++) tx.set(s.users.at(uid(i)).age, i);
		});
		expect(store.stats().nodes).toBe(baseline);
		expect(store.get(s.users.at(uid(499)).age)).toBe(499);
	});

	it('does not resurrect a pruned node when its path is written again', () => {
		const { store, s } = makeStore();
		const baseline = store.stats().nodes;
		const off = store.observe(s.users.at(uid(1)).name, () => {});
		off();
		expect(store.stats().nodes).toBe(baseline);
		store.act((tx) => tx.set(s.users.at(uid(1)).name, 'Ada'));
		expect(store.stats().nodes).toBe(baseline);
		expect(store.get(s.users.at(uid(1)).name)).toBe('Ada');
	});
});

describe('segments: notification reach', () => {
	it('wakes a segment observer for a write to an unobserved key', () => {
		const { store, s } = makeStore();
		const observer = vi.fn();
		store.observe(store.ref('users'), observer);
		store.act((tx) => tx.set(s.users.at(uid(4242)).name, 'Grace'));
		expect(observer).toHaveBeenCalledTimes(1);
	});

	it('does not wake a leaf observer for a sibling key', () => {
		const { store, s } = makeStore();
		const one = vi.fn();
		const two = vi.fn();
		store.observe(s.users.at(uid(1)).name, one);
		store.observe(s.users.at(uid(2)).name, two);
		store.act((tx) => tx.set(s.users.at(uid(1)).name, 'Ada'));
		expect(one).toHaveBeenCalledTimes(1);
		expect(two).not.toHaveBeenCalled();
	});

	it('does not wake a leaf observer for a sibling field of the same key', () => {
		const { store, s } = makeStore();
		const name = vi.fn();
		store.observe(s.users.at(uid(1)).name, name);
		store.act((tx) => tx.set(s.users.at(uid(1)).age, 33));
		expect(name).not.toHaveBeenCalled();
	});

	it('wakes an ancestor deep observer for a write to an already MATERIALIZED leaf', () => {
		// The leaf is materialized by its own observer, so the write resolves to an
		// exact node and the ancestor walk is the ONLY thing that can reach the
		// deep observer. Mutation testing found this uncovered: the earlier
		// multi-write test masked it, because its other writes reached the same
		// observer through the unmaterialized path instead.
		const { store, s } = makeStore();
		const deep = vi.fn();
		const leaf = vi.fn();
		store.observe(store.ref('users'), deep);
		store.observe(s.users.at(uid(1)).name, leaf);
		store.act((tx) => tx.set(s.users.at(uid(1)).name, 'Ada'));
		expect(leaf).toHaveBeenCalledTimes(1);
		expect(deep).toHaveBeenCalledTimes(1);
	});

	it('wakes a deep observer one level up from a materialized leaf', () => {
		const { store, s } = makeStore();
		const deep = vi.fn();
		store.observe(store.ref('users/u1'), deep, { deep: true });
		store.observe(s.users.at(uid(1)).age, () => {});
		store.act((tx) => tx.set(s.users.at(uid(1)).age, 7));
		expect(deep).toHaveBeenCalledTimes(1);
	});

	it('wakes a deep observer on a key for any of its fields', () => {
		const { store, s } = makeStore();
		const observer = vi.fn();
		store.observe(store.ref('users/u1'), observer, { deep: true });
		store.act((tx) => tx.set(s.users.at(uid(1)).age, 33));
		expect(observer).toHaveBeenCalledTimes(1);
		store.act((tx) => tx.set(s.users.at(uid(2)).age, 44));
		expect(observer).toHaveBeenCalledTimes(1);
	});
});

describe('segments: bulk replacement', () => {
	it('wakes observers of materialized descendants', () => {
		const { store, s } = makeStore();
		s.users.replaceAll(bulk(10));
		const observer = vi.fn();
		store.observe(s.users.at(uid(1)).name, observer);
		expect(store.get(s.users.at(uid(1)).name)).toBe('name-1');

		const next = Object.create(null) as Record<UserId, { name: string; age: number }>;
		next[uid(1)] = { name: 'replaced', age: 1 };
		s.users.replaceAll(next);

		expect(observer).toHaveBeenCalledTimes(1);
		expect(store.get(s.users.at(uid(1)).name)).toBe('replaced');
		// A key absent from the new bulk falls back to the declared initial value.
		expect(store.get(s.users.at(uid(2)).name)).toBe('anonymous');
	});

	it('does not change node count', () => {
		const { store, s } = makeStore();
		const off = store.observe(s.users.at(uid(1)).name, () => {});
		const before = store.stats().nodes;
		s.users.replaceAll(bulk(20_000));
		expect(store.stats().nodes).toBe(before);
		off();
	});

	it('reports a replacement in the commit stream', () => {
		const { store, s } = makeStore();
		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));
		s.users.replaceAll(bulk(2));
		expect(sources).toEqual(['replaceAll']);
	});

	it('exposes the bulk value through snapshot', () => {
		const { s } = makeStore();
		s.users.replaceAll(bulk(3));
		expect(Object.keys(s.users.snapshot())).toEqual(['u0', 'u1', 'u2']);
	});
});

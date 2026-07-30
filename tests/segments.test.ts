// The S0 regressions. These are the measurements that decided the design, so
// they are pinned as behaviour: node count is the deterministic signal (heap
// numbers are too noisy inside a test runner, but node count is exact).
import { describe, expect, it, vi } from 'vitest';
import { createStore, segment } from '../src/core/index.js';
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

// A segment nested inside another bulk holder owns no value of its own:
// everything below the OUTERMOST holder lives in that holder's one opaque
// value. These pin the consequences a consumer can see, in the order a real
// component tree produces them: an observer can materialize the trie chain
// before the nested view is first used, and the chain can be pruned while the
// view is still held.
describe('segments: nested inside another bulk holder', () => {
	const make = () => createStore({ rows: segment({ tags: segment<string>()('') }) });

	it('writes through to the outer bulk value even when the trie chain is materialized', () => {
		const store = make();
		const tags = store.state.rows.at('r1').tags;
		// Materialize rows/r1/tags/t1 BEFORE the view's first at(), so a stale
		// holder memo would be tempted by the transient nodes.
		const off = store.observe(store.ref('rows/r1/tags/t1'), () => {});
		store.set(tags.at('t2'), 'x');
		// The same address through every other route must see the write.
		expect(store.get(store.ref('rows/r1/tags/t2'))).toBe('x');
		expect(store.get(tags.at('t2'))).toBe('x');
		off();
		// And after the chain is pruned, the value still lives in the outer bulk.
		expect(store.get(store.ref('rows/r1/tags/t2'))).toBe('x');
	});

	it('keeps delivering keyed subscriptions across a full prune cycle of the chain', () => {
		const store = make();
		const tags = store.state.rows.at('r1').tags;
		const off1 = store.observe(store.ref('rows/r1/tags/t1'), () => {});
		const off2 = tags.observe('t2', () => {});
		off1();
		off2();
		// The chain is fully pruned; the held view must still attach observers
		// the wake paths can reach from the root.
		const woken = vi.fn();
		tags.observe('t3', woken);
		store.set(store.ref('rows/r1/tags/t3'), 'v');
		expect(woken).toHaveBeenCalledTimes(1);
	});

	it('refuses replaceAll even when the chain happens to be materialized', () => {
		const store = make();
		const tags = store.state.rows.at('r1').tags;
		const off = store.observe(store.ref('rows/r1/tags/t1'), () => {});
		expect(() => tags.replaceAll({ t9: 'x' })).toThrow(/nested inside another bulk holder/);
		off();
	});
});

// A cell-shaped top-level segment is the flat-list case: an observed key needs
// only an observer list and a stamp, and the store keeps both in a per-key
// record on the holder. Behavior must be indistinguishable from the trie path.
describe('segments: cell-shaped holders', () => {
	const make = () => {
		const store = createStore({ rows: segment<string>()('') });
		store.state.rows.replaceAll({ a: '1', b: '2', c: '3' });
		return store;
	};

	it('counts one materialized point per observed key and releases it on detach', () => {
		const store = make();
		const baseline = store.stats().nodes;
		const offs = [
			store.state.rows.observe('a', () => {}),
			store.observe(store.state.rows.at('b'), () => {}),
		];
		expect(store.stats().nodes).toBe(baseline + 2);
		for (const off of offs) off();
		expect(store.stats().nodes).toBe(baseline);
	});

	it('keeps revision exact for an observed key: a sibling write does not move it', () => {
		const store = make();
		const rows = store.state.rows;
		const off = rows.observe('a', () => {});
		const before = store.revision(rows.at('a'));
		store.set(rows.at('b'), 'x');
		expect(store.revision(rows.at('a'))).toBe(before);
		store.set(rows.at('a'), 'y');
		expect(store.revision(rows.at('a'))).not.toBe(before);
		off();
	});

	it('wakes each observer of a multi-write transaction exactly once', () => {
		const store = make();
		const rows = store.state.rows;
		const a = vi.fn();
		const b = vi.fn();
		const c = vi.fn();
		rows.observe('a', a);
		rows.observe('b', b);
		rows.observe('c', c);
		store.act((tx) => {
			tx.set(rows.at('a'), 'x');
			tx.set(rows.at('b'), 'y');
		});
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
		expect(c).not.toHaveBeenCalled();
	});

	it('wakes observers and moves their revision on replaceAll', () => {
		const store = make();
		const rows = store.state.rows;
		const woken = vi.fn();
		rows.observe('a', woken);
		const before = store.revision(rows.at('a'));
		rows.replaceAll({ a: 'new', b: '2' });
		expect(woken).toHaveBeenCalledTimes(1);
		expect(store.revision(rows.at('a'))).not.toBe(before);
	});

	it('shares one subscription point between the keyed and the ref form', () => {
		const store = make();
		const rows = store.state.rows;
		const baseline = store.stats().nodes;
		const keyed = vi.fn();
		const viaRef = vi.fn();
		const offKeyed = rows.observe('a', keyed);
		const offRef = store.observe(rows.at('a'), viaRef);
		store.set(rows.at('a'), 'x');
		expect(keyed).toHaveBeenCalledTimes(1);
		expect(viaRef).toHaveBeenCalledTimes(1);
		offKeyed();
		offKeyed();
		store.set(rows.at('a'), 'z');
		expect(keyed).toHaveBeenCalledTimes(1);
		expect(viaRef).toHaveBeenCalledTimes(2);
		rows.replaceAll({ a: 'replaced' });
		expect(viaRef).toHaveBeenCalledTimes(3);
		offRef();
		expect(store.stats().nodes).toBe(baseline);
	});

	it('honors a same-pass dispose between observers of one key', () => {
		const store = make();
		const rows = store.state.rows;
		const baseline = store.stats().nodes;
		const second = vi.fn();
		let offSecond = () => {};
		const offFirst = rows.observe('a', () => offSecond());
		offSecond = store.observe(rows.at('a'), second);
		store.set(rows.at('a'), 'x');
		expect(second).not.toHaveBeenCalled();
		offFirst();
		expect(store.stats().nodes).toBe(baseline);
	});
});

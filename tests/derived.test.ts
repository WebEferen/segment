import { describe, expect, it, vi } from 'vitest';
import { createStore, derived } from '../src/core/index.js';
import { makeStore, uid } from './fixture.js';

describe('derivations', () => {
	it('does not evaluate until read', () => {
		const { counters } = makeStore();
		expect(counters.double).toBe(0);
		expect(counters.sum).toBe(0);
	});

	it('computes over its dependencies', () => {
		const { store, s } = makeStore();
		store.act((tx) => tx.set(s.ui.count, 5));
		expect(store.get(s.calc.double)).toBe(10);
		expect(store.get(s.calc.plusOne)).toBe(6);
		expect(store.get(s.calc.sum)).toBe(16);
	});

	it('sees ONE consistent value of a shared dependency across a diamond', () => {
		const { store, s } = makeStore();
		for (const n of [1, 2, 3, 17, 100]) {
			store.act((tx) => tx.set(s.ui.count, n));
			// sum reads double and plusOne, both of which read count. A glitch would
			// show up as a mix of two different counts.
			expect(store.get(s.calc.sum)).toBe(n * 2 + (n + 1));
		}
	});

	it('caches while observed, and recomputes nothing on a repeated read', () => {
		const { store, counters, s } = makeStore();
		store.observe(s.calc.sum, () => {});
		const afterSeed = { ...counters };
		store.get(s.calc.sum);
		store.get(s.calc.sum);
		store.get(s.calc.sum);
		expect(counters).toEqual(afterSeed);
	});

	it('caches a schema-bounded derivation even with no observer', () => {
		// Nodes above every bulk holder are bounded by the schema, so they are
		// pinned at construction and there is always somewhere to cache.
		const { store, counters, s } = makeStore();
		store.get(s.calc.double);
		expect(counters.double).toBe(1);
		store.get(s.calc.double);
		store.get(s.calc.double);
		expect(counters.double).toBe(1);
	});

	it('recomputes an UNOBSERVED derivation under a segment, which is the documented cost', () => {
		// Under a segment there is no node until something observes the path, and
		// materializing one per read is exactly the O(data) growth this design
		// refuses. Recomputing is the deliberate trade.
		const { store, counters, s } = makeStore();
		const label = s.users.at('u1' as never).label;
		store.get(label);
		expect(counters.label).toBe(1);
		store.get(label);
		expect(counters.label).toBe(2);

		// Observing it buys the cache back.
		const off = store.observe(label, () => {});
		const seeded = counters.label;
		store.get(label);
		store.get(label);
		expect(counters.label).toBe(seeded);
		off();
	});

	it('wakes an observer when a dependency moves the value', () => {
		const { store, s } = makeStore();
		const observer = vi.fn();
		store.observe(s.calc.sum, observer);
		store.act((tx) => tx.set(s.ui.count, 9));
		expect(observer).toHaveBeenCalledTimes(1);
		expect(store.get(s.calc.sum)).toBe(9 * 2 + 10);
	});

	it('does NOT wake an observer for a write its value does not depend on', () => {
		const { store, s } = makeStore();
		const observer = vi.fn();
		store.observe(s.calc.sum, observer);
		store.act((tx) => tx.set(s.ui.theme, 'dark'));
		expect(observer).not.toHaveBeenCalled();
	});

	it('derives per segment key from the enclosing store', () => {
		const { store, s } = makeStore();
		expect(store.get(s.users.at('u1' as never).label)).toBe('light:user');
		store.act((tx) => tx.set(s.ui.theme, 'dark'));
		expect(store.get(s.users.at('u1' as never).label)).toBe('dark:user');
	});

	it('rejects a derivation that depends on itself', () => {
		const store = createStore({ loop: derived<number>() }).with((s) => ({
			loop: (get) => get(s.loop) + 1,
		}));
		expect(() => store.get(store.state.loop)).toThrow(/depends on itself/);
	});

	it('rejects a mutually recursive pair', () => {
		const store = createStore({ a: derived<number>(), b: derived<number>() }).with((s) => ({
			a: (get) => get(s.b) + 1,
			b: (get) => get(s.a) + 1,
		}));
		expect(() => store.get(store.state.a)).toThrow(/depends on itself/);
	});

	it('refuses a write to a derived path', () => {
		const { store, s } = makeStore();
		expect(() => store.act((tx) => tx.set(s.calc.sum, 1))).toThrow(/cannot be written/);
	});

	it('leaves the store untouched when a derivation throws', () => {
		const store = createStore({ n: 1, bad: derived<number>() }).with(() => ({
			bad: () => {
				throw new Error('derive failed');
			},
		}));
		expect(() => store.get(store.state.bad)).toThrow('derive failed');
		// The failed evaluation must not have poisoned the cycle guard.
		expect(() => store.get(store.state.bad)).toThrow('derive failed');
		expect(store.get(store.state.n)).toBe(1);
	});
});

// Writes go THROUGH to the bulk value, so a derivation that reads a whole
// container sees the same object identity across every write under it. Its
// changes are real regardless, and both the recompute and the wake must happen.
describe('derivations over containers', () => {
	it('recomputes and wakes when a container dep is mutated in place', () => {
		const { store, s } = makeStore();
		const count = store.derive(
			(get) => Object.keys(get(store.ref('users')) as Record<string, unknown>).length,
		);
		expect(store.get(count)).toBe(0);
		const woken = vi.fn();
		const off = store.observe(count, woken);
		store.set(s.users.at(uid(1)).name, 'Ada');
		expect(woken).toHaveBeenCalledTimes(1);
		expect(store.get(count)).toBe(1);
		off();
		store.release(count);
	});

	it('does not trust container identity even with no observer attached', () => {
		const { store, s } = makeStore();
		const count = store.derive(
			(get) => Object.keys(get(store.ref('users')) as Record<string, unknown>).length,
		);
		expect(store.get(count)).toBe(0);
		store.set(s.users.at(uid(2)).name, 'Grace');
		expect(store.get(count)).toBe(1);
		store.release(count);
	});
});

describe('a derivation whose seeding evaluation throws', () => {
	it('leaves the store unpoisoned: later commits apply and notify normally', () => {
		const store = createStore({ n: 0, boom: derived<number>() }).with(() => ({
			boom: () => {
				throw new Error('boom');
			},
		}));
		const s = store.state;
		expect(() => store.observe(s.boom, () => {})).toThrow('boom');
		const woken = vi.fn();
		store.observe(s.n, woken);
		expect(() => store.set(s.n, 1)).not.toThrow();
		expect(woken).toHaveBeenCalledTimes(1);
		expect(store.get(s.n)).toBe(1);
	});
});

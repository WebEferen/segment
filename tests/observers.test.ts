import { describe, expect, it, vi } from 'vitest';
import { makeStore, uid } from './fixture.js';

describe('observers', () => {
	it('stops notifying after dispose', () => {
		const { store, s } = makeStore();
		const observer = vi.fn();
		const off = store.observe(s.ui.count, observer);
		store.act((tx) => tx.set(s.ui.count, 1));
		off();
		store.act((tx) => tx.set(s.ui.count, 2));
		expect(observer).toHaveBeenCalledTimes(1);
	});

	it('tolerates a repeated dispose', () => {
		const { store, s } = makeStore();
		const off = store.observe(s.ui.count, () => {});
		off();
		expect(() => off()).not.toThrow();
	});

	it('does not call an observer disposed earlier in the same notification pass', () => {
		const { store, s } = makeStore();
		const second = vi.fn();
		let offSecond = () => {};
		store.observe(s.ui.count, () => offSecond());
		offSecond = store.observe(s.ui.count, second);
		store.act((tx) => tx.set(s.ui.count, 1));
		expect(second).not.toHaveBeenCalled();
	});

	it('keeps sibling observers on one path independent', () => {
		const { store, s } = makeStore();
		const a = vi.fn();
		const b = vi.fn();
		const offA = store.observe(s.ui.count, a);
		store.observe(s.ui.count, b);
		offA();
		store.act((tx) => tx.set(s.ui.count, 1));
		expect(a).not.toHaveBeenCalled();
		expect(b).toHaveBeenCalledTimes(1);
	});

	it('leaves a shared spine alive while any observer remains', () => {
		const { store, s } = makeStore();
		const baseline = store.stats().nodes;
		const offName = store.observe(s.users.at(uid(1)).name, () => {});
		const offAge = store.observe(s.users.at(uid(1)).age, () => {});
		expect(store.stats().nodes).toBe(baseline + 3);
		offName();
		// The key node survives because `age` still needs it.
		expect(store.stats().nodes).toBe(baseline + 2);
		offAge();
		expect(store.stats().nodes).toBe(baseline);
	});

	it('does not wake an unrelated branch', () => {
		const { store, s } = makeStore();
		const theme = vi.fn();
		store.observe(s.ui.theme, theme);
		store.act((tx) => tx.set(s.ui.count, 1));
		expect(theme).not.toHaveBeenCalled();
	});

	it('refuses to observe an action', () => {
		const { store } = makeStore();
		expect(() => store.observe(store.ref('cart/bump'), () => {})).toThrow(/cannot be observed/);
	});

	it('reports observed derivations in stats', () => {
		const { store, s } = makeStore();
		expect(store.stats().observedDerived).toBe(0);
		const off = store.observe(s.calc.sum, () => {});
		expect(store.stats().observedDerived).toBe(1);
		off();
		expect(store.stats().observedDerived).toBe(0);
	});
});

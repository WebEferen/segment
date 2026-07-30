import { describe, expect, it, vi } from 'vitest';
import { createStore, segment } from '../src/core/index.js';
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

// The keyed form `view.observe(key, cb)` promises exactly the behavior of
// `store.observe(view.at(key), cb)`; these pin the shared contract, not the
// shortcut it takes.
describe('keyed observe on a bulk view', () => {
	it('wakes for a write to its key and stays quiet for siblings', () => {
		const store = createStore({ rows: segment<string>()('') });
		store.state.rows.replaceAll({ a: '1', b: '2' });
		const woken = vi.fn();
		const off = store.state.rows.observe('a', woken);
		store.set(store.state.rows.at('b'), 'x');
		expect(woken).not.toHaveBeenCalled();
		store.set(store.state.rows.at('a'), 'y');
		expect(woken).toHaveBeenCalledTimes(1);
		off();
		store.set(store.state.rows.at('a'), 'z');
		expect(woken).toHaveBeenCalledTimes(1);
	});

	it('shares its node with a ref observer and releases it with the last one', () => {
		const { store, s } = makeStore();
		const baseline = store.stats().nodes;
		const offKeyed = s.users.observe(uid(1), () => {});
		const offRef = store.observe(s.users.at(uid(1)).name, () => {});
		expect(store.stats().nodes).toBe(baseline + 2);
		offRef();
		expect(store.stats().nodes).toBe(baseline + 1);
		offKeyed();
		expect(store.stats().nodes).toBe(baseline);
	});

	it('observes a record key deeply, like observing its ref does', () => {
		const { store, s } = makeStore();
		const woken = vi.fn();
		s.users.observe(uid(2), woken);
		store.set(s.users.at(uid(2)).name, 'ada');
		expect(woken).toHaveBeenCalledTimes(1);
	});

	it('reaches a key of a segment nested inside another segment', () => {
		const store = createStore({ outer: segment({ inner: segment<string>()('') }) });
		const view = store.state.outer.at('x').inner;
		const woken = vi.fn();
		const off = view.observe('k', woken);
		store.set(view.at('k'), 'v');
		expect(woken).toHaveBeenCalledTimes(1);
		off();
		store.set(view.at('k'), 'w');
		expect(woken).toHaveBeenCalledTimes(1);
	});
});

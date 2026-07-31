// Every wrong thing here must be LOUD. A silent `undefined` from a mistyped
// path is the footgun this file exists to keep closed.
import { describe, expect, it } from 'vitest';
import { dehydrate } from '../src/ssr/index.js';
import { action, cell, createStore, derived, segment } from '../src/core/index.js';
import { makeStore } from './fixture.js';

describe('misuse', () => {
	it('throws on a path the schema does not describe', () => {
		const { store } = makeStore();
		expect(() => store.ref('users/u1/nmae')).toThrow(/no such path/);
		expect(() => store.ref('nope')).toThrow(/no such path/);
		expect(() => store.ref('ui/count/deeper')).toThrow(/no such path/);
	});

	it('names the offending path in the error', () => {
		const { store } = makeStore();
		expect(() => store.ref('users/u1/nmae')).toThrow(/users\/u1\/nmae/);
	});

	it('refuses to write an action path', () => {
		const { store } = makeStore();
		const action = store.ref('cart/bump');
		expect(() => store.act((tx) => tx.set(action, 1))).toThrow(/is an action/);
	});

	it('refuses an ordinary write to a bulk holder and names the right operation', () => {
		// Found by self-review, not by a failing test: this write replaced the whole
		// bulk value but woke only the holder's own observers, leaving every
		// materialized descendant's observer stale. Two routes to one operation, one
		// of them quietly wrong.
		const { store } = makeStore();
		const holder = store.ref('users');
		expect(() => store.act((tx) => tx.set(holder, {}))).toThrow(/use replaceAll\(\)/);
	});

	it('keeps descendant observers correct when the bulk value is swapped', () => {
		const { store, s } = makeStore();
		const seen: string[] = [];
		store.observe(s.users.at('u1' as never).name, () => {
			seen.push(store.get(s.users.at('u1' as never).name));
		});
		const next = Object.create(null) as Record<string, { name: string }>;
		next.u1 = { name: 'swapped' };
		s.users.replaceAll(next as never);
		expect(seen).toEqual(['swapped']);
	});

	it('explains why a nested segment cannot be bulk-replaced', () => {
		const store = createStore({
			outer: segment<string>()({ inner: segment<string>()({ v: 0 }) }),
		});
		expect(() => store.state.outer.at('a').inner.replaceAll({})).toThrow(
			/nested inside another bulk holder/,
		);
	});

	it('rejects a value that is not a ref', () => {
		const { store } = makeStore();
		expect(() => store.get({} as never)).toThrow(/expected a ref/);
		expect(() => store.get(null as never)).toThrow(/expected a ref/);
	});

	it('names every slot .with() left unimplemented, in one error', () => {
		const store = createStore({
			deep: { nested: { total: derived<number>() } },
			go: action<[n: number]>(),
		});
		// Types already forbid this; a JavaScript consumer bypasses them.
		expect(() => store.with(() => ({}) as never)).toThrow(/deep\/nested\/total/);
		expect(() => store.with(() => ({}) as never)).toThrow(/\bgo\b/);
	});

	it('reports a derived read before .with() supplied it', () => {
		const store = createStore({ total: derived<number>() });
		expect(() => store.get(store.state.total)).toThrow(/supply it in \.with\(\)/);
	});

	it('reports an action called before .with() supplied it', () => {
		const store = createStore({ go: action<[n: number]>() });
		expect(() => store.state.go(1)).toThrow(/supply it in \.with\(\)/);
	});

	it('does not mistake a branch containing a "kind" field for a marker', () => {
		// A naive `'kind' in value` check would read this branch as a marker and
		// silently drop the whole subtree.
		const store = createStore({ group: { kind: 'sedan', wheels: 4 } });
		expect(store.get(store.state.group.kind)).toBe('sedan');
		expect(store.get(store.state.group.wheels)).toBe(4);
	});

	it('treats a raw value as a cell with that initial value', () => {
		const store = createStore({ n: 42, flag: true, when: new Date(0), tags: ['a'] });
		expect(store.get(store.state.n)).toBe(42);
		expect(store.get(store.state.flag)).toBe(true);
		expect(store.get(store.state.when)).toEqual(new Date(0));
		// An array is a value, not an addressable list; `list()` is for that.
		expect(store.get(store.state.tags)).toEqual(['a']);
	});

	it('keeps a plain object as one value when cell() says so', () => {
		const store = createStore({ point: cell({ x: 1, y: 2 }) });
		expect(store.get(store.state.point)).toEqual({ x: 1, y: 2 });
	});
});

describe('misuse: a function where a declaration belongs', () => {
	it('rejects a bare function and names the two markers it probably meant', () => {
		expect(() => createStore({ go: () => {} })).toThrow(/Did you mean action\(\)/);
		expect(() => createStore({ nested: { go: () => {} } })).toThrow(/nested\/go/);
	});

	it('still allows a function stored deliberately, through cell()', () => {
		const compare = (a: number, b: number) => a - b;
		const store = createStore({ compare: cell(compare) });
		expect(store.get(store.state.compare)).toBe(compare);
	});

	it('leaves a deliberately stored function out of nothing, so SSR loses it', () => {
		// Documented consequence, asserted so nobody is surprised later: the payload
		// carries the function reference, which JSON cannot represent.
		const store = createStore({ compare: cell((a: number) => a) });
		expect(typeof dehydrate(store).data['compare']).toBe('function');
		expect(JSON.parse(JSON.stringify(dehydrate(store))).data.compare).toBeUndefined();
	});
});

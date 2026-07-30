import { describe, expect, it } from 'vitest';
import { act, flushEffects, mount } from './_helpers.js';
import { makeAppStore } from './_fixtures/store.js';
import { Reads } from './_fixtures/reads.tsrx';
import { Rows } from './_fixtures/list.tsrx';
import { ResourceThroughUseValue } from './_fixtures/misuse.tsrx';

describe('useValue', () => {
	it('reads a cell and updates when it is written', () => {
		const app = makeAppStore();
		const renders = { cell: 0, branch: 0, derived: 0 };
		const view = mount(Reads, { app, renders });

		expect(view.find('#cell').textContent).toBe('light');
		act(() => app.store.act((tx) => tx.set(app.s.ui.theme, 'dark')));
		expect(view.find('#cell').textContent).toBe('dark');
		view.unmount();
	});

	it('reads a derivation and updates when its input moves', () => {
		const app = makeAppStore();
		const renders = { cell: 0, branch: 0, derived: 0 };
		const view = mount(Reads, { app, renders });

		expect(view.find('#derived').textContent).toBe('0');
		act(() => app.s.bump(4));
		expect(view.find('#derived').textContent).toBe('8');
		view.unmount();
	});

	it('reads a whole branch, whose object identity never changes', () => {
		const app = makeAppStore();
		const renders = { cell: 0, branch: 0, derived: 0 };
		const view = mount(Reads, { app, renders });

		// A key nothing has written has no record. Leaf reads carry the declared
		// default; a branch read reports the record as stored.
		expect(view.find('#branch').textContent).toBe('absent');
		expect(app.store.get(app.s.users.at('u1').name)).toBe('anonymous');

		act(() => app.store.act((tx) => tx.set(app.s.users.at('u1').name, 'Ada')));
		expect(view.find('#branch').textContent).toBe('Ada/undefined');
		// The second write mutates the SAME record object, so nothing but the
		// revision stamp can tell the adapter that this changed.
		act(() => app.store.act((tx) => tx.set(app.s.users.at('u1').age, 36)));
		expect(view.find('#branch').textContent).toBe('Ada/36');
		view.unmount();
	});

	it('leaves readers of untouched addresses alone', () => {
		const app = makeAppStore();
		const renders = { cell: 0, branch: 0, derived: 0 };
		const view = mount(Reads, { app, renders });
		const before = { ...renders };

		act(() => app.store.act((tx) => tx.set(app.s.ui.theme, 'dark')));
		// Only the cell reader was concerned.
		expect(renders.cell).toBe(before.cell + 1);
		expect(renders.branch).toBe(before.branch);
		expect(renders.derived).toBe(before.derived);
		view.unmount();
	});

	it('detaches its observers on unmount', () => {
		const app = makeAppStore();
		const baseline = app.store.stats().nodes;
		const view = mount(Reads, { app, renders: { cell: 0, branch: 0, derived: 0 } });
		// Subscriptions are established in a passive effect, so drain before counting.
		flushEffects();
		expect(app.store.stats().nodes).toBeGreaterThan(baseline);
		view.unmount();
		// Unsubscribing is a passive destroy, which the runtime defers to the passive
		// flush, so drain again before claiming the nodes came back.
		flushEffects();
		// Materialization is reversible, so unmounting gives the nodes back.
		expect(app.store.stats().nodes).toBe(baseline);
	});

	it('waits on a fetched address instead of refusing it', async () => {
		// One hook reads everything: a fetched address makes the component WAIT rather
		// than throwing at the call site. Needing to know the address KIND before you
		// could read it was the confusing part of an earlier surface.
		const app = makeAppStore();
		const view = mount(ResourceThroughUseValue, { app });
		expect(view.find('#waiting')).toBeTruthy();
		expect(app.loadOrder).toEqual(['u1']);

		app.settle('u1', '/u1.png');
		for (let i = 0; i < 8; i++) await Promise.resolve();
		act(() => {});
		expect(view.find('#loaded').textContent).toBe('/u1.png');
		view.unmount();
		flushEffects();
	});
});

describe('block granularity', () => {
	it('wakes only the row whose key was written', () => {
		const app = makeAppStore();
		const ids = ['r1', 'r2', 'r3'];
		const renders: Record<string, number> = {};
		const view = mount(Rows, { app, ids, renders });
		expect(view.findAll('.row')).toHaveLength(3);
		const before = { ...renders };

		act(() => app.store.act((tx) => tx.set(app.s.users.at('r2').name, 'changed')));

		expect(renders.r2).toBe(before.r2 + 1);
		expect(renders.r1).toBe(before.r1);
		expect(renders.r3).toBe(before.r3);
		expect(view.find('.row[data-id="r2"]').textContent).toBe('changed');
		view.unmount();
	});

	it('keeps node count proportional to the rows on screen, not to the key space', () => {
		const app = makeAppStore();
		// A large dataset behind a small window.
		const bulk: Record<string, { name: string; age: number }> = Object.create(null);
		for (let i = 0; i < 5_000; i++) bulk[`r${i}`] = { name: `n${i}`, age: i };
		app.s.users.replaceAll(bulk as never);

		const baseline = app.store.stats().nodes;
		const view = mount(Rows, { app, ids: ['r1', 'r2', 'r3'], renders: {} });
		flushEffects();
		// Three rows: three key nodes plus three leaves.
		expect(app.store.stats().nodes).toBe(baseline + 6);
		view.unmount();
		flushEffects();
		expect(app.store.stats().nodes).toBe(baseline);
	});
});

import { describe, expect, it } from 'vitest';
import { act, flushEffects, mount } from './_helpers.js';
import { makeAppStore } from './_fixtures/store.js';
import { Selected } from './_fixtures/select.tsrx';

describe('useValue with a selector', () => {
	it('computes from several addresses at once', () => {
		const app = makeAppStore();
		const view = mount(Selected, { app, runs: { n: 0 } });
		expect(view.find('#selected').textContent).toBe('light#0');

		act(() => app.store.set(app.s.ui.theme, 'dark'));
		expect(view.find('#selected').textContent).toBe('dark#0');
		act(() => app.s.bump(3));
		expect(view.find('#selected').textContent).toBe('dark#3');
		view.unmount();
		flushEffects();
	});

	it('does not re-run for a write it never read', () => {
		const app = makeAppStore();
		const runs = { n: 0 };
		const view = mount(Selected, { app, runs });
		const before = runs.n;

		// `users` is not in the selector's read set.
		act(() => app.store.set(app.s.users.at('u9').name, 'Ada'));
		expect(runs.n).toBe(before);

		act(() => app.store.set(app.s.ui.theme, 'dark'));
		expect(runs.n).toBeGreaterThan(before);
		view.unmount();
		flushEffects();
	});

	it('releases its derivation on unmount, so a list leaves nothing behind', () => {
		const app = makeAppStore();
		const baseline = app.store.stats().nodes;
		const views = [];
		for (let i = 0; i < 20; i++) views.push(mount(Selected, { app, runs: { n: 0 } }));
		flushEffects();
		expect(app.store.stats().nodes).toBeGreaterThan(baseline);
		for (const view of views) view.unmount();
		flushEffects();
		expect(app.store.stats().nodes).toBe(baseline);
	});
});

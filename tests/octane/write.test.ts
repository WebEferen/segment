import { describe, expect, it } from 'vitest';
import { act, flushEffects, mount } from './_helpers.js';
import { makeAppStore } from './_fixtures/store.js';
import { ThemeToggle, WriteThroughDerived } from './_fixtures/write.tsrx';

describe('useValue: the write half', () => {
	it('reads and writes through one hook, in the shape useState taught', () => {
		const app = makeAppStore();
		const view = mount(ThemeToggle, { app });
		expect(view.find('#theme').textContent).toBe('light');

		act(() => view.click('#dark'));
		expect(view.find('#theme').textContent).toBe('dark');
		expect(app.store.get(app.s.ui.theme)).toBe('dark');
		view.unmount();
		flushEffects();
	});

	it('accepts an updater function', () => {
		const app = makeAppStore();
		const view = mount(ThemeToggle, { app });
		act(() => view.click('#flip'));
		expect(view.find('#theme').textContent).toBe('dark');
		act(() => view.click('#flip'));
		expect(view.find('#theme').textContent).toBe('light');
		view.unmount();
		flushEffects();
	});

	it('attributes each write to its address', () => {
		const app = makeAppStore();
		const sources: string[] = [];
		app.store.commits((commit) => sources.push(commit.source));
		const view = mount(ThemeToggle, { app });
		act(() => view.click('#dark'));
		expect(sources).toEqual(['ui/theme']);
		view.unmount();
		flushEffects();
	});

	it('is loud if a JavaScript caller reaches the setter of a derivation', () => {
		// TypeScript types that member as `never`, so this can only happen from
		// untyped code. It must still say what went wrong.
		const app = makeAppStore();
		expect(() => mount(WriteThroughDerived, { app })).toThrow(/cannot be written/);
	});
});

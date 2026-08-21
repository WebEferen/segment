import { describe, expect, it } from 'vitest';
import { useValue } from 'segment-state/react';
import { mount } from './_helpers.js';
import { makeAppStore, type AppStore } from './_fixtures/store.js';

function ThemeToggle({ app }: { app: AppStore }) {
	const [theme, setTheme] = useValue(app.s.ui.theme);
	return (
		<>
			<span id="theme">{theme}</span>
			<button id="dark" onClick={() => setTheme('dark')} />
			<button id="flip" onClick={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))} />
		</>
	);
}

function WriteThroughDerived({ app, log }: { app: AppStore; log: string[] }) {
	// TypeScript types the setter of a derivation as `never`; the cast simulates
	// the untyped JavaScript caller the runtime error exists for.
	const pair = useValue(app.s.totals.doubled) as unknown as [number, (next: number) => void];
	try {
		pair[1](1);
	} catch (error) {
		log.push((error as Error).message);
	}
	return null;
}

describe('useValue: the write half', () => {
	it('reads and writes through one hook, in the shape useState taught', () => {
		const app = makeAppStore();
		const view = mount(<ThemeToggle app={app} />);
		expect(view.find('#theme').textContent).toBe('light');

		view.click('#dark');
		expect(view.find('#theme').textContent).toBe('dark');
		expect(app.store.get(app.s.ui.theme)).toBe('dark');
		view.unmount();
	});

	it('accepts an updater function', () => {
		const app = makeAppStore();
		const view = mount(<ThemeToggle app={app} />);
		view.click('#flip');
		expect(view.find('#theme').textContent).toBe('dark');
		view.click('#flip');
		expect(view.find('#theme').textContent).toBe('light');
		view.unmount();
	});

	it('attributes each write to its address', () => {
		const app = makeAppStore();
		const sources: string[] = [];
		app.store.commits((commit) => sources.push(commit.source));
		const view = mount(<ThemeToggle app={app} />);
		view.click('#dark');
		expect(sources).toEqual(['ui/theme']);
		view.unmount();
	});

	it('is loud if a JavaScript caller reaches the setter of a derivation', () => {
		const app = makeAppStore();
		const log: string[] = [];
		const view = mount(<WriteThroughDerived app={app} log={log} />);
		expect(log).toHaveLength(1);
		expect(log[0]).toMatch(/cannot be written/);
		view.unmount();
	});
});

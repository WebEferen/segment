import { describe, expect, it } from 'vitest';
import { StrictMode, useCallback } from 'react';
import { useValue, type Get } from 'segment-state/react';
import { act, mount } from './_helpers.js';
import { makeAppStore, type AppStore } from './_fixtures/store.js';

function Selected({ app, runs }: { app: AppStore; runs: { n: number } }) {
	const select = useCallback(
		(get: Get) => {
			runs.n++;
			return `${get(app.s.ui.theme)}#${get(app.s.ui.count)}`;
		},
		[app, runs],
	);
	const [label] = useValue(app.store, select);
	return <span id="selected">{label}</span>;
}

describe('useValue with a selector', () => {
	it('computes from several addresses at once', () => {
		const app = makeAppStore();
		const view = mount(<Selected app={app} runs={{ n: 0 }} />);
		expect(view.find('#selected').textContent).toBe('light#0');

		act(() => app.store.set(app.s.ui.theme, 'dark'));
		expect(view.find('#selected').textContent).toBe('dark#0');
		act(() => app.s.bump(3));
		expect(view.find('#selected').textContent).toBe('dark#3');
		view.unmount();
	});

	it('does not re-run for a write it never read', () => {
		const app = makeAppStore();
		const runs = { n: 0 };
		const view = mount(<Selected app={app} runs={runs} />);
		const before = runs.n;

		// `users` is not in the selector's read set.
		act(() => app.store.set(app.s.users.at('u9').name, 'Ada'));
		expect(runs.n).toBe(before);

		act(() => app.store.set(app.s.ui.theme, 'dark'));
		expect(runs.n).toBeGreaterThan(before);
		view.unmount();
	});

	it('releases its derivation on unmount, so a list leaves nothing behind', () => {
		const app = makeAppStore();
		const baseline = app.store.stats().nodes;
		const views = [];
		for (let i = 0; i < 20; i++) views.push(mount(<Selected app={app} runs={{ n: 0 }} />));
		expect(app.store.stats().nodes).toBeGreaterThan(baseline);
		for (const view of views) view.unmount();
		expect(app.store.stats().nodes).toBe(baseline);
	});

	it('survives Strict Mode, whose mount cycle re-creates the derivation', () => {
		// Strict Mode subscribes, unsubscribes, and subscribes again. The first
		// cleanup releases the derivation, so the second subscribe must build a
		// fresh one rather than observing a released address.
		const app = makeAppStore();
		const baseline = app.store.stats().nodes;
		const view = mount(
			<StrictMode>
				<Selected app={app} runs={{ n: 0 }} />
			</StrictMode>,
		);
		expect(view.find('#selected').textContent).toBe('light#0');

		act(() => app.store.set(app.s.ui.theme, 'dark'));
		expect(view.find('#selected').textContent).toBe('dark#0');
		view.unmount();
		expect(app.store.stats().nodes).toBe(baseline);
	});
});

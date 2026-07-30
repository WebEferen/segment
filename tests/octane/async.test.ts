import { describe, expect, it } from 'vitest';
import { act, flushEffects, mount } from './_helpers.js';
import { makeAppStore } from './_fixtures/store.js';
import { DraftEditor, FailingAvatar, StatusReader, TwoAvatars } from './_fixtures/async.tsrx';

async function settled(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('useValue: fetched addresses', () => {
	it('suspends until the value arrives, then renders it', async () => {
		const app = makeAppStore();
		const view = mount(TwoAvatars, { app });
		expect(view.find('#pending')).toBeTruthy();

		app.settle('a', '/a.png');
		app.settle('b', '/b.png');
		await settled();
		act(() => {});

		expect(view.findAll('.avatar')).toHaveLength(2);
		expect(view.find('.avatar[data-id="a"]').getAttribute('src')).toBe('/a.png');
		view.unmount();
		flushEffects();
	});

	it('starts two independent resources TOGETHER, not as a waterfall', () => {
		// The claim that only holds on Octane: both loads are in flight before
		// either has settled, because the two waits batch into one stratum. React
		// running the same code issues them in sequence.
		//
		// The array form guarantees this without depending on what the compiler can
		// see through this package's hooks: it starts every load, THEN waits once.
		// Two separate calls cannot, because the first throws to suspend and the
		// second never runs.
		const app = makeAppStore();
		const view = mount(TwoAvatars, { app });
		expect(app.loadOrder).toEqual(['a', 'b']);
		view.unmount();
		flushEffects();
	});

	it('routes a failed load to the nearest boundary', async () => {
		const app = makeAppStore();
		const view = mount(FailingAvatar, { app });

		app.breakLoad('x', new Error('offline'));
		await settled();
		act(() => {});

		expect(view.find('#failed')).toBeTruthy();
		view.unmount();
		flushEffects();
	});
});

describe('useStatus', () => {
	it('reports the states without ever suspending', async () => {
		const app = makeAppStore();
		const view = mount(StatusReader, { app });
		// No fallback anywhere: the component drew the pending state itself.
		expect(view.find('#status').textContent).toBe('pending:-');

		app.settle('s1', '/s1.png');
		await settled();
		act(() => {});
		expect(view.find('#status').textContent).toBe('ready:/s1.png');
		view.unmount();
		flushEffects();
	});
});

describe('useDraft', () => {
	it('edits locally and publishes on demand', () => {
		const app = makeAppStore();
		const view = mount(DraftEditor, { app });
		const input = view.find('#draft') as HTMLInputElement;

		expect(input.value).toBe('anonymous');
		expect(view.find('#stored').textContent).toBe('anonymous');

		act(() => {
			input.value = 'Ada';
			input.dispatchEvent(new Event('input', { bubbles: true }));
		});
		// The draft moved; the store did not.
		expect(
			view.find('#draft').getAttribute('value') ?? (view.find('#draft') as HTMLInputElement).value,
		).toBe('Ada');
		expect(view.find('#stored').textContent).toBe('anonymous');

		act(() => view.click('#publish'));
		expect(view.find('#stored').textContent).toBe('Ada');
		view.unmount();
		flushEffects();
	});

	it('adopts a source that moved underneath an untouched draft', () => {
		const app = makeAppStore();
		const view = mount(DraftEditor, { app });
		act(() => app.store.act((tx) => tx.set(app.s.users.at('d1').name, 'Grace')));
		expect((view.find('#draft') as HTMLInputElement).value).toBe('Grace');
		expect(view.find('#stored').textContent).toBe('Grace');
		view.unmount();
		flushEffects();
	});
});

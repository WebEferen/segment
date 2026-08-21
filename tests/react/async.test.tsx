import { afterEach, describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { useDraft, useStatus, useValue } from 'segment-state/react';
import { act, ErrorBoundary, mount, mountSuspending, settled } from './_helpers.js';
import { makeAppStore, type AppStore } from './_fixtures/store.js';

function TwoAvatars({ app }: { app: AppStore }) {
	const [[a, b]] = useValue([app.s.users.at('a').avatar, app.s.users.at('b').avatar]);
	return (
		<>
			<img className="avatar" data-id="a" src={a} />
			<img className="avatar" data-id="b" src={b} />
		</>
	);
}

function FailingAvatar({ app }: { app: AppStore }) {
	const [src] = useValue(app.s.users.at('x').avatar);
	return <span id="ok">{src}</span>;
}

function StatusReader({ app }: { app: AppStore }) {
	const status = useStatus(app.s.users.at('s1').avatar);
	return (
		<span id="status">
			{status.status === 'ready' ? `ready:${status.value}` : `${status.status}:-`}
		</span>
	);
}

function DraftEditor({ app }: { app: AppStore }) {
	const [name, setName, publish] = useDraft(app.s.users.at('d1').name);
	const [stored] = useValue(app.s.users.at('d1').name);
	return (
		<>
			<input id="draft" value={name} onChange={(e) => setName(e.currentTarget.value)} />
			<span id="stored">{stored}</span>
			<button id="publish" onClick={publish} />
			<button
				id="editAndPublish"
				onClick={() => {
					setName('Zed');
					publish();
				}}
			/>
		</>
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('useValue: fetched addresses', () => {
	it('suspends until the values arrive, then renders them', async () => {
		const app = makeAppStore();
		const view = await mountSuspending(
			<Suspense fallback={<div id="pending" />}>
				<TwoAvatars app={app} />
			</Suspense>,
		);
		expect(view.find('#pending')).toBeTruthy();

		await act(async () => {
			app.settle('a', '/a.png');
			app.settle('b', '/b.png');
			await settled();
		});

		expect(view.findAll('.avatar')).toHaveLength(2);
		expect(view.find('.avatar[data-id="a"]').getAttribute('src')).toBe('/a.png');
		expect(view.find('.avatar[data-id="b"]').getAttribute('src')).toBe('/b.png');
		view.unmount();
	});

	it('starts two independent resources TOGETHER, not as a waterfall', async () => {
		// The array form starts every load, THEN waits. Two separate calls cannot,
		// because the first suspends by throwing and the second never runs.
		const app = makeAppStore();
		const view = await mountSuspending(
			<Suspense fallback={<div id="pending" />}>
				<TwoAvatars app={app} />
			</Suspense>,
		);
		expect(app.loadOrder).toEqual(['a', 'b']);
		view.unmount();
	});

	it('routes a failed load to the nearest boundary', async () => {
		// React reports every boundary-caught error through console.error; the
		// failure here is the point of the test, so keep the log readable.
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const app = makeAppStore();
		const view = await mountSuspending(
			<ErrorBoundary fallback={<div id="failed" />}>
				<Suspense fallback={<div id="pending" />}>
					<FailingAvatar app={app} />
				</Suspense>
			</ErrorBoundary>,
		);

		await act(async () => {
			app.breakLoad('x', new Error('offline'));
			await settled();
		});

		expect(view.find('#failed')).toBeTruthy();
		view.unmount();
	});
});

describe('useStatus', () => {
	it('reports the states without ever suspending', async () => {
		const app = makeAppStore();
		const view = mount(<StatusReader app={app} />);
		// No fallback anywhere: the component drew the pending state itself.
		expect(view.find('#status').textContent).toBe('pending:-');

		await act(async () => {
			app.settle('s1', '/s1.png');
			await settled();
		});
		expect(view.find('#status').textContent).toBe('ready:/s1.png');
		view.unmount();
	});
});

describe('useDraft', () => {
	it('edits locally and publishes on demand', () => {
		const app = makeAppStore();
		const view = mount(<DraftEditor app={app} />);
		const input = view.find('#draft') as HTMLInputElement;

		expect(input.value).toBe('anonymous');
		expect(view.find('#stored').textContent).toBe('anonymous');

		view.type('#draft', 'Ada');
		// The draft moved; the store did not.
		expect(input.value).toBe('Ada');
		expect(view.find('#stored').textContent).toBe('anonymous');

		view.click('#publish');
		expect(view.find('#stored').textContent).toBe('Ada');
		view.unmount();
	});

	it('adopts a source that moved underneath an untouched draft', () => {
		const app = makeAppStore();
		const view = mount(<DraftEditor app={app} />);
		act(() => app.store.act((tx) => tx.set(app.s.users.at('d1').name, 'Grace')));
		expect((view.find('#draft') as HTMLInputElement).value).toBe('Grace');
		expect(view.find('#stored').textContent).toBe('Grace');
		view.unmount();
	});

	it('publishes the draft set in the same event handler', () => {
		// The edit has not rendered yet when publish runs, so publish must read the
		// draft through the synchronously updated box, not through this render.
		const app = makeAppStore();
		const view = mount(<DraftEditor app={app} />);
		view.click('#editAndPublish');
		expect(view.find('#stored').textContent).toBe('Zed');
		expect((view.find('#draft') as HTMLInputElement).value).toBe('Zed');
		view.unmount();
	});
});

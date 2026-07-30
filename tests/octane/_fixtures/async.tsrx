import { useStatus, useDraft, useValue } from '@webeferen/segment/octane';
import { Suspense, ErrorBoundary } from 'octane';
import type { AppStore } from './store.js';

interface Props {
	app: AppStore;
}

function Avatar({ app, id }: { app: AppStore; id: string }) @{
	const [url] = useValue(app.s.users.at(id).avatar);
	<img class="avatar" data-id={id} src={url as string} />
}

/**
 * Two independent resources read from ONE body. This is the shape Octane's
 * parallel-`use()` contract covers: both waits are batched into a single
 * stratum, so both loads start before either has settled.
 */
function Pair({ app }: Props) @{
	const [[a, b]] = useValue([app.s.users.at('a').avatar, app.s.users.at('b').avatar]);
	<div id="avatars">
		<img class="avatar" data-id="a" src={a as string} />
		<img class="avatar" data-id="b" src={b as string} />
	</div>
}

export function TwoAvatars({ app }: Props) @{
	<Suspense fallback={<p id="pending">loading</p>}>
		<Pair app={app} />
	</Suspense>
}

export function FailingAvatar({ app }: Props) @{
	<ErrorBoundary fallback={<p id="failed">failed</p>}>
		<Suspense fallback={<p id="pending">loading</p>}>
			<Avatar app={app} id="x" />
		</Suspense>
	</ErrorBoundary>
}

/** `useStatus` never suspends, so the component draws the states itself. */
export function StatusReader({ app }: Props) @{
	const snap = useStatus(app.s.users.at('s1').avatar);
	<p id="status">{snap.status as string}:{(snap.value ?? '-') as string}</p>
}

export function DraftEditor({ app }: Props) @{
	const [name, setName, publish] = useDraft(app.s.users.at('d1').name);
	<div>
		<input
			id="draft"
			value={name as string}
			onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
		/>
		<p id="stored">{app.store.get(app.s.users.at('d1').name) as string}</p>
		<button id="publish" onClick={publish}>save</button>
	</div>
}

/** Fetch, then write back. The value moves optimistically and is restored on reject. */
export function ProfileEditor({ app }: Props) @{
	<Suspense fallback={<p id="loading">{'loading'}</p>}>
		<ProfileBody app={app} />
	</Suspense>
}

function ProfileBody({ app }: Props) @{
	const [avatar] = useValue(app.s.users.at('p1').avatar);
	const snap = useStatus(app.s.users.at('p1').avatar);
	<div>
		<p id="avatar">{avatar as string}</p>
		<p id="state">{snap.status as string}</p>
		<button
			id="save"
			onClick={() => void app.store.save(app.s.users.at('p1').avatar, '/next.png')}
		>{'save'}</button>
	</div>
}

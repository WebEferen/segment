import { Suspense } from 'octane';
import { useValue } from 'segment-state/octane';
import type { AppStore } from './store.js';

/**
 * `useValue` on a fetched address WAITS rather than refusing. Kept as a fixture
 * because "one hook reads everything" is the property: a regression here would throw
 * at a perfectly ordinary read, and needing to know the address KIND before reading
 * it is exactly what an earlier four-hook surface got wrong.
 */
function Body({ app }: { app: AppStore }) @{
	const [url] = useValue(app.s.users.at('u1').avatar);
	<p id="loaded">{url as string}</p>
}

export function ResourceThroughUseValue({ app }: { app: AppStore }) @{
	<Suspense fallback={<p id="waiting">{'waiting'}</p>}>
		<Body app={app} />
	</Suspense>
}
